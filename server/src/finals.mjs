// Final reports: the versions an editor approved and sent to the client, filed per client, channel and report type.
// Files and their extracted text stay on this server (data/finals). They are not part of the knowledge search used by
// chat. When an analyst drafts a new report for the same client, type and channel, Canopus learns from the latest
// finals: their slide structure, how the editor titled and phrased things, and what the editor changed from Canopus'
// draft. Only slide titles and short, masked excerpts go into that request. A final marked "server only" is never sent.
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.mjs';
import { db, one, all, run, id, now, sha256 } from './db.mjs';
import { extractText } from './knowledge.mjs';
import { openTemplate, describeTemplate } from './slides.mjs';
import { REPORT_TYPES, CHANNELS } from './report-types.mjs';

db.exec(`CREATE TABLE IF NOT EXISTS report_finals(id TEXT PRIMARY KEY, client_id TEXT NOT NULL, report_type TEXT NOT NULL, channel TEXT NOT NULL, period TEXT NOT NULL DEFAULT '',
  title TEXT NOT NULL, filename TEXT NOT NULL, size INTEGER, sha256 TEXT, text TEXT NOT NULL DEFAULT '', structure TEXT NOT NULL DEFAULT '[]', slides INTEGER NOT NULL DEFAULT 0,
  deck_id TEXT, learn INTEGER NOT NULL DEFAULT 1, note TEXT NOT NULL DEFAULT '', created_by TEXT, created INTEGER NOT NULL, updated INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS report_finals_client ON report_finals(client_id, report_type, channel, created);`);
try { db.exec(`ALTER TABLE report_finals ADD COLUMN submission_id TEXT`); } catch {}

const err = (status, message) => Object.assign(new Error(message), { status });
const DIR = () => { const d = path.join(config.dataDir, 'finals'); fs.mkdirSync(d, { recursive: true, mode: 0o700 }); return d; };
const TYPES = REPORT_TYPES.map(t => t.id), CHANS = CHANNELS.map(c => c.id);
const pickType = t => (TYPES.includes(t) ? t : 'weekly'), pickChan = c => (CHANS.includes(c) ? c : 'medmas');
const canManage = (user, f) => user.role === 'admin' || user.role === 'ultimate' || f.created_by === user.id;

const out = (f, user) => ({ id: f.id, clientId: f.client_id, reportType: f.report_type, channel: f.channel, period: f.period, title: f.title, filename: f.filename, size: f.size,
  slides: f.slides, deckId: f.deck_id, learn: !!f.learn, note: f.note, created: f.created, updated: f.updated,
  by: f.created_by ? (one(`SELECT COALESCE(NULLIF(name,''),email) n FROM users WHERE id=?`, f.created_by)?.n || '') : '', canManage: user ? canManage(user, f) : false });

export function listFinals(user, clientId) {
  const rows = clientId ? all(`SELECT * FROM report_finals WHERE client_id=? ORDER BY created DESC`, clientId) : all(`SELECT * FROM report_finals ORDER BY created DESC LIMIT 300`);
  return rows.map(f => out(f, user));
}
export function finalCounts() { return all(`SELECT client_id, COUNT(*) n FROM report_finals GROUP BY client_id`); }

