import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { config, ROOT, MODELS, CLASSIFICATIONS, CATEGORIES, TIERS } from './config.mjs';
import { db, one, all, run, id, now, tx, sha256, getSettings, saveSettings, audit, userGroups, groupSpent, allowedCollections, spentThisMonth, budgetFor, monthStart, projectsFor, ensureSpaces, canUpload } from './db.mjs';
import { hashPassword, verifyPassword, passwordProblem, createInvite, inviteUser, consumeInvite, createSession, destroySession, sessionUser, clientIp, loginBlocked, loginFailed, loginOk, createUser, publicUser } from './auth.mjs';
import { ingestDoc, deleteDoc, deleteCollection, classificationProblem, search } from './knowledge.mjs';
import { converse, quick, modelsFor, allModels, providerReady, listOpenAIModels } from './ai.mjs';
import { emit as emitWebhook } from './webhooks.mjs';
import * as R from './reports.mjs';
import { ANALYST_FIELDS, CLIENT_FIELDS, parsePersona } from './persona.mjs';
import { bootstrapAdmin } from './cli.mjs';
import { newTicket, useTicket, dropTicket, twoFactorRequired, newTotpSecret, verifyTotp, otpauthUrl, qrSvg, seal, unseal, ipAllowed, purge } from './security.mjs';

const PUBLIC = path.join(ROOT, 'public');
const MB = 1024 * 1024;

/* ---------- security headers ---------- */
const APP_CSP = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data: blob: https://www.google.com https://*.gstatic.com; frame-src 'self' blob:; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'";
// Canvases (AI-generated HTML) run here, in a sandboxed frame with no network access except fonts/libraries.
const SANDBOX_CSP = "default-src 'none'; script-src 'unsafe-inline' https://cdn.jsdelivr.net; style-src 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com data:; img-src data: blob:; media-src data: blob:; connect-src 'none'; form-action 'none'; base-uri 'none'";
function baseHeaders(res) {
  res.setHeader('x-content-type-options', 'nosniff');
  res.setHeader('referrer-policy', 'no-referrer');
  res.setHeader('permissions-policy', 'camera=(), geolocation=(), microphone=(self), display-capture=(self)');
  res.setHeader('cross-origin-opener-policy', 'same-origin');
  if (config.cookieSecure) res.setHeader('strict-transport-security', 'max-age=31536000; includeSubDomains');
}

