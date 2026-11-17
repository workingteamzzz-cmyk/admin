import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { config, ROOT, MODELS, CLASSIFICATIONS } from './config.mjs';
import { db, one, all, run, id, now, tx, getSettings, saveSettings, audit, userGroups, allowedCollections, spentThisMonth, budgetFor, monthStart } from './db.mjs';
import { hashPassword, verifyPassword, passwordProblem, createInvite, inviteUser, consumeInvite, createSession, destroySession, sessionUser, clientIp, loginBlocked, loginFailed, loginOk, createUser, publicUser } from './auth.mjs';
import { ingestDoc, deleteDoc, deleteCollection, classificationProblem } from './knowledge.mjs';
import { chat, quick } from './claude.mjs';
import { bootstrapAdmin } from './cli.mjs';

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
  return allowedCollections(user).map(c => ({ ...c, groups: all(`SELECT g.id,g.name FROM groups g JOIN collection_groups cg ON cg.group_id=g.id WHERE cg.collection_id=?`, c.id),
    docs: all(`SELECT id,title,filename,size,classification,status,error,chunks,pages,created FROM docs WHERE collection_id=? ORDER BY created DESC`, c.id) }));
}
function mePayload(u) {
  const s = getSettings();
  return { user: publicUser(u), groups: userGroups(u.id),
    config: { models: s.models.filter(m => MODELS[m]).map(m => ({ id: m, label: MODELS[m].label, d: MODELS[m].d })), defaultModel: s.defaultModel, webSearch: s.webSearch, imageUploads: s.imageUploads, redaction: s.redaction.enabled, maxUploadMb: config.maxUploadMb, classifications: CLASSIFICATIONS, apiConfigured: !!config.apiKey },
    budget: { limit: budgetFor(u), spent: +spentThisMonth(u.id).toFixed(4) },
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

route('GET', '/api/health', (req, res) => json(res, 200, { ok: true, apiConfigured: !!config.apiKey }), { public: true });

route('POST', '/api/auth/login', async (req, res) => {
  const { email, password } = await readJson(req, 10e3);
  const key = `${clientIp(req)}|${String(email).toLowerCase()}`;
  const wait = loginBlocked(key); if (wait) throw new HttpError(429, `Too many attempts. Try again in ${wait} minute${wait > 1 ? 's' : ''}.`);
  const u = one(`SELECT * FROM users WHERE email=?`, String(email || '').trim().toLowerCase());
  const ok = u && !u.disabled && await verifyPassword(String(password || ''), u.pw_hash);
  if (!ok) { loginFailed(key); audit(u?.id || null, 'auth.login_failed', { email: String(email).slice(0, 100) }, clientIp(req)); throw new HttpError(401, 'Wrong email or password.'); }
  loginOk(key); createSession(res, u, req); audit(u.id, 'auth.login', {}, clientIp(req));
  json(res, 200, mePayload(u));
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
  tx(() => { run(`UPDATE users SET pw_hash=?, name=COALESCE(NULLIF(?,''),name) WHERE id=?`, pw, String(name || '').trim().slice(0, 80), inv.user_id); run(`DELETE FROM sessions WHERE user_id=?`, inv.user_id); });
  consumeInvite(token);
  const u = one(`SELECT * FROM users WHERE id=?`, inv.user_id);
  createSession(res, u, req); audit(u.id, 'auth.password_set', {}, clientIp(req));
  json(res, 200, mePayload(u));
}, { public: true });

route('GET', '/api/me', (req, res, u) => json(res, 200, mePayload(u)));
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

route('POST', '/api/chat', async (req, res, u) => { const body = await readJson(req, 8 * MB); await chat(req, res, u, body, clientIp(req)); });
route('POST', '/api/quick', async (req, res, u) => {
  const { purpose, text, chatId } = await readJson(req, 100e3);
  if (!['title', 'enhance'].includes(purpose)) throw new HttpError(400, 'Unknown purpose');
  try { json(res, 200, { text: await quick(u, purpose, text, chatId) }); } catch (e) { throw new HttpError(e.status || 502, e.message); }
});

route('GET', '/api/knowledge', (req, res, u) => json(res, 200, knowledgeFor(u)));
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
  const users = all(`SELECT id,email,name,role,disabled,budget_usd,created,last_login, (pw_hash IS NOT NULL) active FROM users ORDER BY created`).map(x => ({ ...x, groups: userGroups(x.id).map(g => g.id), spent: +spentThisMonth(x.id).toFixed(4), budget: budgetFor(x) }));
  json(res, 200, { users, groups: all(`SELECT g.*, (SELECT COUNT(*) FROM user_groups ug WHERE ug.group_id=g.id) members FROM groups g ORDER BY name`), collections: knowledgeFor(u), settings: getSettings(), classifications: CLASSIFICATIONS, models: MODELS, apiConfigured: !!config.apiKey });
});
route('POST', '/api/admin/users', async (req, res, u) => {
  requireAdmin(u); const b = await readJson(req, 20e3);
  const nu = createUser({ email: b.email, name: b.name, role: b.role, budget_usd: clampBudget(b.budget_usd) });
  setGroups('user_groups', 'user_id', nu.id, b.groups);
  const link = createInvite(nu.id); audit(u.id, 'admin.user_created', { user: nu.email, role: nu.role }, clientIp(req));
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
  });
  audit(u.id, 'admin.user_updated', { user: t.email, changes: Object.keys(b) }, clientIp(req)); json(res, 200, { ok: true });
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
route('DELETE', '/api/admin/groups/:id', (req, res, u, p) => { requireAdmin(u); run(`DELETE FROM groups WHERE id=?`, p.id); audit(u.id, 'admin.group_deleted', { id: p.id }, clientIp(req)); json(res, 200, { ok: true }); });
route('POST', '/api/admin/collections', async (req, res, u) => {
  requireAdmin(u); const b = await readJson(req, 20e3); const n = String(b.name || '').trim().slice(0, 80); if (!n) throw new HttpError(400, 'Name required');
  const cid = id(); run(`INSERT INTO collections(id,name,description,created) VALUES(?,?,?,?)`, cid, n, String(b.description || '').slice(0, 300), now());
  setGroups('collection_groups', 'collection_id', cid, b.groups); audit(u.id, 'admin.collection_created', { name: n, groups: b.groups || [] }, clientIp(req)); json(res, 200, { id: cid });
});
route('PATCH', '/api/admin/collections/:id', async (req, res, u, p) => {
  requireAdmin(u); const b = await readJson(req, 20e3); if (!one(`SELECT 1 FROM collections WHERE id=?`, p.id)) throw new HttpError(404, 'Not found');
  if (b.name !== undefined) run(`UPDATE collections SET name=? WHERE id=?`, String(b.name).trim().slice(0, 80) || 'Untitled', p.id);
  if (b.description !== undefined) run(`UPDATE collections SET description=? WHERE id=?`, String(b.description).slice(0, 300), p.id);
  if (Array.isArray(b.groups)) setGroups('collection_groups', 'collection_id', p.id, b.groups);
  audit(u.id, 'admin.collection_updated', { id: p.id, changes: Object.keys(b) }, clientIp(req)); json(res, 200, { ok: true });
});
route('DELETE', '/api/admin/collections/:id', (req, res, u, p) => { requireAdmin(u); deleteCollection(p.id); audit(u.id, 'admin.collection_deleted', { id: p.id }, clientIp(req)); json(res, 200, { ok: true }); });
route('POST', '/api/admin/collections/:id/docs', async (req, res, u, p) => {
  requireAdmin(u);
  const classification = String(req.headers['x-classification'] || '');
  const problem = classificationProblem(classification);
  if (problem) { req.resume(); audit(u.id, 'knowledge.upload_refused', { file: fileName(req), classification }, clientIp(req)); throw new HttpError(422, problem); } // refused before the file is read or stored
  const buf = await readBody(req, config.maxUploadMb * MB);
  const doc = await ingestDoc({ collectionId: p.id, filename: fileName(req), mime: String(req.headers['content-type'] || '').split(';')[0], buf, classification, title: req.headers['x-title'] ? decodeURIComponent(req.headers['x-title']) : null, userId: u.id });
  audit(u.id, 'knowledge.upload', { doc: doc.id, title: doc.title, classification, status: doc.status }, clientIp(req));
  json(res, 200, doc);
});
route('DELETE', '/api/admin/docs/:id', (req, res, u, p) => { requireAdmin(u); const d = one(`SELECT title FROM docs WHERE id=?`, p.id); deleteDoc(p.id); audit(u.id, 'knowledge.delete', { doc: p.id, title: d?.title }, clientIp(req)); json(res, 200, { ok: true }); });
route('PUT', '/api/admin/settings', async (req, res, u) => {
  requireAdmin(u); const b = await readJson(req, 500e3); const s = getSettings();
  if (Array.isArray(b.models)) { const m = b.models.filter(x => MODELS[x]); if (!m.length) throw new HttpError(400, 'Enable at least one model'); s.models = m; }
  if (b.defaultModel && MODELS[b.defaultModel]) s.defaultModel = b.defaultModel;
  if (!s.models.includes(s.defaultModel)) s.defaultModel = s.models[0];
  for (const k of ['webSearch', 'imageUploads']) if (typeof b[k] === 'boolean') s[k] = b[k];
  if (b.redaction) s.redaction = { enabled: !!b.redaction.enabled, terms: (b.redaction.terms || []).map(t => String(t).trim()).filter(Boolean).slice(0, 500) };
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
  const url = new URL(req.url, 'http://x');
  try {
    if (!url.pathname.startsWith('/api/')) { if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, 'Method not allowed'); return serveStatic(req, res); }
    const r = routes.find(r => r.method === req.method && r.re.test(url.pathname));
    if (!r) throw new HttpError(404, 'Not found');
    if (req.method !== 'GET') { // CSRF: custom header (forces a CORS preflight we never allow) + same-origin check
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
server.listen(config.port, config.host, () => {
  console.log(`Canopus is running on ${config.publicUrl} (listening on ${config.host}:${config.port})`);
  if (!config.apiKey) console.warn('WARNING: ANTHROPIC_API_KEY is not set. Chat will not work until it is.');
});
export default server;
