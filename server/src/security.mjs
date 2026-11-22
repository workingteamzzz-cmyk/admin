// Security helpers: TOTP two-step verification, encryption of secrets at rest, IP allowlist, data retention.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.mjs';
import { run, now, getSettings, monthStart } from './db.mjs';

/* ---------- server secret (encrypts TOTP secrets at rest) ---------- */
let KEY;
function key() {
  if (KEY) return KEY;
  if (process.env.CANOPUS_SECRET_KEY) return (KEY = crypto.createHash('sha256').update(process.env.CANOPUS_SECRET_KEY).digest());
  const f = path.join(config.dataDir, 'secret.key');
  if (!fs.existsSync(f)) fs.writeFileSync(f, crypto.randomBytes(32).toString('base64'), { mode: 0o600 });
  return (KEY = Buffer.from(fs.readFileSync(f, 'utf8').trim(), 'base64'));
}
export function seal(text) { const iv = crypto.randomBytes(12); const c = crypto.createCipheriv('aes-256-gcm', key(), iv); const enc = Buffer.concat([c.update(text, 'utf8'), c.final()]); return [iv, c.getAuthTag(), enc].map(b => b.toString('base64')).join('.'); }
export function unseal(blob) { const [iv, tag, enc] = blob.split('.').map(x => Buffer.from(x, 'base64')); const d = crypto.createDecipheriv('aes-256-gcm', key(), iv); d.setAuthTag(tag); return Buffer.concat([d.update(enc), d.final()]).toString('utf8'); }

/* ---------- TOTP (RFC 6238: SHA-1, 30 s, 6 digits) ---------- */
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
export function base32(buf) { let bits = '', out = ''; for (const b of buf) bits += b.toString(2).padStart(8, '0'); for (let i = 0; i < bits.length; i += 5) out += B32[parseInt(bits.slice(i, i + 5).padEnd(5, '0'), 2)]; return out; }
function unbase32(s) { let bits = ''; for (const c of s.replace(/=+$/, '').toUpperCase()) { const v = B32.indexOf(c); if (v < 0) continue; bits += v.toString(2).padStart(5, '0'); } const out = []; for (let i = 0; i + 8 <= bits.length; i += 8) out.push(parseInt(bits.slice(i, i + 8), 2)); return Buffer.from(out); }
export function totpAt(secret, step) {
  const msg = Buffer.alloc(8); msg.writeBigUInt64BE(BigInt(step));
  const h = crypto.createHmac('sha1', unbase32(secret)).update(msg).digest(); const o = h[h.length - 1] & 15;
  return String(((h.readUInt32BE(o) & 0x7fffffff) % 1e6)).padStart(6, '0');
}
export const newTotpSecret = () => base32(crypto.randomBytes(20));
// Returns the matched time step, or null. Rejects codes at or before lastStep (no replay).
export function verifyTotp(secret, code, lastStep = 0) {
  const c = String(code || '').replace(/\s/g, ''); if (!/^\d{6}$/.test(c)) return null;
  const step = Math.floor(Date.now() / 30000);
  for (const s of [step, step - 1, step + 1]) if (s > lastStep && crypto.timingSafeEqual(Buffer.from(totpAt(secret, s)), Buffer.from(c))) return s;
  return null;
}
export function otpauthUrl(secret, email) { return `otpauth://totp/${encodeURIComponent('Canopus:' + email)}?secret=${secret}&issuer=Canopus&algorithm=SHA1&digits=6&period=30`; }
export async function qrSvg(text) { const qr = (await import('qrcode-generator')).default(0, 'M'); qr.addData(text); qr.make(); return qr.createSvgTag({ cellSize: 4, margin: 2, scalable: true }); }

/* ---------- short-lived sign-in tickets (between password and code) ---------- */
const tickets = new Map();
export function newTicket(data) { const t = crypto.randomBytes(24).toString('base64url'); tickets.set(t, { ...data, exp: now() + 5 * 60e3, tries: 0 }); return t; }
export function useTicket(t) { const x = tickets.get(String(t || '')); if (!x || x.exp < now() || x.tries >= 5) { tickets.delete(t); return null; } x.tries++; return x; }
export function dropTicket(t) { tickets.delete(t); }
export function twoFactorRequired(user) { const p = getSettings().security.require2fa; return p === 'all' || (p === 'admins' && user.role === 'admin'); }

/* ---------- IP allowlist ---------- */
function v4(ip) { const m = String(ip).replace(/^::ffff:/, '').match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/); return m ? ((+m[1] << 24) >>> 0) + (+m[2] << 16) + (+m[3] << 8) + +m[4] : null; }
const RULES = config.allowedIps.map(r => { const [net, bits] = r.split('/'); const n = v4(net); return n === null ? { exact: r.toLowerCase() } : { n, mask: bits === undefined ? 0xffffffff : bits === '0' ? 0 : (0xffffffff << (32 - +bits)) >>> 0 }; });
export function ipAllowed(ip) {
  if (!RULES.length) return true;
  const n = v4(ip);
  return RULES.some(r => (r.exact ? r.exact === String(ip).toLowerCase() : n !== null && ((n & r.mask) >>> 0) === ((r.n & r.mask) >>> 0)));
}

/* ---------- retention (runs hourly) ---------- */
export function purge() {
  const s = getSettings().security; const day = 864e5;
  if (s.maskingRetentionDays > 0) run(`DELETE FROM redactions WHERE created < ?`, now() - s.maskingRetentionDays * day);
  if (s.logRetentionDays > 0) { run(`DELETE FROM audit WHERE ts < ?`, now() - s.logRetentionDays * day); run(`DELETE FROM usage WHERE ts < ?`, Math.min(now() - s.logRetentionDays * day, monthStart(new Date(new Date().getFullYear(), new Date().getMonth() - 1, 1)))); } // usage is kept at least for this and last month, so budgets stay correct
  run(`DELETE FROM chat_requests WHERE ts < ?`, now() - 2 * day);
  run(`DELETE FROM sessions WHERE expires < ?`, now());
}