/* ---------- helpers ---------- */
class HttpError extends Error { constructor(status, msg) { super(msg); this.status = status; } }
const json = (res, status, obj) => { res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); res.end(JSON.stringify(obj)); };
async function readBody(req, limit) {
  const chunks = []; let size = 0;
  for await (const c of req) { size += c.length; if (size > limit) throw new HttpError(413, `Too large (max ${Math.round(limit / MB)} MB)`); chunks.push(c); }
  return Buffer.concat(chunks);
}
async function readJson(req, limit = 2 * MB) { const b = await readBody(req, limit); try { return b.length ? JSON.parse(b) : {}; } catch { throw new HttpError(400, 'Invalid JSON'); } }
const fileName = req => decodeURIComponent(String(req.headers['x-filename'] || 'file')).replace(/[\\/\0]/g, '_').slice(0, 200);
const requireAdmin = u => { if (u.role !== 'admin') throw new HttpError(403, 'Administrators only'); };
const clampBudget = v => (v === null || v === '' || v === undefined ? null : Math.max(0, Math.min(10000, +v || 0)));
function setGroups(table, col, ownerId, groupIds) {
  run(`DELETE FROM ${table} WHERE ${col}=?`, ownerId);
  for (const g of [...new Set(groupIds || [])]) if (one(`SELECT 1 FROM groups WHERE id=?`, g)) run(`INSERT INTO ${table}(${col},group_id) VALUES(?,?)`, ownerId, g);
}
function knowledgeFor(user) {
  ensureSpaces(user);
  return allowedCollections(user).map(c => ({ ...c, mine: c.owner_id === user.id, canUpload: canUpload(user, c), ownerName: c.owner_id ? (one(`SELECT name,email FROM users WHERE id=?`, c.owner_id) || {}).name || '' : '',
    clientId: c.kind === 'client' ? one(`SELECT id FROM clients WHERE collection_id=?`, c.id)?.id || null : null, groups: all(`SELECT g.id,g.name FROM groups g JOIN collection_groups cg ON cg.group_id=g.id WHERE cg.collection_id=?`, c.id),
    docs: all(`SELECT d.id,d.title,d.filename,d.size,d.classification,d.status,d.error,d.chunks,d.pages,d.sensitive,d.created,d.uploaded_by,COALESCE(NULLIF(u.name,''),u.email) uploader FROM docs d LEFT JOIN users u ON u.id=d.uploaded_by WHERE d.collection_id=? ORDER BY d.created DESC`, c.id) }));
}
function mePayload(u) {
  const s = getSettings(); const ms = modelsFor(u, s);
  const groups = userGroups(u.id);
  return { personaFields: { analyst: ANALYST_FIELDS, client: CLIENT_FIELDS }, user: { ...publicUser(u), twoFactor: !!u.totp_secret, persona: parsePersona(u.persona, ANALYST_FIELDS) }, groups: groups.map(g => ({ id: g.id, name: g.name })),
    config: { models: ms.map(m => ({ id: m.id, label: m.label, d: m.d, provider: m.provider, tier: m.tier, vision: m.vision })), auto: ms.length > 1, defaultModel: s.defaultModel === 'auto' && ms.length > 1 ? 'auto' : (ms.find(m => m.id === s.defaultModel) || ms[0])?.id,
      webSearch: s.webSearch && ms.some(m => m.provider === 'anthropic'), canvas: !!s.canvas, imageUploads: s.imageUploads, redaction: s.redaction.enabled, maxUploadMb: config.maxUploadMb, classifications: CLASSIFICATIONS, categories: CATEGORIES, apiConfigured: ms.length > 0, rateLimits: s.rateLimits },
    budget: { limit: budgetFor(u), spent: +spentThisMonth(u.id).toFixed(4), groups: groups.filter(g => g.budget_usd > 0).map(g => ({ name: g.name, limit: g.budget_usd, spent: +groupSpent(g.id).toFixed(4) })) },
    projects: projectsFor(u).map(p => ({ id: p.id, name: p.name, description: p.description, model: p.model, collections: p.collections.length })),
    orgSkills: s.orgSkills.filter(k => k.enabled !== false).map(({ id, name, description }) => ({ id, name, description })),
    orgPrompts: s.orgPrompts };
}
function blobKind(name, mime) {
  if (/^image\/(png|jpeg|gif|webp)$/.test(mime)) return 'image';
  if (mime === 'application/pdf' || /\.pdf$/i.test(name)) return 'pdf';
  if (/\.docx$/i.test(name)) return 'docx';
  if (/^text\//.test(mime) || /\.(txt|md|markdown|csv|tsv|json|html?|xml|ya?ml|log)$/i.test(name)) return 'text';
  return null;
}

/* ---------- routes ---------- */
const routes = [];
const route = (method, pattern, handler, opts = {}) => routes.push({ method, re: new RegExp('^' + pattern.replace(/:(\w+)/g, '(?<$1>[^/]+)') + '$'), handler, ...opts });

route('GET', '/api/health', (req, res) => json(res, 200, { ok: true, anthropic: providerReady('anthropic'), openai: providerReady('openai'), local: providerReady('local') }), { public: true });

route('POST', '/api/auth/login', async (req, res) => {
  const { email, password } = await readJson(req, 10e3);
  const key = `${clientIp(req)}|${String(email).toLowerCase()}`;
  const wait = loginBlocked(key); if (wait) throw new HttpError(429, `Too many attempts. Try again in ${wait} minute${wait > 1 ? 's' : ''}.`);
  const u = one(`SELECT * FROM users WHERE email=?`, String(email || '').trim().toLowerCase());
  const ok = u && !u.disabled && await verifyPassword(String(password || ''), u.pw_hash);
  if (!ok) { loginFailed(key); audit(u?.id || null, 'auth.login_failed', { email: String(email).slice(0, 100) }, clientIp(req)); throw new HttpError(401, 'Wrong email or password.'); }
  loginOk(key);
  const second = await secondStep(u);
  if (second) { audit(u.id, 'auth.password_ok', { next: second.step }, clientIp(req)); return json(res, 200, second); }
  createSession(res, u, req); audit(u.id, 'auth.login', {}, clientIp(req));
  json(res, 200, mePayload(u));
}, { public: true });
// After a correct password: ask for the authenticator code, or set up the authenticator first.
async function secondStep(u) {
  if (u.totp_secret) return { step: 'totp', ticket: newTicket({ userId: u.id, purpose: 'totp' }) };
  if (!twoFactorRequired(u)) return null;
  const secret = newTotpSecret(); const url = otpauthUrl(secret, u.email);
  return { step: 'enroll', ticket: newTicket({ userId: u.id, purpose: 'enroll', secret }), secret, otpauth: url, qr: await qrSvg(url) };
}
route('POST', '/api/auth/totp', async (req, res) => {
  const { ticket, code } = await readJson(req, 5e3); const t = useTicket(ticket);
  if (!t || t.purpose !== 'totp') throw new HttpError(401, 'Your sign-in expired. Start again with your password.');
  const u = one(`SELECT * FROM users WHERE id=?`, t.userId); if (!u || u.disabled || !u.totp_secret) throw new HttpError(401, 'Sign-in not possible.');
  const step = verifyTotp(unseal(u.totp_secret), code, u.totp_last);
  if (!step) { audit(u.id, 'auth.totp_failed', {}, clientIp(req)); throw new HttpError(401, 'Wrong or expired code. Use the current 6-digit code from your authenticator app.'); }
  dropTicket(ticket); run(`UPDATE users SET totp_last=? WHERE id=?`, step, u.id);
  createSession(res, u, req); audit(u.id, 'auth.login', { twoFactor: true }, clientIp(req)); json(res, 200, mePayload(u));
}, { public: true });
route('POST', '/api/auth/enroll', async (req, res) => {
  const { ticket, code } = await readJson(req, 5e3); const t = useTicket(ticket);
  if (!t || t.purpose !== 'enroll') throw new HttpError(401, 'Your sign-in expired. Start again with your password.');
  const step = verifyTotp(t.secret, code, 0); if (!step) throw new HttpError(400, 'That code did not match. Make sure the time on your phone is correct and enter the current code.');
  const u = one(`SELECT * FROM users WHERE id=?`, t.userId); if (!u || u.disabled) throw new HttpError(401, 'Sign-in not possible.');
  dropTicket(ticket); run(`UPDATE users SET totp_secret=?, totp_last=? WHERE id=?`, seal(t.secret), step, u.id);
  createSession(res, u, req); audit(u.id, 'auth.totp_enrolled', {}, clientIp(req)); json(res, 200, mePayload(u));
}, { public: true });
route('POST', '/api/auth/logout', (req, res, u) => { destroySession(req, res); audit(u.id, 'auth.logout', {}, clientIp(req)); json(res, 200, { ok: true }); });
route('GET', '/api/auth/invite', (req, res) => {
  const inv = inviteUser(new URL(req.url, 'http://x').searchParams.get('token'));
  if (!inv) throw new HttpError(404, 'This link is invalid or has expired. Ask your administrator for a new one.');
  json(res, 200, { email: inv.email, name: inv.name });
}, { public: true });
route('POST', '/api/auth/accept', async (req, res) => {
  const { token, name, password } = await readJson(req, 10e3);
  const inv = inviteUser(token); if (!inv) throw new HttpError(404, 'This link is invalid or has expired.');
  const p = passwordProblem(password); if (p) throw new HttpError(400, p);
  const pw = await hashPassword(password);
  tx(() => { run(`UPDATE users SET pw_hash=?, totp_secret=NULL, totp_last=0, name=COALESCE(NULLIF(?,''),name) WHERE id=?`, pw, String(name || '').trim().slice(0, 80), inv.user_id); run(`DELETE FROM sessions WHERE user_id=?`, inv.user_id); });
  consumeInvite(token);
  const u = one(`SELECT * FROM users WHERE id=?`, inv.user_id); audit(u.id, 'auth.password_set', {}, clientIp(req));
  const second = await secondStep(u); if (second) return json(res, 200, second);
  createSession(res, u, req); json(res, 200, mePayload(u));
}, { public: true });

route('GET', '/api/me', (req, res, u) => json(res, 200, mePayload(u)));
route('PUT', '/api/me/persona', async (req, res, u) => { const { persona } = await readJson(req, 30e3); run(`UPDATE users SET persona=? WHERE id=?`, JSON.stringify(parsePersona(persona || {}, ANALYST_FIELDS)), u.id); audit(u.id, 'persona.updated', { self: true }, clientIp(req)); json(res, 200, mePayload(one(`SELECT * FROM users WHERE id=?`, u.id))); });
route('PATCH', '/api/me', async (req, res, u) => { const { name } = await readJson(req, 10e3); run(`UPDATE users SET name=? WHERE id=?`, String(name || '').trim().slice(0, 80), u.id); json(res, 200, mePayload(one(`SELECT * FROM users WHERE id=?`, u.id))); });
route('POST', '/api/me/password', async (req, res, u) => {
  const { current, next } = await readJson(req, 10e3);
  if (!await verifyPassword(String(current || ''), u.pw_hash)) throw new HttpError(400, 'Current password is wrong.');
  const p = passwordProblem(next); if (p) throw new HttpError(400, p);
  run(`UPDATE users SET pw_hash=? WHERE id=?`, await hashPassword(next), u.id);
  run(`DELETE FROM sessions WHERE user_id=?`, u.id); createSession(res, u, req);
  audit(u.id, 'auth.password_changed', {}, clientIp(req)); json(res, 200, { ok: true });
});
route('GET', '/api/me/state', (req, res, u) => { const r = one(`SELECT json FROM user_state WHERE user_id=?`, u.id); res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(r ? r.json : 'null'); });
route('PUT', '/api/me/state', async (req, res, u) => {
  const body = await readBody(req, 40 * MB); try { JSON.parse(body); } catch { throw new HttpError(400, 'Invalid JSON'); }
  run(`INSERT INTO user_state(user_id,json,updated) VALUES(?,?,?) ON CONFLICT(user_id) DO UPDATE SET json=excluded.json, updated=excluded.updated`, u.id, body.toString('utf8'), now());
  json(res, 200, { ok: true });
});

route('POST', '/api/blobs', async (req, res, u) => {
  const name = fileName(req); const mime = String(req.headers['content-type'] || 'application/octet-stream').split(';')[0];
  const kind = blobKind(name, mime);
  if (!kind) throw new HttpError(415, 'Canopus can read images, PDF, DOCX and text files. Export other formats as PDF or CSV.');
  if (kind === 'image' && !getSettings().imageUploads) throw new HttpError(403, 'Image uploads are disabled by the administrator.');
  const buf = await readBody(req, config.maxUploadMb * MB);
  const bid = id(); const dir = path.join(config.dataDir, 'blobs', u.id); fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(dir, bid), buf, { mode: 0o600 });
  run(`INSERT INTO blobs(id,user_id,name,mime,size,kind,created) VALUES(?,?,?,?,?,?,?)`, bid, u.id, name, mime, buf.length, kind, now());
  json(res, 200, { id: bid, name, mime, size: buf.length, kind });
});
route('GET', '/api/blobs/:id', (req, res, u, p) => {
  const b = one(`SELECT * FROM blobs WHERE id=? AND user_id=?`, p.id, u.id); if (!b) throw new HttpError(404, 'Not found');
  const inline = b.kind === 'image' || b.kind === 'pdf';
  res.writeHead(200, { 'content-type': inline ? b.mime : 'text/plain; charset=utf-8', 'content-security-policy': 'sandbox', 'cache-control': 'private, max-age=3600', 'content-disposition': `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(b.name)}` });
  fs.createReadStream(path.join(config.dataDir, 'blobs', u.id, b.id)).pipe(res);
});
route('DELETE', '/api/blobs/:id', (req, res, u, p) => {
  const b = one(`SELECT * FROM blobs WHERE id=? AND user_id=?`, p.id, u.id); if (!b) throw new HttpError(404, 'Not found');
  fs.rmSync(path.join(config.dataDir, 'blobs', u.id, b.id), { force: true }); run(`DELETE FROM blobs WHERE id=?`, b.id); json(res, 200, { ok: true });
});

