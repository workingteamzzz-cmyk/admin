import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { config, DEFAULT_SETTINGS } from './config.mjs';

fs.mkdirSync(config.dataDir, { recursive: true, mode: 0o700 });
fs.mkdirSync(path.join(config.dataDir, 'blobs'), { recursive: true, mode: 0o700 });
fs.mkdirSync(path.join(config.dataDir, 'docs'), { recursive: true, mode: 0o700 });

export const db = new DatabaseSync(path.join(config.dataDir, 'canopus.db'));
db.exec(`
PRAGMA journal_mode=WAL;
PRAGMA foreign_keys=ON;
CREATE TABLE IF NOT EXISTS users(id TEXT PRIMARY KEY, email TEXT UNIQUE NOT NULL, name TEXT NOT NULL DEFAULT '', role TEXT NOT NULL DEFAULT 'user',
  pw_hash TEXT, disabled INTEGER NOT NULL DEFAULT 0, budget_usd REAL, created INTEGER NOT NULL, last_login INTEGER);
CREATE TABLE IF NOT EXISTS invites(token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, expires INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS sessions(id_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, expires INTEGER NOT NULL, created INTEGER NOT NULL, ip TEXT, ua TEXT);
CREATE TABLE IF NOT EXISTS groups(id TEXT PRIMARY KEY, name TEXT UNIQUE NOT NULL);
CREATE TABLE IF NOT EXISTS user_groups(user_id TEXT REFERENCES users(id) ON DELETE CASCADE, group_id TEXT REFERENCES groups(id) ON DELETE CASCADE, PRIMARY KEY(user_id, group_id));
CREATE TABLE IF NOT EXISTS collections(id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', created INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS collection_groups(collection_id TEXT REFERENCES collections(id) ON DELETE CASCADE, group_id TEXT REFERENCES groups(id) ON DELETE CASCADE, PRIMARY KEY(collection_id, group_id));
CREATE TABLE IF NOT EXISTS docs(id TEXT PRIMARY KEY, collection_id TEXT NOT NULL REFERENCES collections(id) ON DELETE CASCADE, title TEXT NOT NULL, filename TEXT NOT NULL,
  mime TEXT, size INTEGER, classification TEXT NOT NULL, status TEXT NOT NULL, error TEXT, chunks INTEGER DEFAULT 0, pages INTEGER DEFAULT 0, sha256 TEXT,
  uploaded_by TEXT, created INTEGER NOT NULL);
CREATE VIRTUAL TABLE IF NOT EXISTS kchunks USING fts5(text, title, doc_id UNINDEXED, page UNINDEXED, idx UNINDEXED, tokenize='trigram remove_diacritics 1');
CREATE TABLE IF NOT EXISTS user_state(user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE, json TEXT NOT NULL, updated INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS blobs(id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, name TEXT, mime TEXT, size INTEGER, kind TEXT, created INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS usage(id INTEGER PRIMARY KEY, user_id TEXT, ts INTEGER NOT NULL, model TEXT, input INTEGER, output INTEGER, cache_read INTEGER, cache_write INTEGER, cost REAL, purpose TEXT);
CREATE INDEX IF NOT EXISTS usage_user_ts ON usage(user_id, ts);
CREATE TABLE IF NOT EXISTS audit(id INTEGER PRIMARY KEY, ts INTEGER NOT NULL, user_id TEXT, action TEXT NOT NULL, detail TEXT, ip TEXT);
CREATE TABLE IF NOT EXISTS redactions(user_id TEXT NOT NULL, chat_id TEXT NOT NULL, kind TEXT NOT NULL, token TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY(user_id, chat_id, value));
CREATE INDEX IF NOT EXISTS redactions_token ON redactions(user_id, chat_id, token);
CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY, json TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS api_tokens(id TEXT PRIMARY KEY, name TEXT NOT NULL, token_hash TEXT UNIQUE NOT NULL, prefix TEXT NOT NULL, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  scopes TEXT NOT NULL, created INTEGER NOT NULL, created_by TEXT, last_used INTEGER, revoked INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS chat_requests(user_id TEXT NOT NULL, ts INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS chat_requests_user_ts ON chat_requests(user_id, ts);
CREATE TABLE IF NOT EXISTS notices(key TEXT PRIMARY KEY, ts INTEGER NOT NULL);
`);
// Columns added after the first release.
for (const sql of [`ALTER TABLE groups ADD COLUMN budget_usd REAL`, `ALTER TABLE groups ADD COLUMN models TEXT`, `ALTER TABLE usage ADD COLUMN provider TEXT`]) { try { db.exec(sql); } catch {} }