export async function addFinal(user, { clientId, buf, filename, reportType, channel, period, title, deckId, learn, note, submissionId = null }) {
  if (!one(`SELECT 1 FROM clients WHERE id=?`, clientId)) throw err(404, 'Choose a client first.');
  if (!/\.(pptx|pdf|docx)$/i.test(filename || '')) throw err(415, 'Upload the final report as PowerPoint (.pptx), PDF or Word (.docx).');
  if (!buf?.length) throw err(400, 'The file is empty.');
  const hash = sha256(buf); const dup = one(`SELECT title FROM report_finals WHERE client_id=? AND sha256=?`, clientId, hash);
  if (dup && !submissionId) throw err(409, `This file is already filed as “${dup.title}”.`);
  let pages = [], structure = [];
  try { pages = await extractText(buf, filename); } catch (e) { throw err(422, 'Could not read this file: ' + e.message); }
  if (/\.pptx$/i.test(filename)) { try { structure = describeTemplate(await openTemplate(buf)).structure.map(s => ({ title: s.title || '', has: s.has || [] })); } catch {} }
  if (!structure.length && /\.pptx$/i.test(filename)) structure = pages.map(p => ({ title: String(p).split('\n')[1] || '', has: [] }));
  const deck = deckId ? one(`SELECT id FROM decks WHERE id=? AND (user_id=? OR client_id=?)`, String(deckId), user.id, clientId) : null;
  const fid = id(); fs.writeFileSync(path.join(DIR(), fid), buf, { mode: 0o600 });
  run(`INSERT INTO report_finals(id,client_id,report_type,channel,period,title,filename,size,sha256,text,structure,slides,deck_id,learn,note,created_by,created,updated,submission_id) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    fid, clientId, pickType(reportType), pickChan(channel), String(period || '').trim().slice(0, 80), String(title || filename.replace(/\.[^.]+$/, '')).trim().slice(0, 160) || 'Final report',
    String(filename).slice(0, 200), buf.length, hash, pages.join('\n\n').slice(0, 200000), JSON.stringify(structure.slice(0, 60)), /\.pptx$/i.test(filename) ? pages.length : 0,
    deck?.id || null, learn === false || learn === '0' ? 0 : 1, String(note || '').slice(0, 1000), user.id, now(), now(), submissionId);
  return out(one(`SELECT * FROM report_finals WHERE id=?`, fid), user);
}
function finalRow(fid) { const f = one(`SELECT * FROM report_finals WHERE id=?`, fid); if (!f) throw err(404, 'Final report not found'); return f; }
export function updateFinal(user, fid, b = {}) {
  const f = finalRow(fid); if (!canManage(user, f)) throw err(403, 'Only the person who filed it, Ultimate accounts and administrators can change it.');
  run(`UPDATE report_finals SET report_type=?, channel=?, period=?, title=?, learn=?, note=?, updated=? WHERE id=?`, b.reportType ? pickType(b.reportType) : f.report_type, b.channel ? pickChan(b.channel) : f.channel,
    b.period !== undefined ? String(b.period).trim().slice(0, 80) : f.period, b.title ? String(b.title).trim().slice(0, 160) : f.title, b.learn !== undefined ? (b.learn ? 1 : 0) : f.learn,
    b.note !== undefined ? String(b.note).slice(0, 1000) : f.note, now(), f.id);
  return out(finalRow(f.id), user);
}
export function deleteFinal(user, fid) {
  const f = finalRow(fid); if (!canManage(user, f)) throw err(403, 'Only the person who filed it, Ultimate accounts and administrators can delete it.');
  run(`DELETE FROM report_finals WHERE id=?`, f.id); try { fs.unlinkSync(path.join(DIR(), f.id)); } catch {}
  return f;
}
export function finalFile(fid) { const f = finalRow(fid); return { ...f, buf: fs.readFileSync(path.join(DIR(), f.id)) }; }
// Simple search on this server only (no AI): titles, periods and the text of the reports.
export function searchFinals(user, clientId, q) {
  const words = String(q || '').toLowerCase().split(/\s+/).filter(w => w.length > 1).slice(0, 6); if (!words.length) return [];
  return all(`SELECT * FROM report_finals WHERE client_id=? ORDER BY created DESC`, clientId).map(f => {
    const hay = `${f.title}\n${f.period}\n${f.text}`.toLowerCase(); if (!words.every(w => hay.includes(w))) return null;
    const i = hay.indexOf(words[0]); return { ...out(f, user), snippet: `${f.title}\n${f.period}\n${f.text}`.slice(Math.max(0, i - 120), i + 220).replace(/\s+/g, ' ').trim() };
  }).filter(Boolean).slice(0, 20);
}

// The finals a new report learns from: same client, same report type and channel first (latest first), then the same
// type on another channel. Only finals marked "learn" are used.
export function finalsFor(clientId, typeId, channel, limit = 2) {
  if (!clientId) return [];
  const t = pickType(typeId), ch = pickChan(channel);
  const same = all(`SELECT * FROM report_finals WHERE client_id=? AND report_type=? AND channel=? AND learn=1 ORDER BY created DESC LIMIT ?`, clientId, t, ch, limit);
  if (same.length) return same.map(f => ({ ...f, match: 'exact' }));
  return all(`SELECT * FROM report_finals WHERE client_id=? AND report_type=? AND learn=1 ORDER BY created DESC LIMIT ?`, clientId, t, limit).map(f => ({ ...f, match: 'type' }));
}
export function finalsPreview(clientId, typeId, channel) {
  const list = finalsFor(clientId, typeId, channel); const total = clientId ? one(`SELECT COUNT(*) n FROM report_finals WHERE client_id=? AND report_type=? AND learn=1`, clientId, pickType(typeId)).n : 0;
  return { total, using: list.map(f => ({ id: f.id, title: f.title, period: f.period, channel: f.channel, match: f.match, slides: f.slides })) };
}
const titlesOf = f => { try { return JSON.parse(f.structure || '[]').map(s => s.title).filter(Boolean); } catch { return []; } };
// What the editor changed: Canopus' draft slide titles next to the final ones, when the final was filed from a deck.
function editorChanges(f) {
  let draft = [], who = "Canopus' draft", tag = 'Canopus';
  const sub = f.submission_id ? one(`SELECT structure FROM report_submissions WHERE id=?`, f.submission_id) : null;
  if (sub) { try { draft = JSON.parse(sub.structure || '[]').map(s => s.title).filter(Boolean); who = "the analyst's version"; tag = 'analyst'; } catch {} }
  if (!draft.length && f.deck_id) { const d = one(`SELECT outline FROM decks WHERE id=?`, f.deck_id); try { draft = (JSON.parse(d?.outline || '{}').slides || []).map(s => s.title).filter(Boolean); } catch {} }
  if (!draft.length) return '';
  const fin = titlesOf(f); if (!draft.length || !fin.length) return '';
  const changed = []; for (let i = 0; i < Math.max(draft.length, fin.length) && changed.length < 20; i++) if ((draft[i] || '') !== (fin[i] || '')) changed.push(`- ${tag}: ${draft[i] || '(none)'}  →  editor: ${fin[i] || '(removed)'}`);
  return changed.length ? `\nWhat the editor changed from ${who} (learn these corrections):\n${changed.join('\n')}` : '';
}
// The note added to the drafting request. The caller masks it like the rest of the request.
export function finalsNote(clientId, typeId, channel) {
  const list = finalsFor(clientId, typeId, channel); if (!list.length) return { text: '', structure: '', used: [] };
  const parts = list.map((f, i) => {
    const titles = titlesOf(f);
    return `${i + 1}. "${f.title}"${f.period ? ` (${f.period})` : ''}${f.match === 'type' ? ` — ${CHANNELS.find(c => c.id === f.channel)?.label || f.channel}` : ''}${titles.length ? `\nIts slides:\n${titles.map((t, j) => `   ${j + 1}. ${t}`).join('\n')}` : ''}${editorChanges(f)}${f.note ? `\nEditor's note: ${f.note}` : ''}\nExcerpts (style examples):\n${String(f.text).slice(0, i === 0 ? 6000 : 2500)}`;
  });
  const text = `\n\nFinal reports for this client, as edited and approved by the editor (the team's best evidence of what this client receives). Follow their structure, slide titles, depth, tone and phrasing, and apply the editor's corrections. Use this period's data only — never copy their numbers, dates or events.\n${parts.join('\n\n')}`;
  const latest = list.find(f => f.match === 'exact') || null; const lt = latest ? titlesOf(latest) : [];
  return { text, structure: lt.length >= 3 ? lt.join('\n') : '', used: list.map(f => ({ id: f.id, title: f.title })) };
}