route('POST', '/api/chat', async (req, res, u) => {
  const body = await readJson(req, 8 * MB);
  res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache, no-transform', 'x-accel-buffering': 'no' });
  const ac = new AbortController(); res.on('close', () => { if (!res.writableFinished) ac.abort(); });
  await converse(u, body, ev => { if (!res.writableEnded) res.write(`data: ${JSON.stringify(ev)}\n\n`); }, ac.signal, clientIp(req));
  res.end();
});
route('POST', '/api/quick', async (req, res, u) => {
  const { purpose, text, chatId } = await readJson(req, 100e3);
  if (!['title', 'enhance'].includes(purpose)) throw new HttpError(400, 'Unknown purpose');
  try { json(res, 200, { text: await quick(u, purpose, text, chatId) }); } catch (e) { throw new HttpError(e.status || 502, e.message); }
});

route('GET', '/api/knowledge', (req, res, u) => json(res, 200, knowledgeFor(u)));
// Everyone can add to the team space, to client spaces and to their own space (admins also to organization collections).
route('POST', '/api/knowledge/collections/:id/docs', async (req, res, u, p) => {
  const c = allowedCollections(u).find(x => x.id === p.id); if (!c) throw new HttpError(404, 'Collection not found');
  if (!canUpload(u, c)) throw new HttpError(403, c.kind === 'person' ? 'You can only add documents to your own space.' : 'Only administrators can add documents to this collection.');
  const classification = String(req.headers['x-classification'] || 'biasa'); const problem = classificationProblem(classification);
  if (problem) { req.resume(); audit(u.id, 'knowledge.upload_refused', { file: fileName(req), classification, collection: c.id }, clientIp(req)); emitWebhook('knowledge.upload_refused', { file: fileName(req), classification, by: u.email }); throw new HttpError(422, problem); }
  const buf = await readBody(req, config.maxUploadMb * MB);
  const doc = await ingestDoc({ collectionId: c.id, filename: fileName(req), mime: String(req.headers['content-type'] || '').split(';')[0], buf, classification, title: req.headers['x-title'] ? decodeURIComponent(req.headers['x-title']) : null, userId: u.id });
  audit(u.id, 'knowledge.upload', { doc: doc.id, title: doc.title, classification, status: doc.status, collection: c.id, kind: c.kind }, clientIp(req)); json(res, 200, doc);
});
// Remove a document: the person who uploaded it, the owner of a personal space, or an administrator.
route('DELETE', '/api/knowledge/docs/:id', (req, res, u, p) => {
  const d = one(`SELECT d.*, c.kind, c.owner_id FROM docs d JOIN collections c ON c.id=d.collection_id WHERE d.id=?`, p.id);
  if (!d || !allowedCollections(u).some(c => c.id === d.collection_id)) throw new HttpError(404, 'Not found');
  if (u.role !== 'admin' && d.uploaded_by !== u.id && d.owner_id !== u.id) throw new HttpError(403, 'Only the person who added this document (or an administrator) can remove it.');
  deleteDoc(p.id); audit(u.id, 'knowledge.doc_deleted', { doc: p.id, title: d.title }, clientIp(req)); json(res, 200, { ok: true });
});
// Your own space is readable by everyone by default; make it private to keep it to yourself.
route('PATCH', '/api/knowledge/mine', async (req, res, u) => {
  const { private: priv } = await readJson(req, 2e3); ensureSpaces(u);
  run(`UPDATE collections SET private=?, name=? WHERE kind='person' AND owner_id=?`, priv ? 1 : 0, u.name || u.email, u.id); audit(u.id, 'knowledge.space_visibility', { private: !!priv }, clientIp(req)); json(res, 200, { ok: true });
});
// Direct document search: no AI involved, nothing leaves the server, no cost.
route('POST', '/api/knowledge/search', async (req, res, u) => {
  const { query, collection } = await readJson(req, 10e3); const q = String(query || '').trim().slice(0, 300); if (!q) throw new HttpError(400, 'Type something to search for');
  const hits = search(u, q, { limit: 20, includeLocalOnly: true, collections: collection ? [String(collection)] : null });
  audit(u.id, 'knowledge.direct_search', { query: q.slice(0, 100), results: hits.length }, clientIp(req));
  json(res, 200, hits.map(h => ({ title: h.title, page: h.page, collection: h.collection, docId: h.docId, text: h.text, localOnly: h.localOnly })));
});
route('GET', '/api/knowledge/docs/:id/file', (req, res, u, p) => {
  const d = one(`SELECT * FROM docs WHERE id=?`, p.id);
  if (!d || !allowedCollections(u).some(c => c.id === d.collection_id)) throw new HttpError(404, 'Not found');
  audit(u.id, 'knowledge.open', { doc: d.id }, clientIp(req));
  const inline = d.mime === 'application/pdf';
  res.writeHead(200, { 'content-type': inline ? 'application/pdf' : 'application/octet-stream', 'content-security-policy': 'sandbox', 'content-disposition': `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(d.filename)}`, 'cache-control': 'private, no-store' });
  fs.createReadStream(path.join(config.dataDir, 'docs', d.id)).pipe(res);
});

