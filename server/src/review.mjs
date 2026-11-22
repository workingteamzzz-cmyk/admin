// Analyst work and the editor stage.
// 1. An analyst submits a finished presentation (the deck Canopus built, or their own edited file). Every version is
//    kept here as the analyst's work — their knowledge, separate from URS and from final reports.
// 2. The submission waits for an editor (Editor, Ultimate or Admin). The editor sees the URS knowledge next to it and can
//    ask Canopus to check the work against a URS; then returns it with a note, or approves it.
// 3. Approving files the editor's final (or the analyst's version as is) in Final reports, so the next report learns
//    from it — including what the editor changed from the analyst's version.
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.mjs';
import { db, one, all, run, id, now, allowedCollections } from './db.mjs';
import { extractText } from './knowledge.mjs';
import { openTemplate, describeTemplate } from './slides.mjs';
import { getDeck, deckPptx, aiHelpers, STYLE_PROFILE_FIELDS } from './reports.mjs';
import { addFinal } from './finals.mjs';
import { clientBlock } from './persona.mjs';
import { SYSTEM_NOTE } from './redact.mjs';

db.exec(`CREATE TABLE IF NOT EXISTS report_submissions(id TEXT PRIMARY KEY, deck_id TEXT, client_id TEXT, report_type TEXT, channel TEXT, period TEXT NOT NULL DEFAULT '', title TEXT NOT NULL,
  analyst_id TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'review', version INTEGER NOT NULL DEFAULT 1, filename TEXT NOT NULL, size INTEGER, text TEXT NOT NULL DEFAULT '', structure TEXT NOT NULL DEFAULT '[]',
  slides INTEGER NOT NULL DEFAULT 0, note TEXT NOT NULL DEFAULT '', editor_id TEXT, editor_note TEXT NOT NULL DEFAULT '', urs_id TEXT, urs_check TEXT, final_id TEXT, created INTEGER NOT NULL, updated INTEGER NOT NULL, reviewed INTEGER);
CREATE INDEX IF NOT EXISTS report_submissions_status ON report_submissions(status, created);`);

const err = (status, message) => Object.assign(new Error(message), { status });
const DIR = () => { const d = path.join(config.dataDir, 'submissions'); fs.mkdirSync(d, { recursive: true, mode: 0o700 }); return d; };
export const isEditor = u => ['editor', 'ultimate', 'admin'].includes(u.role);
const nameOf = uid => (uid ? one(`SELECT COALESCE(NULLIF(name,''),email) n FROM users WHERE id=?`, uid)?.n || '' : '');
const STATUS = { review: 'Waiting for editor', returned: 'Returned to analyst', final: 'Approved — filed as final', superseded: 'Replaced by a newer version' };

const out = (s, user, full = false) => ({ id: s.id, deckId: s.deck_id, clientId: s.client_id, reportType: s.report_type, channel: s.channel, period: s.period, title: s.title, analystId: s.analyst_id,
  analyst: nameOf(s.analyst_id), status: s.status, statusLabel: STATUS[s.status] || s.status, version: s.version, filename: s.filename, size: s.size, slides: s.slides, note: s.note,
  editor: nameOf(s.editor_id), editorNote: s.editor_note, finalId: s.final_id, ursId: s.urs_id, created: s.created, updated: s.updated, reviewed: s.reviewed,
  canReview: isEditor(user) && s.analyst_id !== user.id || user.role === 'admin', mine: s.analyst_id === user.id,
  ...(full ? { structure: JSON.parse(s.structure || '[]'), text: s.text.slice(0, 20000), ursCheck: s.urs_check ? JSON.parse(s.urs_check) : null } : {}) });

async function readWork(buf, filename) {
  let pages = []; try { pages = await extractText(buf, filename); } catch (e) { throw err(422, 'Could not read this file: ' + e.message); }
  let structure = [];
  if (/\.pptx$/i.test(filename)) { try { structure = describeTemplate(await openTemplate(buf)).structure.map(s => ({ title: s.title || '', has: s.has || [] })); } catch {} }
  return { text: pages.join('\n\n').slice(0, 200000), structure: structure.slice(0, 60), slides: /\.pptx$/i.test(filename) ? pages.length : 0 };
}

