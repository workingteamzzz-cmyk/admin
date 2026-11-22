import crypto from 'node:crypto';
import { promisify } from 'node:util';
import { db, one, run, id, now, sha256, audit } from './db.mjs';
import { config } from './config.mjs';

const scrypt = promisify(crypto.scrypt);
const SCRYPT = { N: 1 << 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

export async function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(pw, salt, 64, SCRYPT);
  return `scrypt$${salt.toString('base64')}$${key.toString('base64')}`;
}
export async function verifyPassword(pw, stored) {
  if (!stored) return false;
  const [, salt, key] = stored.split('$');
  const got = await scrypt(pw, Buffer.from(salt, 'base64'), 64, SCRYPT);
  const want = Buffer.from(key, 'base64');
  return got.length === want.length && crypto.timingSafeEqual(got, want);
}
export function passwordProblem(pw) {
  if (typeof pw !== 'string' || pw.length < 12) return 'Password must be at least 12 characters.';
  if (pw.length > 200) return 'Password is too long.';
  if (!/[a-zA-Z]/.test(pw) || !/[0-9]/.test(pw)) return 'Use both letters and numbers.';
  return null;
}

/* ---------- invites (also used for password resets) ---------- */
export function createInvite(userId, hours = 72) {
  const token = crypto.randomBytes(24).toString('base64url');
  run(`DELETE FROM invites WHERE user_id=?`, userId);
  run(`INSERT INTO invites(token_hash,user_id,expires) VALUES(?,?,?)`, sha256(token), userId, now() + hours * 3600e3);
  return `${config.publicUrl}/#invite=${token}`;
}
export function inviteUser(token) {
  const row = one(`SELECT i.user_id, i.expires, u.email, u.name, u.disabled FROM invites i JOIN users u ON u.id=i.user_id WHERE i.token_hash=?`, sha256(String(token || '')));
  if (!row || row.expires < now() || row.disabled) return null;
  return row;
}
export function consumeInvite(token) { run(`DELETE FROM invites WHERE token_hash=?`, sha256(String(token))); }

/* ---------- sessions ---------- */
export function createSession(res, user, req) {
  const sid = crypto.randomBytes(32).toString('base64url');
  run(`INSERT INTO sessions(id_hash,user_id,expires,created,ip,ua,last_seen) VALUES(?,?,?,?,?,?,?)`, sha256(sid), user.id, now() + config.sessionHours * 3600e3, now(), clientIp(req), String(req.headers['user-agent'] || '').slice(0, 200), now());
  run(`UPDATE users SET last_login=? WHERE id=?`, now(), user.id);
  setCookie(res, sid, config.sessionHours * 3600);
}
export function destroySession(req, res) {
  const sid = readCookie(req);
  if (sid) run(`DELETE FROM sessions WHERE id_hash=?`, sha256(sid));
  setCookie(res, '', 0);
}
export function sessionUser(req) {
  const sid = readCookie(req); if (!sid) return null;
  const row = one(`SELECT u.*, s.expires, s.last_seen FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.id_hash=?`, sha256(sid));
  if (!row || row.disabled) return null;
  // Absolute lifetime (SESSION_HOURS) and an inactivity timeout (SESSION_IDLE_MINUTES).
  if (row.expires < now() || (config.idleMinutes > 0 && now() - (row.last_seen || 0) > config.idleMinutes * 60e3)) { run(`DELETE FROM sessions WHERE id_hash=?`, sha256(sid)); return null; }
  if (now() - (row.last_seen || 0) > 30e3) run(`UPDATE sessions SET last_seen=? WHERE id_hash=?`, now(), sha256(sid));
  return row;
}
const COOKIE = config.cookieSecure ? '__Host-canopus' : 'canopus_sid';
function setCookie(res, value, maxAge) {
  res.setHeader('set-cookie', `${COOKIE}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${config.cookieSecure ? '; Secure' : ''}`);
}
function readCookie(req) {
  const m = String(req.headers.cookie || '').match(new RegExp(`(?:^|;\\s*)${COOKIE}=([^;]+)`));
  return m ? m[1] : null;
}
export function clientIp(req) {
  if (config.trustProxy && req.headers['x-forwarded-for']) return String(req.headers['x-forwarded-for']).split(',')[0].trim();
  return req.socket.remoteAddress;
}

/* ---------- login throttling ---------- */
const attempts = new Map(); // key -> {n, until}
export function loginBlocked(key) { const a = attempts.get(key); return a && a.until > now() ? Math.ceil((a.until - now()) / 60000) : 0; }
export function loginFailed(key) {
  const a = attempts.get(key) || { n: 0, until: 0 }; a.n++;
  if (a.n >= 5) { a.until = now() + 15 * 60e3; a.n = 0; }
  attempts.set(key, a);
}
export function loginOk(key) { attempts.delete(key); }

/* ---------- users ---------- */
// Roles: admin (everything), ultimate (senior: uploads shared knowledge and URS reports), editor (reviews analysts' work
// and files finals), user (analyst).
export const normalizeRole = r => (['admin', 'ultimate', 'editor'].includes(r) ? r : 'user');
export function createUser({ email, name = '', role = 'user', budget_usd = null }) {
  email = String(email || '').trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw Object.assign(new Error('Invalid email address'), { status: 400 });
  if (one(`SELECT 1 FROM users WHERE email=?`, email)) throw Object.assign(new Error('A user with this email already exists'), { status: 409 });
  const uid = id();
  run(`INSERT INTO users(id,email,name,role,created,budget_usd) VALUES(?,?,?,?,?,?)`, uid, email, String(name).slice(0, 80), normalizeRole(role), now(), budget_usd);
  return one(`SELECT * FROM users WHERE id=?`, uid);
}
export function publicUser(u) { return { id: u.id, email: u.email, name: u.name, role: u.role }; }
export { audit };