/* ---------- admin ---------- */
route('GET', '/api/admin/overview', (req, res, u) => {
  requireAdmin(u);
  const users = all(`SELECT id,email,name,role,disabled,budget_usd,created,last_login,persona, (pw_hash IS NOT NULL) active, (totp_secret IS NOT NULL) twofa FROM users ORDER BY created`).map(x => ({ ...x, persona: parsePersona(x.persona, ANALYST_FIELDS), groups: userGroups(x.id).map(g => g.id), spent: +spentThisMonth(x.id).toFixed(4), budget: budgetFor(x) }));
  const s = getSettings(); const webhook = { ...s.webhook, secret: s.webhook.secret ? s.webhook.secret.slice(0, 6) + '…' : '' };
  const groups = all(`SELECT g.*, (SELECT COUNT(*) FROM user_groups ug WHERE ug.group_id=g.id) members FROM groups g ORDER BY name`).map(g => ({ ...g, models: g.models ? JSON.parse(g.models) : null, spent: +groupSpent(g.id).toFixed(4) }));
  const tokens = all(`SELECT t.id, t.name, t.prefix, t.scopes, t.created, t.last_used, t.revoked, u2.email FROM api_tokens t JOIN users u2 ON u2.id=t.user_id ORDER BY t.created DESC`).map(t => ({ ...t, scopes: JSON.parse(t.scopes) }));
  json(res, 200, { users, groups, projects: projectsFor(u), collections: knowledgeFor(u), settings: { ...s, webhook }, classifications: CLASSIFICATIONS, categories: CATEGORIES, tiers: TIERS, models: allModels(s), providers: { anthropic: providerReady('anthropic'), openai: providerReady('openai'), local: providerReady('local') }, tokens, apiConfigured: ['anthropic', 'openai', 'local'].some(providerReady) });
});
route('POST', '/api/admin/users', async (req, res, u) => {
  requireAdmin(u); const b = await readJson(req, 20e3);
  const nu = createUser({ email: b.email, name: b.name, role: b.role, budget_usd: clampBudget(b.budget_usd) });
  setGroups('user_groups', 'user_id', nu.id, b.groups);
  const link = createInvite(nu.id); audit(u.id, 'admin.user_created', { user: nu.email, role: nu.role }, clientIp(req)); emitWebhook('user.created', { user: nu.email, role: nu.role, by: u.email });
  json(res, 200, { id: nu.id, invite: link });
});
route('PATCH', '/api/admin/users/:id', async (req, res, u, p) => {
  requireAdmin(u); const b = await readJson(req, 20e3);
  const t = one(`SELECT * FROM users WHERE id=?`, p.id); if (!t) throw new HttpError(404, 'User not found');
  const admins = one(`SELECT COUNT(*) c FROM users WHERE role='admin' AND disabled=0`).c;
  if (t.role === 'admin' && admins <= 1 && ((b.role && b.role !== 'admin') || b.disabled)) throw new HttpError(400, 'Keep at least one active administrator.');
  tx(() => {
    if (b.name !== undefined) run(`UPDATE users SET name=? WHERE id=?`, String(b.name).slice(0, 80), t.id);
    if (b.role) run(`UPDATE users SET role=? WHERE id=?`, b.role === 'admin' ? 'admin' : 'user', t.id);
    if (b.budget_usd !== undefined) run(`UPDATE users SET budget_usd=? WHERE id=?`, clampBudget(b.budget_usd), t.id);
    if (b.disabled !== undefined) { run(`UPDATE users SET disabled=? WHERE id=?`, b.disabled ? 1 : 0, t.id); if (b.disabled) run(`DELETE FROM sessions WHERE user_id=?`, t.id); }
    if (Array.isArray(b.groups)) setGroups('user_groups', 'user_id', t.id, b.groups);
    if (b.persona !== undefined) run(`UPDATE users SET persona=? WHERE id=?`, JSON.stringify(parsePersona(b.persona || {}, ANALYST_FIELDS)), t.id);
  });
  audit(u.id, 'admin.user_updated', { user: t.email, changes: Object.keys(b) }, clientIp(req)); json(res, 200, { ok: true });
});
route('POST', '/api/admin/users/:id/reset2fa', (req, res, u, p) => {
  requireAdmin(u); const t = one(`SELECT * FROM users WHERE id=?`, p.id); if (!t) throw new HttpError(404, 'User not found');
  run(`UPDATE users SET totp_secret=NULL, totp_last=0 WHERE id=?`, t.id); run(`DELETE FROM sessions WHERE user_id=?`, t.id);
  audit(u.id, 'admin.user_2fa_reset', { user: t.email }, clientIp(req)); json(res, 200, { ok: true });
});
route('POST', '/api/admin/users/:id/reset', (req, res, u, p) => {
  requireAdmin(u); const t = one(`SELECT * FROM users WHERE id=?`, p.id); if (!t) throw new HttpError(404, 'User not found');
  run(`DELETE FROM sessions WHERE user_id=?`, t.id);
  const link = createInvite(t.id); audit(u.id, 'admin.user_reset', { user: t.email }, clientIp(req)); json(res, 200, { invite: link });
});
route('POST', '/api/admin/groups', async (req, res, u) => {
  requireAdmin(u); const { name } = await readJson(req, 10e3); const n = String(name || '').trim().slice(0, 60);
  if (!n) throw new HttpError(400, 'Name required'); if (one(`SELECT 1 FROM groups WHERE name=?`, n)) throw new HttpError(409, 'A group with this name exists');
  const gid = id(); run(`INSERT INTO groups(id,name) VALUES(?,?)`, gid, n); audit(u.id, 'admin.group_created', { name: n }, clientIp(req)); json(res, 200, { id: gid });
});
route('PATCH', '/api/admin/groups/:id', async (req, res, u, p) => {
  requireAdmin(u); const b = await readJson(req, 20e3); if (!one(`SELECT 1 FROM groups WHERE id=?`, p.id)) throw new HttpError(404, 'Group not found');
  if (b.name !== undefined) run(`UPDATE groups SET name=? WHERE id=?`, String(b.name).trim().slice(0, 60) || 'Group', p.id);
  if (b.budget_usd !== undefined) run(`UPDATE groups SET budget_usd=? WHERE id=?`, clampBudget(b.budget_usd), p.id);
  if (b.models !== undefined) run(`UPDATE groups SET models=? WHERE id=?`, Array.isArray(b.models) ? JSON.stringify(b.models.map(String).slice(0, 50)) : null, p.id);
  audit(u.id, 'admin.group_updated', { id: p.id, changes: Object.keys(b) }, clientIp(req)); json(res, 200, { ok: true });
});
route('DELETE', '/api/admin/groups/:id', (req, res, u, p) => { requireAdmin(u); run(`DELETE FROM groups WHERE id=?`, p.id); audit(u.id, 'admin.group_deleted', { id: p.id }, clientIp(req)); json(res, 200, { ok: true }); });
route('POST', '/api/admin/collections', async (req, res, u) => {
  requireAdmin(u); const b = await readJson(req, 20e3); const n = String(b.name || '').trim().slice(0, 80); if (!n) throw new HttpError(400, 'Name required');
  const cid = id(); run(`INSERT INTO collections(id,name,description,created,local_only) VALUES(?,?,?,?,?)`, cid, n, String(b.description || '').slice(0, 300), now(), b.local_only ? 1 : 0);
  setGroups('collection_groups', 'collection_id', cid, b.groups); audit(u.id, 'admin.collection_created', { name: n, groups: b.groups || [] }, clientIp(req)); json(res, 200, { id: cid });
});
route('PATCH', '/api/admin/collections/:id', async (req, res, u, p) => {
  requireAdmin(u); const b = await readJson(req, 20e3); if (!one(`SELECT 1 FROM collections WHERE id=?`, p.id)) throw new HttpError(404, 'Not found');
  if (b.name !== undefined) run(`UPDATE collections SET name=? WHERE id=?`, String(b.name).trim().slice(0, 80) || 'Untitled', p.id);
  if (b.description !== undefined) run(`UPDATE collections SET description=? WHERE id=?`, String(b.description).slice(0, 300), p.id);
  if (b.local_only !== undefined) run(`UPDATE collections SET local_only=? WHERE id=?`, b.local_only ? 1 : 0, p.id);
  if (Array.isArray(b.groups)) setGroups('collection_groups', 'collection_id', p.id, b.groups);
  audit(u.id, 'admin.collection_updated', { id: p.id, changes: Object.keys(b) }, clientIp(req)); json(res, 200, { ok: true });
});
route('DELETE', '/api/admin/collections/:id', (req, res, u, p) => { requireAdmin(u); deleteCollection(p.id); audit(u.id, 'admin.collection_deleted', { id: p.id }, clientIp(req)); json(res, 200, { ok: true }); });
route('POST', '/api/admin/collections/:id/docs', async (req, res, u, p) => {
  requireAdmin(u);
  const classification = String(req.headers['x-classification'] || '');
  const problem = classificationProblem(classification);
  if (problem) { req.resume(); audit(u.id, 'knowledge.upload_refused', { file: fileName(req), classification }, clientIp(req)); emitWebhook('knowledge.upload_refused', { file: fileName(req), classification, by: u.email }); throw new HttpError(422, problem); } // refused before the file is read or stored
  const buf = await readBody(req, config.maxUploadMb * MB);
  const doc = await ingestDoc({ collectionId: p.id, filename: fileName(req), mime: String(req.headers['content-type'] || '').split(';')[0], buf, classification, title: req.headers['x-title'] ? decodeURIComponent(req.headers['x-title']) : null, userId: u.id });
  audit(u.id, 'knowledge.upload', { doc: doc.id, title: doc.title, classification, status: doc.status }, clientIp(req));
  json(res, 200, doc);
});
route('DELETE', '/api/admin/docs/:id', (req, res, u, p) => { requireAdmin(u); const d = one(`SELECT title FROM docs WHERE id=?`, p.id); deleteDoc(p.id); audit(u.id, 'knowledge.delete', { doc: p.id, title: d?.title }, clientIp(req)); json(res, 200, { ok: true }); });
route('PUT', '/api/admin/settings', async (req, res, u) => {
  requireAdmin(u); const b = await readJson(req, 500e3); const s = getSettings();
  if (Array.isArray(b.openaiModels)) s.openaiModels = b.openaiModels.slice(0, 30).map(m => ({ id: /^openai:[\w.-]{1,40}$/.test(m.id) ? m.id : 'openai:' + String(m.api || 'model').toLowerCase().replace(/[^\w.-]+/g, '-').slice(0, 40), api: String(m.api || '').trim().slice(0, 80), label: String(m.label || m.api || '').trim().slice(0, 60),
    tier: TIERS.includes(m.tier) ? m.tier : 'standard', vision: !!m.vision, reasoning: !!m.reasoning, priceIn: Math.max(0, +m.priceIn || 0), priceOut: Math.max(0, +m.priceOut || 0), priceCached: m.priceCached === '' || m.priceCached == null ? '' : Math.max(0, +m.priceCached || 0) })).filter(m => m.api);
  if (Array.isArray(b.localModels)) s.localModels = b.localModels.slice(0, 20).map(m => ({ id: /^local:[\w.-]{1,40}$/.test(m.id) ? m.id : 'local:' + String(m.api || 'model').toLowerCase().replace(/[^\w.-]+/g, '-').slice(0, 40), api: String(m.api || '').trim().slice(0, 80), label: String(m.label || m.api || '').trim().slice(0, 60), tier: TIERS.includes(m.tier) ? m.tier : 'standard', vision: !!m.vision })).filter(m => m.api);
  const known = new Set(allModels(s).map(m => m.id));
  if (Array.isArray(b.models)) { const m = b.models.filter(x => known.has(x)); if (!m.length) throw new HttpError(400, 'Enable at least one model'); s.models = m; }
  s.models = s.models.filter(x => known.has(x));
  if (b.defaultModel && (b.defaultModel === 'auto' || known.has(b.defaultModel))) s.defaultModel = b.defaultModel;
  if (s.defaultModel !== 'auto' && !s.models.includes(s.defaultModel)) s.defaultModel = 'auto';
  if (b.routing) { s.routing.failover = b.routing.failover !== false; for (const k of Object.keys(CATEGORIES)) if (b.routing.rules?.[k] && known.has(b.routing.rules[k])) s.routing.rules[k] = b.routing.rules[k]; }
  if (b.security) s.security = { require2fa: ['all', 'admins', 'off'].includes(b.security.require2fa) ? b.security.require2fa : s.security.require2fa,
    maskingRetentionDays: Math.max(0, Math.min(3650, +b.security.maskingRetentionDays || 0)), logRetentionDays: Math.max(0, Math.min(3650, +b.security.logRetentionDays || 0)) };
  if (b.rateLimits) s.rateLimits = { perMinute: Math.max(0, Math.min(1000, +b.rateLimits.perMinute || 0)), perDay: Math.max(0, Math.min(100000, +b.rateLimits.perDay || 0)) };
  if (b.webhook) { const url = String(b.webhook.url || '').trim(); if (url && !/^https?:\/\//.test(url)) throw new HttpError(400, 'Webhook URL must start with http(s)://');
    s.webhook.url = url; if (Array.isArray(b.webhook.events)) s.webhook.events = b.webhook.events.map(String).slice(0, 20); if (url && !s.webhook.secret) s.webhook.secret = crypto.randomBytes(24).toString('base64url'); }
  for (const k of ['webSearch', 'imageUploads', 'canvas']) if (typeof b[k] === 'boolean') s[k] = b[k];
  if (typeof b.reportStyle === 'string') s.reportStyle = b.reportStyle.slice(0, 8000);
  if (b.redaction) s.redaction = { enabled: !!b.redaction.enabled, terms: (b.redaction.terms || []).map(t => String(t).trim()).filter(Boolean).slice(0, 500), columns: (b.redaction.columns || s.redaction.columns || []).map(t => String(t).trim()).filter(Boolean).slice(0, 100) };
  if (b.monthlyBudgetUsd !== undefined) s.monthlyBudgetUsd = clampBudget(b.monthlyBudgetUsd) ?? 0;
  if (Array.isArray(b.orgSkills)) s.orgSkills = b.orgSkills.slice(0, 50).map(k => ({ id: String(k.id || id()), name: String(k.name || '').slice(0, 80), description: String(k.description || '').slice(0, 200), content: String(k.content || '').slice(0, 20000), enabled: k.enabled !== false })).filter(k => k.name && k.content);
  if (Array.isArray(b.orgPrompts)) s.orgPrompts = b.orgPrompts.slice(0, 100).map(k => ({ id: String(k.id || id()), title: String(k.title || '').slice(0, 80), body: String(k.body || '').slice(0, 8000), icon: 'bolt' })).filter(k => k.title && k.body);
  saveSettings(s); audit(u.id, 'admin.settings_updated', { keys: Object.keys(b) }, clientIp(req)); json(res, 200, s);
});
route('GET', '/api/admin/usage', (req, res, u) => {
  requireAdmin(u); const q = new URL(req.url, 'http://x').searchParams;
  const m = /^\d{4}-\d{2}$/.test(q.get('month') || '') ? q.get('month') : null;
  const start = m ? new Date(+m.slice(0, 4), +m.slice(5) - 1, 1).getTime() : monthStart(); const end = new Date(new Date(start).getFullYear(), new Date(start).getMonth() + 1, 1).getTime();
  const rows = all(`SELECT u.email, u.name, us.user_id, COUNT(*) requests, SUM(us.input+us.cache_read+us.cache_write) input, SUM(us.output) output, SUM(us.cost) cost
    FROM usage us LEFT JOIN users u ON u.id=us.user_id WHERE us.ts>=? AND us.ts<? GROUP BY us.user_id ORDER BY cost DESC`, start, end);
  const byModel = all(`SELECT model, COUNT(*) requests, SUM(cost) cost FROM usage WHERE ts>=? AND ts<? GROUP BY model ORDER BY cost DESC`, start, end);
  json(res, 200, { month: new Date(start).toISOString().slice(0, 7), rows, byModel, total: rows.reduce((a, r) => a + r.cost, 0) });
});
route('GET', '/api/admin/audit', (req, res, u) => {
  requireAdmin(u); const q = new URL(req.url, 'http://x').searchParams; const lim = Math.min(1000, +(q.get('limit') || 200));
  const act = q.get('action');
  const rows = all(`SELECT a.ts, a.action, a.detail, a.ip, us.email FROM audit a LEFT JOIN users us ON us.id=a.user_id ${act ? 'WHERE a.action LIKE ?' : ''} ORDER BY a.id DESC LIMIT ?`, ...(act ? [act + '%', lim] : [lim]));
  json(res, 200, rows.map(r => ({ ...r, detail: JSON.parse(r.detail || '{}') })));
});

function cleanProject(b) {
  const cols = new Set(all(`SELECT id FROM collections`).map(c => c.id)); const grps = new Set(all(`SELECT id FROM groups`).map(g => g.id));
  const models = new Set(['auto', ...allModels().map(m => m.id)]);
  return { name: String(b.name || '').trim().slice(0, 80), description: String(b.description || '').slice(0, 300), instructions: String(b.instructions || '').slice(0, 20000),
    collections: JSON.stringify((b.collections || []).filter(c => cols.has(c))), groups: JSON.stringify((b.groups || []).filter(g => grps.has(g))), model: models.has(b.model) ? b.model : 'auto' };
}
route('POST', '/api/admin/projects', async (req, res, u) => {
  requireAdmin(u); const p = cleanProject(await readJson(req, 100e3)); if (!p.name) throw new HttpError(400, 'Name required');
  const pid = id(); run(`INSERT INTO projects(id,name,description,instructions,collections,groups,model,created,updated) VALUES(?,?,?,?,?,?,?,?,?)`, pid, p.name, p.description, p.instructions, p.collections, p.groups, p.model, now(), now());
  audit(u.id, 'admin.project_created', { name: p.name }, clientIp(req)); json(res, 200, { id: pid });
});
route('PUT', '/api/admin/projects/:id', async (req, res, u, prm) => {
  requireAdmin(u); if (!one(`SELECT 1 FROM projects WHERE id=?`, prm.id)) throw new HttpError(404, 'Project not found');
  const p = cleanProject(await readJson(req, 100e3)); if (!p.name) throw new HttpError(400, 'Name required');
  run(`UPDATE projects SET name=?,description=?,instructions=?,collections=?,groups=?,model=?,updated=? WHERE id=?`, p.name, p.description, p.instructions, p.collections, p.groups, p.model, now(), prm.id);
  audit(u.id, 'admin.project_updated', { name: p.name }, clientIp(req)); json(res, 200, { ok: true });
});
route('DELETE', '/api/admin/projects/:id', (req, res, u, prm) => { requireAdmin(u); const p = one(`SELECT name FROM projects WHERE id=?`, prm.id); run(`DELETE FROM projects WHERE id=?`, prm.id); audit(u.id, 'admin.project_deleted', { name: p?.name }, clientIp(req)); json(res, 200, { ok: true }); });
route('GET', '/api/admin/security', (req, res, u) => {
  requireAdmin(u); const s = getSettings();
  const users = one(`SELECT COUNT(*) n, SUM(totp_secret IS NOT NULL) tf FROM users WHERE disabled=0 AND pw_hash IS NOT NULL`);
  let dirMode = null; try { dirMode = (fs.statSync(config.dataDir).mode & 0o777).toString(8); } catch {}
  const checks = [
    { id: 'https', ok: config.publicUrl.startsWith('https://') && config.cookieSecure, label: 'HTTPS with secure cookies', fix: 'Serve Canopus over HTTPS and set PUBLIC_URL to the https:// address.' },
    { id: '2fa', ok: s.security.require2fa === 'all', warn: s.security.require2fa === 'admins', label: `Two-step verification required for ${s.security.require2fa === 'all' ? 'everyone' : s.security.require2fa === 'admins' ? 'administrators only' : 'nobody'} (${users.tf || 0} of ${users.n} active users enrolled)`, fix: 'Require two-step verification for everyone below.' },
    { id: 'ip', ok: config.allowedIps.length > 0, label: config.allowedIps.length ? `Access limited to ${config.allowedIps.join(', ')}` : 'Reachable from any IP address', fix: 'Set CANOPUS_ALLOWED_IPS to your office network / VPN range, or put Canopus behind a VPN.' },
    { id: 'idle', ok: config.idleMinutes > 0 && config.idleMinutes <= 30, label: `Sign-out after ${config.idleMinutes} minutes of inactivity, ${config.sessionHours} hours at most`, fix: 'Set SESSION_IDLE_MINUTES to 30 or less.' },
    { id: 'mask', ok: s.redaction.enabled, label: s.redaction.enabled ? 'Personal data is masked before reaching cloud AI' : 'Masking is OFF', fix: 'Turn on masking in Settings.' },
    { id: 'local', ok: all(`SELECT COUNT(*) c FROM collections WHERE local_only=1`)[0].c > 0 || !s.models.some(m => m.startsWith('openai') || ['prime', 'core', 'swift'].includes(m)), warn: true, label: `${all(`SELECT COUNT(*) c FROM collections WHERE local_only=1`)[0].c} collection(s) kept on this server only${providerReady('local') ? ' · on-premise model connected' : ''}`, fix: 'Mark patient-record collections “On this server only”.' },
    { id: 'web', ok: !s.webSearch, warn: s.webSearch, label: s.webSearch ? 'Web search is on (search queries go to the search provider)' : 'Web search is off', fix: 'Turn off web search if questions may contain sensitive context.' },
    { id: 'img', ok: !s.imageUploads, warn: s.imageUploads, label: s.imageUploads ? 'Image uploads allowed (images cannot be masked)' : 'Image uploads blocked', fix: 'Turn off image uploads if screenshots may contain patient data.' },
    { id: 'budget', ok: s.monthlyBudgetUsd > 0, label: s.monthlyBudgetUsd > 0 ? `Default budget $${s.monthlyBudgetUsd} per user per month` : 'No default budget', fix: 'Set a default monthly budget.' },
    { id: 'files', ok: dirMode === '700', warn: dirMode !== '700', label: `Data folder permissions: ${dirMode ?? 'unknown'}`, fix: 'Run: chmod 700 on the data folder.' },
    { id: 'retention', ok: s.security.maskingRetentionDays > 0 && s.security.maskingRetentionDays <= 365, label: `Masking table kept ${s.security.maskingRetentionDays || 'forever'} days · logs ${s.security.logRetentionDays || 'forever'}`, fix: 'Set how long masking data is kept.' },
  ];
  json(res, 200, { checks, settings: s.security });
});
route('POST', '/api/admin/webhook/test', async (req, res, u) => { requireAdmin(u); const r = await emitWebhook('test', { by: u.email, message: 'Canopus webhook test' }, { force: true }); json(res, 200, r); });
route('POST', '/api/admin/webhook/rotate', (req, res, u) => { requireAdmin(u); const s = getSettings(); s.webhook.secret = crypto.randomBytes(24).toString('base64url'); saveSettings(s); audit(u.id, 'admin.webhook_secret_rotated', {}, clientIp(req)); json(res, 200, { secret: s.webhook.secret }); });
route('GET', '/api/admin/webhook/secret', (req, res, u) => { requireAdmin(u); json(res, 200, { secret: getSettings().webhook.secret }); });
route('GET', '/api/admin/openai/models', async (req, res, u) => { requireAdmin(u); try { json(res, 200, await listOpenAIModels()); } catch (e) { throw new HttpError(e.status || 502, e.message); } });
const SCOPES = ['ask', 'knowledge:read', 'knowledge:write'];
route('POST', '/api/admin/tokens', async (req, res, u) => {
  requireAdmin(u); const b = await readJson(req, 20e3);
  const owner = one(`SELECT * FROM users WHERE id=? AND disabled=0`, String(b.user_id || u.id)); if (!owner) throw new HttpError(400, 'Choose an active user for the token to act as');
  const scopes = (b.scopes || []).filter(x => SCOPES.includes(x)); if (!scopes.length) throw new HttpError(400, 'Choose at least one permission');
  const token = 'cnp_' + crypto.randomBytes(24).toString('base64url'); const tid = id();
  run(`INSERT INTO api_tokens(id,name,token_hash,prefix,user_id,scopes,created,created_by) VALUES(?,?,?,?,?,?,?,?)`, tid, String(b.name || 'Integration').slice(0, 60), sha256(token), token.slice(0, 10), owner.id, JSON.stringify(scopes), now(), u.id);
  audit(u.id, 'admin.token_created', { name: b.name, as: owner.email, scopes }, clientIp(req)); json(res, 200, { id: tid, token });
});
route('DELETE', '/api/admin/tokens/:id', (req, res, u, p) => { requireAdmin(u); run(`UPDATE api_tokens SET revoked=1 WHERE id=?`, p.id); audit(u.id, 'admin.token_revoked', { id: p.id }, clientIp(req)); json(res, 200, { ok: true }); });

/* ---------- integration API (n8n, scripts): Authorization: Bearer cnp_… ---------- */
function tokenUser(req, scope) {
  const m = String(req.headers.authorization || '').match(/^Bearer\s+(cnp_[\w-]+)$/); if (!m) throw new HttpError(401, 'Missing API token');
  const t = one(`SELECT * FROM api_tokens WHERE token_hash=? AND revoked=0`, sha256(m[1])); if (!t) throw new HttpError(401, 'Invalid or revoked API token');
  if (!JSON.parse(t.scopes).includes(scope)) throw new HttpError(403, `This token does not have the “${scope}” permission`);
  const u = one(`SELECT * FROM users WHERE id=? AND disabled=0`, t.user_id); if (!u) throw new HttpError(403, 'The token’s user is disabled');
  run(`UPDATE api_tokens SET last_used=? WHERE id=?`, now(), t.id); return { u, t };
}
route('POST', '/api/v1/ask', async (req, res) => {
  const { u, t } = tokenUser(req, 'ask'); const b = await readJson(req, 200e3);
  const question = String(b.question || '').trim(); if (!question) throw new HttpError(400, 'Provide "question"');
  const events = []; const ac = new AbortController(); res.on('close', () => { if (!res.writableFinished) ac.abort(); });
  const r = await converse(u, { chatId: 'api-' + t.id, model: b.model || 'auto', mode: b.mode || 'auto', knowledge: b.knowledge !== false, web: !!b.web, system: { instructions: String(b.instructions || '').slice(0, 8000) }, messages: [{ role: 'user', content: [{ type: 'text', text: question.slice(0, 50000) }] }] }, ev => events.push(ev), ac.signal, clientIp(req));
  audit(u.id, 'api.ask', { token: t.name, model: r?.model?.id }, clientIp(req));
  if (r?.error) throw new HttpError(r.code === 'budget' || r.code === 'group_budget' ? 402 : r.code === 'rate' ? 429 : 502, r.error);
  json(res, 200, { answer: r.display, model: r.model, route: r.route, citations: r.citations.map(c => ({ title: c.title, text: c.text, url: c.url || null })), usage: r.usage });
}, { public: true, token: true });
route('GET', '/api/v1/collections', (req, res) => { const { u } = tokenUser(req, 'knowledge:read'); json(res, 200, knowledgeFor(u).map(c => ({ id: c.id, name: c.name, documents: c.docs.map(d => ({ id: d.id, title: d.title, status: d.status, classification: d.classification })) }))); }, { public: true, token: true });
route('POST', '/api/v1/collections/:id/docs', async (req, res, _u, p) => {
  const { u, t } = tokenUser(req, 'knowledge:write');
  if (!allowedCollections(u).some(c => c.id === p.id)) throw new HttpError(404, 'Collection not found');
  const classification = String(req.headers['x-classification'] || ''); const problem = classificationProblem(classification);
  if (problem) { req.resume(); audit(u.id, 'knowledge.upload_refused', { file: fileName(req), classification, via: t.name }, clientIp(req)); emitWebhook('knowledge.upload_refused', { file: fileName(req), classification, via: t.name }); throw new HttpError(422, problem); }
  const buf = await readBody(req, config.maxUploadMb * MB);
  const doc = await ingestDoc({ collectionId: p.id, filename: fileName(req), mime: String(req.headers['content-type'] || '').split(';')[0], buf, classification, title: req.headers['x-title'] ? decodeURIComponent(req.headers['x-title']) : null, userId: u.id });
  audit(u.id, 'knowledge.upload', { doc: doc.id, title: doc.title, classification, status: doc.status, via: t.name }, clientIp(req));
  json(res, 200, { id: doc.id, title: doc.title, status: doc.status, error: doc.error, passages: doc.chunks });
}, { public: true, token: true });

/* ---------- reports: curated spreadsheets and presentations ---------- */
const sendFile = (res, buf, name, type) => { res.writeHead(200, { 'content-type': type, 'content-length': buf.length, 'cache-control': 'no-store', 'content-security-policy': 'sandbox', 'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(name)}` }); res.end(buf); };
const XLSX_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', PPTX_TYPE = 'application/vnd.openxmlformats-officedocument.presentationml.presentation';
route('GET', '/api/reports', async (req, res, u) => json(res, 200, { clients: R.listClients(), templates: await R.listTemplates(u), datasets: R.listDatasets(u), decks: R.listDecks(u), meta: R.REPORT_META }));
route('POST', '/api/reports/clients', async (req, res, u) => { const b = await readJson(req, 50e3); const cid = R.saveClient(u, null, b); audit(u.id, 'report.client_created', { client: cid, name: String(b.name).slice(0, 120) }, clientIp(req)); json(res, 200, { id: cid }); });
route('PUT', '/api/reports/clients/:id', async (req, res, u, p) => { R.saveClient(u, p.id, await readJson(req, 50e3)); json(res, 200, { ok: true }); });
route('DELETE', '/api/reports/clients/:id', (req, res, u, p) => { const c = R.deleteClient(u, p.id); audit(u.id, 'report.client_deleted', { client: c.id, name: c.name }, clientIp(req)); json(res, 200, { ok: true }); });
route('POST', '/api/reports/clients/:id/docs', async (req, res, u, p) => { // client knowledge: earlier reports, briefs, guidelines
  const c = R.listClients().find(x => x.id === p.id); if (!c?.collection_id) throw new HttpError(404, 'Client not found');
  const classification = String(req.headers['x-classification'] || 'biasa'); const problem = classificationProblem(classification);
  if (problem) { req.resume(); audit(u.id, 'knowledge.upload_refused', { file: fileName(req), classification, client: c.id }, clientIp(req)); throw new HttpError(422, problem); }
  const buf = await readBody(req, config.maxUploadMb * MB);
  const doc = await ingestDoc({ collectionId: c.collection_id, filename: fileName(req), mime: String(req.headers['content-type'] || '').split(';')[0], buf, classification, title: null, userId: u.id });
  audit(u.id, 'knowledge.upload', { doc: doc.id, title: doc.title, classification, status: doc.status, client: c.id }, clientIp(req)); json(res, 200, doc);
});
route('POST', '/api/reports/clients/:id/recipes', async (req, res, u, p) => { const rid = R.addRecipe(u, p.id, await readJson(req, 1 * MB)); audit(u.id, 'report.recipe_saved', { client: p.id, recipe: rid }, clientIp(req)); json(res, 200, { id: rid }); });
route('GET', '/api/reports/recipes/:id', (req, res, u, p) => json(res, 200, R.getRecipe(p.id)));
route('DELETE', '/api/reports/recipes/:id', (req, res, u, p) => { R.deleteRecipe(u, p.id); json(res, 200, { ok: true }); });
route('POST', '/api/reports/templates', async (req, res, u) => {
  const buf = await readBody(req, config.maxUploadMb * MB); const clientId = String(req.headers['x-client'] || '') || null;
  const t = await R.addTemplate(u, { filename: fileName(req), buf, name: req.headers['x-title'] ? decodeURIComponent(req.headers['x-title']) : null, clientId, personal: req.headers['x-scope'] === 'personal' });
  audit(u.id, 'report.template_added', { template: t.id, file: fileName(req), client: clientId }, clientIp(req)); json(res, 200, t);
});
route('PATCH', '/api/reports/templates/:id', async (req, res, u, p) => { R.updateTemplate(u, p.id, await readJson(req, 10e3)); json(res, 200, { ok: true }); });
route('DELETE', '/api/reports/templates/:id', (req, res, u, p) => { const t = R.deleteTemplate(u, p.id); audit(u.id, 'report.template_deleted', { template: t.id, name: t.name }, clientIp(req)); json(res, 200, { ok: true }); });
route('GET', '/api/reports/templates/:id/file', (req, res, u, p) => { const f = R.templateFile(u, p.id); sendFile(res, f.buf, f.name, PPTX_TYPE); });
route('POST', '/api/reports/datasets', async (req, res, u) => {
  const buf = await readBody(req, config.maxUploadMb * MB); const d = await R.addDataset(u, { filename: fileName(req), buf, clientId: String(req.headers['x-client'] || '') || null });
  audit(u.id, 'report.dataset_added', { dataset: d.id, file: d.filename, rows: d.sheets.reduce((a, s) => a + s.rows, 0) }, clientIp(req)); json(res, 200, d);
});
route('GET', '/api/reports/datasets/:id', async (req, res, u, p) => json(res, 200, await R.getDataset(u, p.id)));
route('POST', '/api/reports/datasets/:id/files', async (req, res, u, p) => {
  const buf = await readBody(req, config.maxUploadMb * MB); const d = await R.addDatasetFile(u, p.id, { filename: fileName(req), buf, label: req.headers['x-label'] ? decodeURIComponent(req.headers['x-label']) : null });
  audit(u.id, 'report.dataset_file_added', { dataset: p.id, file: fileName(req) }, clientIp(req)); json(res, 200, d);
});
route('PATCH', '/api/reports/datasets/:id/files/:i', async (req, res, u, p) => { R.relabelFile(u, p.id, { index: +p.i, label: (await readJson(req, 5e3)).label }); json(res, 200, await R.getDataset(u, p.id)); });
route('PATCH', '/api/reports/datasets/:id', async (req, res, u, p) => { const { name } = await readJson(req, 10e3); R.renameDataset(u, p.id, name); json(res, 200, { ok: true }); });
route('DELETE', '/api/reports/datasets/:id', (req, res, u, p) => { const d = R.deleteDataset(u, p.id); audit(u.id, 'report.dataset_deleted', { dataset: d.id, file: d.filename }, clientIp(req)); json(res, 200, { ok: true }); });
route('POST', '/api/reports/datasets/:id/plan', async (req, res, u, p) => {
  const body = await readJson(req, 50e3); const r = await R.planDataset(u, p.id, body);
  audit(u.id, 'report.plan', { dataset: p.id, model: r.model.id, steps: r.plan.steps.length }, clientIp(req)); json(res, 200, r);
});
route('POST', '/api/reports/datasets/:id/run', async (req, res, u, p) => json(res, 202, R.startRun(u, p.id, await readJson(req, 2 * MB))));
route('GET', '/api/reports/datasets/:id/job', (req, res, u, p) => json(res, 200, R.jobStatus(u, p.id)));
route('POST', '/api/reports/datasets/:id/estimate', async (req, res, u, p) => json(res, 200, await R.estimateRun(u, p.id, await readJson(req, 2 * MB))));
route('GET', '/api/reports/datasets/:id/xlsx', async (req, res, u, p) => { const f = await R.datasetXlsx(u, p.id, { upper: new URL(req.url, 'http://x').searchParams.get('upper') !== '0' }); audit(u.id, 'report.download', { dataset: p.id, type: 'xlsx' }, clientIp(req)); sendFile(res, f.buf, f.name, XLSX_TYPE); });
route('POST', '/api/reports/datasets/:id/attach', (req, res, u, p) => json(res, 200, R.datasetDigest(u, p.id)));
route('POST', '/api/reports/sources', async (req, res, u) => { const { datasets } = await readJson(req, 20e3); json(res, 200, R.deckSources(u, Array.isArray(datasets) ? datasets : [])); });
route('POST', '/api/reports/decks', async (req, res, u) => {
  const body = await readJson(req, 100e3); const k = await R.draftDeck(u, body);
  audit(u.id, 'report.deck_drafted', { deck: k.id, model: k.model.id, finalizer: k.finalizer?.id || null, slides: k.outline.slides.length, datasets: k.datasets.length }, clientIp(req)); json(res, 200, k);
});
route('GET', '/api/reports/decks/:id', (req, res, u, p) => json(res, 200, R.getDeck(u, p.id)));
route('GET', '/api/reports/decks/:id/checks', (req, res, u, p) => json(res, 200, R.checkDeck(u, p.id)));
route('POST', '/api/reports/images', async (req, res, u) => { const buf = await readBody(req, 15 * MB); json(res, 200, R.saveImage(u, { buf, mime: String(req.headers['content-type'] || '').split(';')[0], filename: fileName(req) })); });
route('GET', '/api/reports/images/:id', (req, res, u, p) => { const im = R.imageFile(u, p.id); res.writeHead(200, { 'content-type': im.mime, 'cache-control': 'private, max-age=3600', 'content-security-policy': 'sandbox' }); res.end(im.buf); });
route('POST', '/api/reports/clients/:id/logos', async (req, res, u, p) => { const buf = await readBody(req, 5 * MB); const lid = R.addClientLogo(u, p.id, { buf, mime: String(req.headers['content-type'] || '').split(';')[0], filename: fileName(req) }); json(res, 200, { id: lid }); });
route('DELETE', '/api/reports/clients/:id/logos/:lid', (req, res, u, p) => { R.removeClientLogo(u, p.id, p.lid); json(res, 200, { ok: true }); });
route('GET', '/api/reports/clients/:id/logos/:lid', (req, res, u, p) => { const l = R.clientLogoFile(p.id, p.lid); res.writeHead(200, { 'content-type': l.mime, 'cache-control': 'private, max-age=3600', 'content-security-policy': 'sandbox' }); res.end(l.buf); });
route('GET', '/api/reports/styles', (req, res, u) => json(res, 200, R.stylesFor(new URL(req.url, 'http://x').searchParams.get('client') || null)));
route('PUT', '/api/reports/clients/:id/style', async (req, res, u, p) => { R.setClientStyle(u, p.id, (await readJson(req, 20e3)).style); json(res, 200, { ok: true }); });
route('POST', '/api/reports/decks/:id/finalize', async (req, res, u, p) => {
  const body = await readJson(req, 10e3); const k = await R.refinalizeDeck(u, p.id, body);
  audit(u.id, 'report.deck_finalized', { deck: p.id, model: k.finalizer.id }, clientIp(req)); json(res, 200, k);
});
route('PUT', '/api/reports/decks/:id', async (req, res, u, p) => json(res, 200, R.saveDeck(u, p.id, await readJson(req, 1 * MB))));
route('DELETE', '/api/reports/decks/:id', (req, res, u, p) => { R.deleteDeck(u, p.id); json(res, 200, { ok: true }); });
route('GET', '/api/reports/decks/:id/pptx', async (req, res, u, p) => {
  const r = await R.deckPptx(u, p.id); audit(u.id, 'report.download', { deck: p.id, type: 'pptx', slides: r.slides }, clientIp(req));
  res.setHeader('x-canopus-warnings', encodeURIComponent(JSON.stringify(r.warnings).slice(0, 2000))); sendFile(res, r.buf, r.name, PPTX_TYPE);
});

/* ---------- static files ---------- */
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json' };
function serveStatic(req, res) {
  let rel = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (rel === '/') rel = '/index.html';
  const file = path.normalize(path.join(PUBLIC, rel));
  if (!file.startsWith(PUBLIC + path.sep) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { json(res, 404, { error: 'Not found' }); return; }
  const ext = path.extname(file);
  res.setHeader('content-security-policy', rel === '/sandbox.html' ? SANDBOX_CSP : APP_CSP);
  if (rel !== '/sandbox.html') res.setHeader('x-frame-options', 'SAMEORIGIN');
  res.writeHead(200, { 'content-type': TYPES[ext] || 'application/octet-stream', 'cache-control': rel.startsWith('/vendor/') ? 'public, max-age=86400' : 'no-cache' });
  fs.createReadStream(file).pipe(res);
}

/* ---------- server ---------- */
const expectedOrigin = new URL(config.publicUrl).origin;
const server = http.createServer(async (req, res) => {
  baseHeaders(res);
  if (!ipAllowed(clientIp(req))) { res.writeHead(403, { 'content-type': 'text/plain' }); return res.end('Access from this network is not allowed.'); }
  const url = new URL(req.url, 'http://x');
  try {
    if (!url.pathname.startsWith('/api/')) { if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, 'Method not allowed'); return serveStatic(req, res); }
    const r = routes.find(r => r.method === req.method && r.re.test(url.pathname));
    if (!r) throw new HttpError(404, 'Not found');
    if (req.method !== 'GET' && !r.token) { // CSRF: custom header (forces a CORS preflight we never allow) + same-origin check
      if (req.headers['x-canopus'] !== '1') throw new HttpError(403, 'Missing request header');
      const origin = req.headers.origin; if (origin && origin !== expectedOrigin && origin !== `http://${req.headers.host}` && origin !== `https://${req.headers.host}`) throw new HttpError(403, 'Cross-origin request blocked');
    }
    let user = null;
    if (!r.public) { user = sessionUser(req); if (!user) throw new HttpError(401, 'Please sign in.'); }
    await r.handler(req, res, user, r.re.exec(url.pathname).groups || {});
  } catch (e) {
    if (!e.status || e.status >= 500) console.error('[error]', req.method, url.pathname, e.message);
    if (!res.headersSent) json(res, e.status || 500, { error: e.status ? e.message : 'Internal error' });
    else res.end();
  }
});
server.requestTimeout = 0; // chat streams can be long; individual reads have their own limits
server.headersTimeout = 30e3;

bootstrapAdmin();
purge(); setInterval(purge, 3600e3).unref();
server.listen(config.port, config.host, () => {
  console.log(`Canopus is running on ${config.publicUrl} (listening on ${config.host}:${config.port})`);
  if (!config.apiKey && !config.openaiKey) console.warn('WARNING: neither ANTHROPIC_API_KEY nor OPENAI_API_KEY is set. Chat will not work until one is.');
  console.log(`Providers: Anthropic ${config.apiKey ? 'configured' : 'not configured'} · OpenAI ${config.openaiKey ? 'configured' : 'not configured'}`);
});
export default server;