// The analyst submits a deck: the PowerPoint Canopus builds from it, or the analyst's own edited file.
export async function submitWork(user, { deckId, buf, filename, note }) {
  const k = getDeck(user, deckId); // own decks only
  let file = buf?.length ? { buf, name: filename } : null;
  if (file && !/\.(pptx|pdf|docx)$/i.test(file.name || '')) throw err(415, 'Submit a PowerPoint (.pptx), PDF or Word (.docx) file.');
  if (!file) { const r = await deckPptx(user, deckId); file = { buf: r.buf, name: r.name }; }
  const w = await readWork(file.buf, file.name);
  const prev = one(`SELECT MAX(version) v FROM report_submissions WHERE deck_id=?`, k.id)?.v || 0;
  run(`UPDATE report_submissions SET status='superseded', updated=? WHERE deck_id=? AND status IN ('review','returned')`, now(), k.id);
  const sid = id(); fs.writeFileSync(path.join(DIR(), sid), file.buf, { mode: 0o600 });
  run(`INSERT INTO report_submissions(id,deck_id,client_id,report_type,channel,period,title,analyst_id,status,version,filename,size,text,structure,slides,note,created,updated) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    sid, k.id, k.clientId, k.reportType || 'adhoc', k.channel || 'medmas', k.period || '', k.title, user.id, 'review', prev + 1, String(file.name).slice(0, 200), file.buf.length, w.text, JSON.stringify(w.structure), w.slides, String(note || '').slice(0, 2000), now(), now());
  return out(one(`SELECT * FROM report_submissions WHERE id=?`, sid), user);
}

export function listSubmissions(user, { client, status } = {}) {
  const where = [], args = [];
  if (client) { where.push('client_id=?'); args.push(client); }
  if (status) { where.push('status=?'); args.push(status); }
  return all(`SELECT * FROM report_submissions ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY created DESC LIMIT 400`, ...args).map(s => out(s, user));
}
export function pendingCount(user) { return isEditor(user) ? one(`SELECT COUNT(*) n FROM report_submissions WHERE status='review' AND analyst_id IS NOT ?`, user.role === 'admin' ? '' : user.id).n : 0; }
function row(sid) { const s = one(`SELECT * FROM report_submissions WHERE id=?`, sid); if (!s) throw err(404, 'Submission not found'); return s; }
function reviewer(user, s) {
  if (!isEditor(user)) throw err(403, 'Only Editor, Ultimate and Administrator accounts can review analysts’ work.');
  if (s.analyst_id === user.id && user.role !== 'admin') throw err(403, 'Someone else has to review your own work.');
  if (s.status !== 'review') throw err(409, `This version is “${STATUS[s.status] || s.status}”, not waiting for an editor.`);
}

// URS knowledge for the editor: every URS with a style profile, the one picked for this review first.
export function ursFor(user) {
  return allowedCollections(user).filter(c => c.kind === 'senior' && c.style_profile && !c.local_only).map(c => {
    const p = JSON.parse(c.style_profile);
    return { id: c.id, name: c.name, reports: one(`SELECT COUNT(*) n FROM docs WHERE collection_id=? AND status='ready'`, c.id).n,
      fields: STYLE_PROFILE_FIELDS.filter(([k]) => p[k]).map(([k, label]) => ({ key: k, label, text: p[k] })), examples: p.examples || [] };
  });
}
export function getSubmission(user, sid) {
  const s = row(sid); const r = out(s, user, true);
  r.history = all(`SELECT * FROM report_submissions WHERE deck_id=? AND id<>? ORDER BY version DESC`, s.deck_id, s.id).map(x => out(x, user));
  r.urs = ursFor(user);
  return r;
}
export function submissionFile(sid) { const s = row(sid); return { buf: fs.readFileSync(path.join(DIR(), s.id)), name: s.filename }; }

// Canopus checks the analyst's work against a URS: where it departs from the URS pattern, slide by slide, with a suggestion.
export async function checkAgainstUrs(user, sid, ursId) {
  const s = row(sid); if (!isEditor(user)) throw err(403, 'Only editors can run the URS check.');
  const c = allowedCollections(user).find(x => x.id === ursId && x.kind === 'senior' && x.style_profile && !x.local_only); if (!c) throw err(404, 'URS not found');
  const { askJson, redactorFor, checkLimits, styleBlock, reportModel } = aiHelpers; checkLimits(user);
  const red = redactorFor(user, 'review:' + s.id); const model = reportModel(user, null, 'writing');
  const client = s.client_id ? one(`SELECT * FROM clients WHERE id=?`, s.client_id) : null;
  const system = `You are the editor of a media-monitoring and communications report. Compare the analyst's report with the URS (Ultimate Reference Style) of a senior below: language, slide titles, flow, depth of analysis, how findings and causes are phrased, recommendations. Do not judge the numbers. Reply with JSON only: {"summary": "2–3 sentences in the report's language", "score": 1-5 (how closely it follows the URS), "items": [{"slide": number or null, "issue": "what departs from the URS", "suggestion": "how to rewrite it, concretely, in the report's language"}]} — at most 12 items, most important first.${red.enabled ? '\n\n' + SYSTEM_NOTE : ''}`;
  const prompt = red.mask(`${clientBlock(client)}${styleBlock(c)}\n\nThe analyst's report "${s.title}" (version ${s.version}):\n${s.text.slice(0, 24000)}`);
  const raw = await askJson(user, model, system, prompt, 'review.urs_check', 4000, 'medium');
  const items = (Array.isArray(raw.items) ? raw.items : []).slice(0, 12).map(x => ({ slide: Number.isInteger(x?.slide) ? x.slide : null, issue: red.unmask(String(x?.issue || '')).slice(0, 600), suggestion: red.unmask(String(x?.suggestion || '')).slice(0, 900) })).filter(x => x.issue);
  const check = { urs: c.name, ursId: c.id, model: model.label, summary: red.unmask(String(raw.summary || '')).slice(0, 1200), score: Math.max(1, Math.min(5, Math.round(+raw.score || 0))) || null, items, at: now() };
  run(`UPDATE report_submissions SET urs_check=?, urs_id=?, updated=? WHERE id=?`, JSON.stringify(check), c.id, now(), s.id);
  return check;
}

export function returnSubmission(user, sid, { note }) {
  const s = row(sid); reviewer(user, s); if (!String(note || '').trim()) throw err(400, 'Write what the analyst should change.');
  run(`UPDATE report_submissions SET status='returned', editor_id=?, editor_note=?, reviewed=?, updated=? WHERE id=?`, user.id, String(note).slice(0, 4000), now(), now(), s.id);
  return out(row(s.id), user);
}
// Approve: file the editor's edited version (uploaded here) or the analyst's version as is.
export async function approveSubmission(user, sid, { buf, filename, title, period, note, learn }) {
  const s = row(sid); reviewer(user, s);
  const file = buf?.length ? { buf, name: filename } : { ...submissionFile(s.id) };
  if (!s.client_id) throw err(409, 'This presentation has no client. Open it, choose a client, and submit it again.');
  const f = await addFinal(user, { clientId: s.client_id, buf: file.buf, filename: file.name, reportType: s.report_type, channel: s.channel, period: period ?? s.period, title: title || s.title, deckId: s.deck_id, learn, note: note ?? '', submissionId: s.id });
  run(`UPDATE report_submissions SET status='final', editor_id=?, editor_note=?, final_id=?, reviewed=?, updated=? WHERE id=?`, user.id, String(note || '').slice(0, 4000), f.id, now(), now(), s.id);
  return { submission: out(row(s.id), user), final: f };
}
export function deleteSubmission(user, sid) {
  const s = row(sid);
  if (user.role !== 'admin' && !(s.analyst_id === user.id && s.status === 'review')) throw err(403, 'Only administrators can delete analysts’ work (you can withdraw your own while it waits for an editor).');
  run(`DELETE FROM report_submissions WHERE id=?`, s.id); try { fs.unlinkSync(path.join(DIR(), s.id)); } catch {}
  return s;
}