export const id = () => crypto.randomBytes(9).toString('base64url');
export const now = () => Date.now();
export const sha256 = s => crypto.createHash('sha256').update(s).digest('hex');
export const one = (sql, ...a) => db.prepare(sql).get(...a);
export const all = (sql, ...a) => db.prepare(sql).all(...a);
export const run = (sql, ...a) => db.prepare(sql).run(...a);
export function tx(fn) { db.exec('BEGIN'); try { const r = fn(); db.exec('COMMIT'); return r; } catch (e) { db.exec('ROLLBACK'); throw e; } }

export function getSettings() {
  const row = one(`SELECT json FROM settings WHERE key='org'`);
  const s = { ...structuredClone(DEFAULT_SETTINGS), ...(row ? JSON.parse(row.json) : {}) };
  s.redaction = { ...DEFAULT_SETTINGS.redaction, ...(s.redaction || {}) };
  s.routing = { ...DEFAULT_SETTINGS.routing, ...(s.routing || {}), rules: { ...DEFAULT_SETTINGS.routing.rules, ...(s.routing?.rules || {}) } };
  s.rateLimits = { ...DEFAULT_SETTINGS.rateLimits, ...(s.rateLimits || {}) };
  s.webhook = { ...DEFAULT_SETTINGS.webhook, ...(s.webhook || {}) };
  return s;
}
export function saveSettings(s) { run(`INSERT INTO settings(key,json) VALUES('org',?) ON CONFLICT(key) DO UPDATE SET json=excluded.json`, JSON.stringify(s)); }

export function audit(userId, action, detail = {}, ip = null) {
  run(`INSERT INTO audit(ts,user_id,action,detail,ip) VALUES(?,?,?,?,?)`, now(), userId, action, JSON.stringify(detail), ip);
}

export function monthStart(d = new Date()) { return new Date(d.getFullYear(), d.getMonth(), 1).getTime(); }
export function spentThisMonth(userId) { return one(`SELECT COALESCE(SUM(cost),0) c FROM usage WHERE user_id=? AND ts>=?`, userId, monthStart()).c; }
export function budgetFor(user) { return user.budget_usd ?? getSettings().monthlyBudgetUsd; }

export function userGroups(userId) { return all(`SELECT g.id, g.name, g.budget_usd, g.models FROM groups g JOIN user_groups ug ON ug.group_id=g.id WHERE ug.user_id=?`, userId); }
export function groupSpent(groupId) { return one(`SELECT COALESCE(SUM(us.cost),0) c FROM usage us JOIN user_groups ug ON ug.user_id=us.user_id WHERE ug.group_id=? AND us.ts>=?`, groupId, monthStart()).c; }

// Collections a user may read: admins see all; otherwise collections with no group restriction, or sharing a group with the user.
export function allowedCollections(user) {
  if (user.role === 'admin') return all(`SELECT * FROM collections ORDER BY name`);
  return all(`SELECT c.* FROM collections c WHERE NOT EXISTS (SELECT 1 FROM collection_groups cg WHERE cg.collection_id=c.id)
    OR EXISTS (SELECT 1 FROM collection_groups cg JOIN user_groups ug ON ug.group_id=cg.group_id WHERE cg.collection_id=c.id AND ug.user_id=?) ORDER BY c.name`, user.id);
}
