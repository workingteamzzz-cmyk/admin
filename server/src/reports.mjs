// Reports: curated spreadsheets and presentation decks built on the organization's own templates.
// The AI only writes *plans* (which steps to run, what each slide says). The data work and the files are produced on
// this server. What the AI may see is limited: column profiles for planning, short texts for labelling, and summary
// tables plus a sample of non-personal columns for writing the slides. Masking applies to everything it receives.
import fs from 'node:fs';
import path from 'node:path';
import { config, ROOT } from './config.mjs';
import { db, one, all, run, id, now, sha256, getSettings, audit, allowedCollections } from './db.mjs';
import { Redactor, SYSTEM_NOTE } from './redact.mjs';
import { complete, reportModel, helperModel, limitProblem } from './ai.mjs';
import { search, sensitiveValues } from './knowledge.mjs';
import { loadWorkbook, profile, sanitizePlan, describe, runPlan, writeXlsx, reportSensitive, guessCol, OPS, FILTERS, CLEANS, DERIVES, MEASURES } from './tables.mjs';
import { openTemplate, describeTemplate, buildDeck, sanitizeOutline, SLIDE_KINDS, imgSize } from './slides.mjs';
import { CLIENT_FIELDS, parsePersona, analystBlock, clientBlock } from './persona.mjs';
import { logoInfo, recommendStyles, sanitizeStyle, STYLE_PRESETS } from './brand.mjs';
import { REPORT_TYPES, reportType, typeNote, CHANNELS, channelOf, adaptStructure } from './report-types.mjs';
import { finalsNote, finalsPreview } from './finals.mjs';

db.exec(`
CREATE TABLE IF NOT EXISTS report_templates(id TEXT PRIMARY KEY, name TEXT NOT NULL, owner_id TEXT, filename TEXT NOT NULL, size INTEGER, info TEXT NOT NULL, created INTEGER NOT NULL, created_by TEXT);
CREATE TABLE IF NOT EXISTS datasets(id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, name TEXT NOT NULL, filename TEXT NOT NULL, size INTEGER,
  sheet TEXT, instruction TEXT NOT NULL DEFAULT '', plan TEXT, log TEXT, rows INTEGER, result_rows INTEGER, created INTEGER NOT NULL, updated INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS decks(id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, title TEXT NOT NULL, template_id TEXT, datasets TEXT NOT NULL DEFAULT '[]',
  brief TEXT NOT NULL DEFAULT '', outline TEXT, notes TEXT, created INTEGER NOT NULL, updated INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS ai_tag_cache(key TEXT PRIMARY KEY, value TEXT NOT NULL, created INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS clients(id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', instructions TEXT NOT NULL DEFAULT '', collection_id TEXT, created_by TEXT, created INTEGER NOT NULL, updated INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS client_recipes(id TEXT PRIMARY KEY, client_id TEXT NOT NULL REFERENCES clients(id) ON DELETE CASCADE, name TEXT NOT NULL, plan TEXT NOT NULL, columns TEXT NOT NULL DEFAULT '[]', created_by TEXT, created INTEGER NOT NULL);
`);
for (const sql of ['ALTER TABLE collections ADD COLUMN style_profile TEXT', 'ALTER TABLE collections ADD COLUMN style_updated INTEGER', 'ALTER TABLE decks ADD COLUMN channel TEXT', 'ALTER TABLE decks ADD COLUMN reference TEXT', 'ALTER TABLE decks ADD COLUMN report_type TEXT', 'ALTER TABLE decks ADD COLUMN period TEXT', 'ALTER TABLE decks ADD COLUMN structure TEXT', "ALTER TABLE clients ADD COLUMN structures TEXT NOT NULL DEFAULT '{}'", "ALTER TABLE clients ADD COLUMN logos TEXT NOT NULL DEFAULT '[]'", 'ALTER TABLE clients ADD COLUMN style TEXT', 'ALTER TABLE decks ADD COLUMN style TEXT', "ALTER TABLE decks ADD COLUMN images TEXT NOT NULL DEFAULT '[]'", 'ALTER TABLE report_templates ADD COLUMN client_id TEXT', 'ALTER TABLE datasets ADD COLUMN client_id TEXT', 'ALTER TABLE decks ADD COLUMN client_id TEXT', 'ALTER TABLE clients ADD COLUMN persona TEXT', "ALTER TABLE datasets ADD COLUMN files TEXT NOT NULL DEFAULT '[]'"]) { try { db.exec(sql); } catch {} }
try { db.exec(`UPDATE collections SET kind='client' WHERE kind='admin' AND id IN (SELECT collection_id FROM clients)`); } catch {}
const DIR = path.join(config.dataDir, 'reports');
fs.mkdirSync(path.join(DIR, 'datasets'), { recursive: true, mode: 0o700 });
fs.mkdirSync(path.join(DIR, 'templates'), { recursive: true, mode: 0o700 });
fs.mkdirSync(path.join(DIR, 'images'), { recursive: true, mode: 0o700 });
fs.mkdirSync(path.join(DIR, 'clients'), { recursive: true, mode: 0o700 });
const DEFAULT_TEMPLATE = path.join(ROOT, 'assets', 'default-template.pptx');
const err = (status, message) => Object.assign(new Error(message), { status });
const dsDir = d => path.join(DIR, 'datasets', d);

/* ================= clients ================= */
// A client is the team's folder for one customer: its templates, saved curation recipes, instructions (voice, key
// messages, sensitivities) and a knowledge collection for its documents. Clients are shared by the whole team.
const clientRow = cid => { if (!cid) return null; const c = one(`SELECT * FROM clients WHERE id=?`, cid); if (!c) throw err(404, 'Client not found'); return c; };
export function listClients() {
  return all(`SELECT c.*, (SELECT COUNT(*) FROM report_templates t WHERE t.client_id=c.id) templates, (SELECT COUNT(*) FROM client_recipes r WHERE r.client_id=c.id) recipes,
    (SELECT COUNT(*) FROM docs d WHERE d.collection_id=c.collection_id) docs FROM clients c ORDER BY c.name COLLATE NOCASE`).map(c => ({ ...c, structures: JSON.parse(c.structures || '{}'), persona: parsePersona(c.persona, CLIENT_FIELDS), logos: JSON.parse(c.logos || '[]'), style: c.style ? JSON.parse(c.style) : null,
    recipeList: all(`SELECT id,name,columns,created FROM client_recipes WHERE client_id=? ORDER BY created DESC`, c.id).map(r => ({ ...r, columns: JSON.parse(r.columns) })) }));
}
export function saveClient(user, cid, { name, description, instructions, persona }) {
  const pj = JSON.stringify(parsePersona(persona || {}, CLIENT_FIELDS));
  const nm = String(name || '').trim().slice(0, 120); if (!nm) throw err(400, 'Give the client a name.');
  if (one(`SELECT 1 FROM clients WHERE name=? COLLATE NOCASE AND id IS NOT ?`, nm, cid || null)) throw err(409, 'A client with this name already exists.');
  if (cid) { clientRow(cid); run(`UPDATE clients SET name=?, description=?, instructions=?, persona=?, updated=? WHERE id=?`, nm, String(description || '').slice(0, 500), String(instructions || '').slice(0, 8000), pj, now(), cid); return cid; }
  const nid = id(), col = id();
  run(`INSERT INTO collections(id,name,description,created,kind) VALUES(?,?,?,?,?)`, col, `Klien · ${nm}`.slice(0, 120), `Documents for client ${nm}: earlier reports, briefs, guidelines.`, now(), 'client');
  run(`INSERT INTO clients(id,name,description,instructions,collection_id,created_by,created,updated,persona) VALUES(?,?,?,?,?,?,?,?,?)`, nid, nm, String(description || '').slice(0, 500), String(instructions || '').slice(0, 8000), col, user.id, now(), now(), pj);
  return nid;
}
export function deleteClient(user, cid) {
  const c = clientRow(cid); if (user.role !== 'admin' && c.created_by !== user.id) throw err(403, 'Only an administrator or the person who created this client can delete it.');
  for (const t of ['report_templates', 'datasets', 'decks']) run(`UPDATE ${t} SET client_id=NULL WHERE client_id=?`, cid);
  run(`DELETE FROM clients WHERE id=?`, cid); return c; // the knowledge collection and its documents are kept
}
export function addRecipe(user, cid, { name, plan, columns }) {
  clientRow(cid); const p = sanitizePlan(plan); if (!p.steps.length) throw err(400, 'The plan has no steps.');
  const rid = id(); run(`INSERT INTO client_recipes(id,client_id,name,plan,columns,created_by,created) VALUES(?,?,?,?,?,?,?)`, rid, cid, String(name || 'Recipe').trim().slice(0, 120) || 'Recipe', JSON.stringify(p), JSON.stringify((columns || []).slice(0, 200).map(String)), user.id, now());
  return rid;
}
export function getRecipe(rid) { const r = one(`SELECT * FROM client_recipes WHERE id=?`, rid); if (!r) throw err(404, 'Recipe not found'); const plan = JSON.parse(r.plan); return { ...r, plan: { ...plan, steps: plan.steps.map(x => ({ ...x, text: describe(x) })) }, columns: JSON.parse(r.columns) }; }
const mayManage = (user, createdBy) => user.role === 'admin' || user.role === 'ultimate' || createdBy === user.id;
export function deleteRecipe(user, rid) { const r = one(`SELECT * FROM client_recipes WHERE id=?`, rid); if (!r) throw err(404, 'Recipe not found'); if (!mayManage(user, r.created_by)) throw err(403, 'Only the person who saved this recipe, Ultimate accounts and administrators can delete it.'); run(`DELETE FROM client_recipes WHERE id=?`, rid); return r; }

/* ================= templates ================= */
// No built-in template is offered: every deck uses a template someone uploaded (usually a client's). "plain" is only a
// neutral fallback layout for drafts made before any template exists.
const PLAIN = path.join(ROOT, 'assets', 'default-template.pptx');
async function templateInfo(buf) { return describeTemplate(await openTemplate(buf)); }
export async function listTemplates(user) {
  const rows = all(`SELECT t.id,t.name,t.owner_id,t.filename,t.size,t.info,t.created,t.client_id,c.name client FROM report_templates t LEFT JOIN clients c ON c.id=t.client_id WHERE t.owner_id IS NULL OR t.owner_id=? ORDER BY c.name COLLATE NOCASE, t.created DESC`, user.id);
  return rows.map(r => ({ id: r.id, name: r.name, filename: r.filename, size: r.size, created: r.created, clientId: r.client_id, client: r.client, scope: r.owner_id ? 'personal' : 'team', mine: r.owner_id === user.id, info: JSON.parse(r.info) }));
}
function templateRow(user, tid) {
  if (!tid || tid === 'plain' || tid === 'default' || String(tid).startsWith('doc:')) return null;
  const r = one(`SELECT * FROM report_templates WHERE id=? AND (owner_id IS NULL OR owner_id=?)`, tid, user.id);
  if (!r) throw err(404, 'Template not found'); return r;
}
function templateBuf(user, tid) { if (String(tid || '').startsWith('doc:')) return referenceDoc(user, tid.slice(4)).buf; const r = templateRow(user, tid); return fs.readFileSync(r ? path.join(DIR, 'templates', r.id + '.pptx') : PLAIN); }
let plainInfo;
async function templateDesc(user, tid) { if (String(tid || '').startsWith('doc:')) { const d = referenceDoc(user, tid.slice(4), true); return { name: d.title, info: describeTemplate(await openTemplate(d.buf)) }; } const r = templateRow(user, tid); if (!r) { plainInfo ??= await templateInfo(fs.readFileSync(PLAIN)); return { name: 'Plain layout', info: plainInfo }; } return { name: r.name, info: JSON.parse(r.info) }; }
export async function addTemplate(user, { filename, buf, name, clientId, personal }) {
  if (!/\.(pptx|potx)$/i.test(filename)) throw err(415, 'Upload a PowerPoint file (.pptx or .potx).');
  if (clientId) clientRow(clientId);
  let info; try { info = await templateInfo(buf); } catch (e) { throw err(422, 'This file could not be read as a PowerPoint template: ' + e.message); }
  if (!info.layouts.length) throw err(422, 'This file has no slide layouts.');
  const tid = id(); fs.writeFileSync(path.join(DIR, 'templates', tid + '.pptx'), buf, { mode: 0o600 });
  run(`INSERT INTO report_templates(id,name,owner_id,filename,size,info,created,created_by,client_id) VALUES(?,?,?,?,?,?,?,?,?)`, tid, String(name || filename.replace(/\.(pptx|potx)$/i, '')).slice(0, 120), personal ? user.id : null, filename, buf.length, JSON.stringify(info), now(), user.id, clientId || null);
  return { id: tid, info };
}
// Templates can be moved to another client or renamed; any client may *use* any team template.
export function updateTemplate(user, tid, { name, clientId }) {
  const r = templateRow(user, tid); if (!r) throw err(404, 'Template not found'); if (clientId) clientRow(clientId);
  if (!r.owner_id && !mayManage(user, r.created_by)) throw err(403, 'Only the person who uploaded this template, Ultimate accounts and administrators can change it.');
  run(`UPDATE report_templates SET name=?, client_id=? WHERE id=?`, String(name ?? r.name).trim().slice(0, 120) || r.name, clientId === undefined ? r.client_id : clientId || null, tid);
}
export function deleteTemplate(user, tid) {
  const r = one(`SELECT * FROM report_templates WHERE id=?`, tid);
  if (!r || (r.owner_id && r.owner_id !== user.id)) throw err(404, 'Template not found');
  if (!r.owner_id && user.role !== 'admin' && r.created_by !== user.id) throw err(403, 'Only an administrator or the person who uploaded it can delete this template.');
  fs.rmSync(path.join(DIR, 'templates', r.id + '.pptx'), { force: true }); run(`DELETE FROM report_templates WHERE id=?`, r.id); return r;
}
export function templateFile(user, tid) { const r = templateRow(user, tid); if (!r) throw err(404, 'Template not found'); return { buf: fs.readFileSync(path.join(DIR, 'templates', r.id + '.pptx')), name: r.filename }; }

/* ================= datasets ================= */
const sourceFile = d => path.join(dsDir(d.id), 'source' + path.extname(d.filename).toLowerCase());
// Large files (50,000+ rows) are parsed once; the parsed tables are kept next to the upload.
// A dataset can hold several files (e.g. ONLINE and PRINTED exports). They are merged into one table: columns are
// matched by name (case-insensitive), and a column records each row's source label (e.g. MEDIA TYPE: Online / Cetak).
export const sourceLabel = name => (/print|cetak|koran|newspaper/i.test(name) ? 'Cetak' : /online|portal|web/i.test(name) ? 'Online' : /\btv\b|televisi|broadcast/i.test(name) ? 'TV' : /radio/i.test(name) ? 'Radio' : /medsos|social|sosmed|twitter|instagram|tiktok|facebook|youtube/i.test(name) ? 'Media Sosial' : name.replace(/\.(xlsx|csv|tsv)$/i, '').slice(0, 40));
const filesOf = d => { const f = JSON.parse(d.files || '[]'); return f.length ? f : [{ name: d.filename, label: sourceLabel(d.filename), path: path.basename(sourceFile(d)) }]; };
async function loadSource(d) {
  const cache = path.join(dsDir(d.id), 'source.json');
  if (fs.existsSync(cache)) return JSON.parse(fs.readFileSync(cache, 'utf8'));
  const files = filesOf(d); const parsed = [];
  for (const f of files) parsed.push({ f, sheets: await loadWorkbook(fs.readFileSync(path.join(dsDir(d.id), f.path)), f.name) });
  let sheets = parsed[0].sheets;
  if (parsed.length > 1) {
    const labelCol = d.label_column || 'MEDIA TYPE'; const cols = [labelCol];
    // Same meaning, different names across exports (Date/Tanggal, Title/Judul, Content/Isi, URL/Link, Media/Nama Media) → one column.
    const kinds = ['date', 'title', 'content', 'url', 'media']; const kindOf = c => kinds.find(k => guessCol([c], k) === 0);
    const key = c => { const k = kindOf(c); return k ? 'kind:' + k : String(c).trim().toLowerCase().replace(/\s+/g, ' '); };
    const mains = parsed.map(p => ({ f: p.f, t: [...p.sheets].sort((a, b) => b.rows.length - a.rows.length)[0] }));
    for (const m of mains) for (const c of m.t.columns) if (!cols.some(x => key(x) === key(c))) cols.push(c);
    const rows = mains.flatMap(m => { const idx = cols.map(c => m.t.columns.findIndex(x => key(x) === key(c))); return m.t.rows.map(r => idx.map((i, k) => (k === 0 ? m.f.label : i >= 0 ? r[i] : ''))); });
    sheets = [{ name: `Gabungan (${mains.length} file)`, columns: cols, rows, skipped: 0, merged: mains.map(m => ({ file: m.f.name, label: m.f.label, rows: m.t.rows.length })) }, ...mains.map(m => ({ ...m.t, name: `${m.f.label} · ${m.t.name}` }))];
  }
  fs.writeFileSync(cache, JSON.stringify(sheets), { mode: 0o600 }); return sheets;
}
export async function addDatasetFile(user, did, { filename, buf, label }) {
  const d = ownDataset(user, did); if (!/\.(xlsx|csv|tsv)$/i.test(filename)) throw err(415, 'Upload an Excel (.xlsx) or CSV file.');
  try { if (!(await loadWorkbook(buf, filename)).length) throw new Error('No table found'); } catch (e) { throw err(422, 'This file could not be read: ' + e.message); }
  const files = filesOf(d); const fpath = `source-${files.length + 1}${path.extname(filename).toLowerCase()}`;
  fs.writeFileSync(path.join(dsDir(did), fpath), buf, { mode: 0o600 }); files.push({ name: filename, label: String(label || sourceLabel(filename)).slice(0, 40), path: fpath });
  run(`UPDATE datasets SET files=?, sheet=NULL, size=size+?, updated=? WHERE id=?`, JSON.stringify(files), buf.length, now(), did); fs.rmSync(path.join(dsDir(did), 'source.json'), { force: true });
  const sheets = await loadSource({ ...d, files: JSON.stringify(files) }); run(`UPDATE datasets SET sheet=?, rows=? WHERE id=?`, sheets[0].name, sheets[0].rows.length, did);
  return getDataset(user, did);
}
export function relabelFile(user, did, { index, label }) {
  const d = ownDataset(user, did); const files = filesOf(d); if (!files[index]) throw err(404, 'File not found');
  files[index].label = String(label || '').trim().slice(0, 40) || files[index].label; run(`UPDATE datasets SET files=?, updated=? WHERE id=?`, JSON.stringify(files), now(), did); fs.rmSync(path.join(dsDir(did), 'source.json'), { force: true });
}
function ownDataset(user, did) { const d = one(`SELECT * FROM datasets WHERE id=? AND user_id=?`, did, user.id); if (!d) throw err(404, 'Dataset not found'); return d; }
const extraCols = () => getSettings().redaction.columns || [];
const preview = (t, n = 8) => ({ name: t.name, columns: t.columns, rows: t.rows.length, preview: t.rows.slice(0, n), skipped: t.skipped || 0, personal: t.columns.filter(c => reportSensitive(c, extraCols())) });

export async function addDataset(user, { filename, buf, clientId }) {
  if (clientId) clientRow(clientId);
  if (!/\.(xlsx|csv|tsv)$/i.test(filename)) throw err(415, 'Upload an Excel (.xlsx) or CSV file.');
  let sheets; try { sheets = await loadWorkbook(buf, filename); } catch (e) { throw err(422, 'This file could not be read: ' + e.message); }
  if (!sheets.length) throw err(422, 'No table found in this file.');
  const did = id(); fs.mkdirSync(dsDir(did), { recursive: true, mode: 0o700 });
  const d = { id: did, filename };
  fs.writeFileSync(sourceFile(d), buf, { mode: 0o600 }); fs.writeFileSync(path.join(dsDir(did), 'source.json'), JSON.stringify(sheets), { mode: 0o600 });
  const main = [...sheets].sort((a, b) => b.rows.length - a.rows.length)[0];
  run(`INSERT INTO datasets(id,user_id,name,filename,size,sheet,rows,created,updated,client_id,files) VALUES(?,?,?,?,?,?,?,?,?,?,?)`, did, user.id, filename.replace(/\.(xlsx|csv|tsv)$/i, '').slice(0, 120), filename, buf.length, main.name, main.rows.length, now(), now(), clientId || null, JSON.stringify([{ name: filename, label: sourceLabel(filename), path: path.basename(sourceFile(d)) }]));
  return getDataset(user, did);
}
export function listDatasets(user) {
  return all(`SELECT id,name,filename,size,sheet,rows,result_rows,created,updated,client_id clientId,(plan IS NOT NULL) planned,(log IS NOT NULL) curated FROM datasets WHERE user_id=? ORDER BY updated DESC`, user.id);
}
function readResult(did) { const f = path.join(dsDir(did), 'result.json'); return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : null; }
export async function getDataset(user, did) {
  const d = ownDataset(user, did); const sheets = await loadSource(d); const res = readResult(did);
  const plan = d.plan ? JSON.parse(d.plan) : null;
  return { id: d.id, clientId: d.client_id, files: filesOf(d).map(({ path: _p, ...f }) => f), name: d.name, filename: d.filename, size: d.size, sheet: d.sheet, instruction: d.instruction, created: d.created, updated: d.updated,
    sheets: sheets.map(t => preview(t)), plan: plan && { ...plan, steps: plan.steps.map(s => ({ ...s, text: describe(s) })) }, log: d.log ? JSON.parse(d.log) : null,
    result: res && { removed: res.removed?.length || 0, initial: res.initial, removedBy: res.removedBy, table: { name: 'Data', columns: res.table.columns, rows: res.table.rows.length, preview: res.table.rows.slice(0, 50) }, summaries: res.summaries.map(s => ({ ...s, rows: s.rows.slice(0, 200), total: s.rows.length })) } };
}
export function renameDataset(user, did, name) { ownDataset(user, did); run(`UPDATE datasets SET name=?, updated=? WHERE id=?`, String(name || '').trim().slice(0, 120) || 'Dataset', now(), did); }
export function deleteDataset(user, did) { const d = ownDataset(user, did); fs.rmSync(dsDir(d.id), { recursive: true, force: true }); run(`DELETE FROM datasets WHERE id=?`, d.id); return d; }
const pickSheet = (sheets, name) => sheets.find(s => s.name === name) || [...sheets].sort((a, b) => b.rows.length - a.rows.length)[0];

/* ---------- AI helpers ---------- */
function redactorFor(user, scope) { const s = getSettings(); return new Redactor({ userId: user.id, chatId: scope, enabled: s.redaction.enabled, terms: s.redaction.terms, values: s.redaction.enabled ? sensitiveValues() : [] }); }
function checkLimits(user) { const lim = limitProblem(user); if (lim && lim.code !== 'rate') throw err(402, lim.message); }
function parseJson(text) {
  const t = String(text || '').replace(/^```(?:json)?\s*|\s*```$/g, '');
  const a = t.indexOf('{'), b = t.lastIndexOf('}'); if (a < 0 || b < a) throw new Error('no JSON object');
  return JSON.parse(t.slice(a, b + 1));
}
async function askJson(user, model, system, prompt, purpose, maxTokens, effort = 'medium', images = []) {
  let out = await complete(user, model, system, prompt, purpose, maxTokens, effort, images);
  try { return parseJson(out); } catch {
    out = await complete(user, model, system, prompt + '\n\nIMPORTANT: your previous answer was not valid JSON. Reply with one valid JSON object only, no other text.', purpose, maxTokens, effort, images);
    try { return parseJson(out); } catch { throw err(502, 'The AI did not return a usable plan. Try again or rephrase the instruction.'); }
  }
}
const unmaskDeep = (red, v) => (typeof v === 'string' ? red.unmask(v) : Array.isArray(v) ? v.map(x => unmaskDeep(red, x)) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, unmaskDeep(red, x)])) : v);

const PLAN_SYSTEM = `You plan data-curation steps for spreadsheets used in reports (typically media monitoring: news coverage with date, media outlet, headline, summary, link, spokesperson, sentiment, issue, AVE/PR value, reach). You never see the rows; you get a profile of each column (type, counts, common values, a few examples). Canopus runs your plan on the full data on its own server.

Reply with ONE JSON object only:
{"title": short name for the curated dataset, "explanation": 2–4 sentences in the user's language on what the plan does and any assumption, "steps": [ ... ]}

Steps run in order. Use column names EXACTLY as profiled (after a rename, use the new name). Available steps:
- {"op":"clean","columns":[...] or [] for all,"actions":[${CLEANS.map(c => `"${c}"`).join(',')}]}  trim=collapse spaces; empty_words=blank out "-", "N/A", "null"; number=parse "1.234.567"/"Rp 2.000"; date=normalize dates to YYYY-MM-DD; domain=URL→website
- {"op":"replace","column":c,"pairs":[["from","to"],...],"match":"exact"|"contains"}  standardize spellings (case-insensitive), e.g. outlet name variants
- {"op":"dedupe","columns":[...]}  remove duplicate rows by these columns ([] = identical rows); for news use the link, or headline+outlet
- {"op":"filter","column":c,"cmp":one of ${FILTERS.join('|')},"value":v,"value2":v2,"values":[...]}  keep matching rows
- {"op":"fill","column":c,"method":"value"|"previous","value":v}
- {"op":"derive","column":new name,"from":c,"fn":one of ${DERIVES.join('|')},"bins":[numbers for bucket]}  e.g. year_month or week from a date, domain from a link
- {"op":"select","columns":[...]} / {"op":"drop","columns":[...]} / {"op":"rename","from":c,"to":new} / {"op":"sort","column":c,"dir":"asc"|"desc"}
- {"op":"ai_tag","column":label column,"from":[text columns],"labels":[allowed labels] or [] to let AI propose 4–8 categories,"instruction":what the label means,"only_empty":true|false}  an AI reads each row's text and assigns one label (e.g. sentiment Positif/Netral/Negatif, issue/topic, tone). Costs AI tokens per row: use only when the user wants labels that are missing or incomplete; use only_empty:true to keep existing labels.
- {"op":"dedupe_news","url":c,"title":c,"media":c,"content":c,"near":0.9}  layered news duplicates: same URL (amp/mobile/utm variants), same title in the same media, identical content in the same media, near-identical content (≥near) in the same media and date. The same story in DIFFERENT media is not a duplicate. Removed rows are logged. Prefer this over "dedupe" for news.
- {"op":"ai_filter","from":[text columns],"instruction":what belongs (the client and its derivatives: officials, units, programs),"labels":["Relevan","Noise: <reason>",...],"keep":"Relevan"}  removes noise with AI and logs the reason (e.g. unrelated, mentioned only under "Baca juga", other countries' ministries, portal pages).
- {"op":"keywords","column":new column,"from":[text columns],"terms":["Label=alias1|alias2",...],"none":"-"}  detects names/programs in the text (whole words, case-insensitive, spaces optional); several → comma-separated. No AI, exact.
- {"op":"ai_normalize","column":c,"instruction":...,"split":","}  AI cleans names in an entity column (slugs, partial names, fragments, junk → "-").
- {"op":"fill","columns":[] for all,"value":"-"}  fill empty cells everywhere.
- ai_tag extra options: "consistent_by": title column → the same story across outlets gets one label (majority); "seed":"client" → use the client persona's issue list; "allow_new": true → AI may add a new specific issue when none fits; "max_labels": N (e.g. 40) with "labels": [] → AI builds an issue taxonomy from all texts. For long texts include both title and content columns in "from".
- summary extra options: "top_per_group": true → "top" applies within each value of the first group_by column (e.g. top 10 media per media type); "explode": true → cells with several comma-separated values (e.g. programs) are counted per value.
- {"op":"summary","name":sheet name,"group_by":[up to 3 columns],"measures":[{"fn":one of ${MEASURES.join('|')},"column":c,"as":label}],"sort_by":output column,"dir":"desc","top":N,"total":true|false}  percent = share of rows
- {"op":"pivot","name":sheet name,"rows":c,"columns":c,"fn":"count"|"sum"|"avg","value":c,"total":true}  e.g. date × sentiment

Media monitoring standard (follow it when the data is news coverage, adapting to the columns and the client persona): 1) clean: strip_html on content, trim, empty_words; 2) dedupe_news; 3) ai_filter noise using the client's names, officials, units and programs from the persona; 4) ai_tag SENTIMENT from the client's point of view using the persona's sentiment rules (title + content, consistent_by title, labels Positif/Netral/Negatif); 5) ai_tag SEKTOR with the persona's sectors as fixed labels; 6) ai_tag ISU with seed "client" and allow_new true when the persona has an issue list, otherwise labels [] with max_labels 40–60 (representative names, similar issues merged); 7) keywords for the persona's programs; 8) ai_normalize entity columns (person, organization, influencer); 9) fill all empty cells with "-"; 10) summaries: sentiment per media type, sector × sentiment, program × sentiment (explode), issue × sentiment, top media per media type (top_per_group), daily trend pivot date × sentiment, top spokespersons. Use UPPERCASE names for new columns (MEDIA TYPE, SENTIMENT, SEKTOR, ISU, PROGRAM). A merged multi-file dataset already has a source column such as MEDIA TYPE.
Guidelines: start with cleaning (trim, empty_words; date/number where the profile shows mixed formats); standardize obvious variants seen in the common values; remove duplicates; then the user's filters; then summaries useful for the report (for media monitoring: coverage per outlet, sentiment share, issues, daily/weekly trend, top spokespeople, AVE per outlet). Name summaries in the user's language. Keep the plan focused: 4–14 steps. Columns marked "personal" contain personal data: you may filter, dedupe or count by them, but never output their values.`;

export async function planDataset(user, did, { instruction, model: requested, sheet, reportType: rt, channel }) {
  checkLimits(user);
  const d = ownDataset(user, did); const sheets = await loadSource(d); const t = pickSheet(sheets, sheet || d.sheet);
  const red = redactorFor(user, 'report:' + did); const model = reportModel(user, requested, 'writing');
  const prof = profile(t, extraCols());
  const ctx = [clientBlock(d.client_id ? one(`SELECT * FROM clients WHERE id=?`, d.client_id) : null), analystBlock(user)].filter(Boolean).join('\n\n');
  const chn = channelOf(channel); const tp = reportType(rt); const tnote = `${chn.note}${chn.id === 'medsos' ? ' Use a PLATFORM column (from the file, the URL domain or a source column); reposts by different accounts are separate exposures, not duplicates; detect account categories when useful.' : ''}\n` + (tp ? `${typeNote(tp)}${tp.derive ? ` For the trend summary, derive a period column from the date with fn "${tp.derive}" and pivot it by sentiment.` : ''}\n\n` : '');
  const prompt = red.mask(`${ctx ? ctx + '\n\n' : ''}${tnote}Sheets in the file: ${sheets.map(s => `"${s.name}" (${s.rows.length} rows)`).join(', ')}. Planning for sheet "${t.name}".\n\nColumn profile:\n${JSON.stringify(prof, null, 1)}\n\nUser's instruction:\n${String(instruction || 'Clean this data and prepare the usual summaries for a report.').slice(0, 4000)}`);
  const raw = await askJson(user, model, PLAN_SYSTEM + (red.enabled ? '\n\n' + SYSTEM_NOTE : ''), prompt, 'report.plan', 6000, 'medium');
  const plan = sanitizePlan(unmaskDeep(red, raw));
  run(`UPDATE datasets SET instruction=?, plan=?, sheet=?, updated=? WHERE id=?`, String(instruction || '').slice(0, 4000), JSON.stringify(plan), t.name, now(), did);
  return { plan: { ...plan, steps: plan.steps.map(s => ({ ...s, text: describe(s) })) }, explanation: red.unmask(String(raw.explanation || '')).slice(0, 1500), model: { id: model.id, label: model.label } };
}

// Labels short texts in batches with the cheapest model. Results are cached by (labels, instruction, text).
const TAG_BATCH = 80, TAG_PARALLEL = 6;
// Labels from the client persona's issue list ("Daftar isu acuan"): one per line or separated by ';', sector headers ignored.
export function clientIssues(client) {
  const txt = parsePersona(client?.persona, CLIENT_FIELDS).issues || '';
  return [...new Set(txt.split(/[\n;]+/).map(x => x.replace(/^\s*[-•*\d.)]+\s*/, '').trim()).filter(x => x && !/:\s*$/.test(x) && x.length <= 90))];
}
function makeTagger(user, did, progress = () => {}, client = null) {
  const red = redactorFor(user, 'report:' + did); let model;
  return async (texts, labels, instruction, opts = {}) => {
    model ??= helperModel(user); checkLimits(user);
    let use = labels;
    const seed = opts.seed === 'client' ? clientIssues(client) : [];
    if (!use.length && seed.length && !opts.allowNew) use = seed;
    if (!use.length && opts.maxLabels > 8) { // build an issue taxonomy from all texts: propose per chunk, then merge similar issues
      const uniq = [...new Set(texts.filter(Boolean).map(x => x.slice(0, 220)))]; const step = Math.max(1, Math.floor(uniq.length / 1200)); const pool = uniq.filter((_, i) => i % step === 0).slice(0, 1200);
      const proposals = [];
      for (let i = 0; i < pool.length; i += 300) {
        const r = await askJson(user, model, `You read news items and list the distinct issues they cover${instruction ? ` (${instruction})` : ''}. An issue name is short (2–8 words), specific and representative of the content, in the texts' language. Merge items about the same issue.${seed.length ? ` Use these existing issue names exactly when they fit: ${seed.join('; ')}.` : ''} Reply with JSON only: {"issues":[...]}.`, pool.slice(i, i + 300).map((x, k) => `${k + 1}. ${red.mask(x)}`).join('\n'), 'report.tag', 3000, 'low');
        proposals.push(...(Array.isArray(r.issues) ? r.issues : []).map(x => String(x).trim()).filter(Boolean));
      }
      const merged = await askJson(user, model, `Consolidate these issue names into at most ${opts.maxLabels} distinct issues: merge duplicates and near-synonyms, keep names short, specific and representative.${seed.length ? ' Prefer the existing names from the reference list when they fit.' : ''} Always include a catch-all such as "Isu Lainnya". Reply with JSON only: {"issues":[...]}.`, `${seed.length ? `Reference list: ${seed.join('; ')}\n\n` : ''}Proposed: ${[...new Set(proposals)].join('; ')}`, 'report.tag', 4000, 'low');
      use = (Array.isArray(merged.issues) ? merged.issues : []).map(x => String(x).trim().slice(0, 90)).filter(Boolean).slice(0, opts.maxLabels);
      if (!use.length) throw new Error('The AI could not build an issue list');
    }
    if (!use.length && seed.length) use = seed;
    if (!use.length) {
      const sample = [...new Set(texts.filter(Boolean))].slice(0, 80).map((x, i) => `${i + 1}. ${red.mask(x.slice(0, 300))}`).join('\n');
      const r = await askJson(user, model, `You design a small set of categories for labelling texts${instruction ? ` (${instruction})` : ''}. Reply with JSON only: {"labels":[4–8 short category names, 1–4 words each, in the texts' language]}.`, sample, 'report.tag', 1000, 'low');
      use = (Array.isArray(r.labels) ? r.labels : []).map(x => String(x).trim().slice(0, 60)).filter(Boolean).slice(0, 10);
      if (!use.length) throw new Error('The AI could not propose categories');
      if (!use.some(l => /^(lainnya|other)$/i.test(l))) use.push('Lainnya');
    }
    const keyOf = x => sha256(JSON.stringify([use, instruction, x]));
    const values = texts.map(x => (x ? one(`SELECT value FROM ai_tag_cache WHERE key=?`, keyOf(x))?.value ?? null : ''));
    const todo = [...new Set(texts.filter((x, i) => x && values[i] == null))];
    const norm = new Map(use.map(l => [l.toLowerCase(), l]));
    const allowNew = !!opts.allowNew; const added = [];
    const system = `You label texts${instruction ? `: ${instruction}` : ''}. Allowed labels: ${use.map(l => `"${l}"`).join(', ')}. Choose exactly one allowed label per text.${allowNew ? ' Only if none fits at all, answer "NEW: <short, specific name>" (2–8 words).' : ''} Reply with JSON only: {"1":"label","2":"label",...} using the texts' numbers.${red.enabled ? ' ' + SYSTEM_NOTE : ''}`;
    // Unique texts only, in batches, several batches at a time. Labels are cached as they arrive, so an interrupted
    // run (budget reached, network) continues where it stopped and never pays twice for the same text.
    const batches = []; for (let i = 0; i < todo.length; i += TAG_BATCH) batches.push(todo.slice(i, i + TAG_BATCH));
    let done = 0, failed = 0; progress({ phase: 'label', done: 0, total: todo.length, cached: texts.filter(Boolean).length - todo.length });
    const work = async batch => {
      checkLimits(user);
      try {
        let r;
        for (let attempt = 0; ; attempt++) { // rate limits or brief outages on large runs: wait and retry the same batch
          try { r = await askJson(user, model, system, batch.map((x, k) => `${k + 1}. ${red.mask(x).replace(/\s+/g, ' ')}`).join('\n'), 'report.tag', 3000, 'low'); break; }
          catch (e) { if (attempt >= 4 || ![429, 500, 502, 503, 529].includes(e.status)) throw e; await new Promise(res => setTimeout(res, 2000 * 2 ** attempt)); }
        }
        batch.forEach((x, k) => { const raw = String(r[k + 1] ?? '').trim(); let v = norm.get(raw.toLowerCase());
          if (!v && allowNew && /^new\s*:/i.test(raw) && added.length < 20) { v = raw.replace(/^new\s*:\s*/i, '').slice(0, 90); if (v && !norm.has(v.toLowerCase())) { norm.set(v.toLowerCase(), v); added.push(v); } }
          if (v) run(`INSERT OR REPLACE INTO ai_tag_cache(key,value,created) VALUES(?,?,?)`, keyOf(x), v, now()); });
      } catch (e) { if (e.status === 402) { next = batches.length; throw e; } failed += batch.length; lastErr = e; }
      done += batch.length; progress({ phase: 'label', done, total: todo.length });
    };
    let next = 0, lastErr = null; await Promise.all(Array.from({ length: Math.min(TAG_PARALLEL, batches.length) }, async () => { while (next < batches.length) await work(batches[next++]); }));
    if (failed) throw new Error(`AI labelling failed for ${failed.toLocaleString('en')} of ${todo.length.toLocaleString('en')} rows${lastErr?.message ? ` (${String(lastErr.message).slice(0, 160)})` : ''}. Run it again: rows already labelled are cached, so only the rest is sent.`);
    const lookup = x => one(`SELECT value FROM ai_tag_cache WHERE key=?`, keyOf(x))?.value || ''; // new labels are cached under the same key
    return { labels: [...use, ...added], added, values: texts.map(x => (x ? lookup(x) : '')) };
  };
}
// Cleans entity names (people, organizations, influencers): junk tokens, slugs, partial or broken names.
function makeNormalizer(user, did) {
  const red = redactorFor(user, 'report:' + did);
  return async (values, instruction) => {
    const model = helperModel(user); const map = new Map();
    for (let i = 0; i < values.length; i += 120) {
      checkLimits(user); const batch = values.slice(i, i + 120);
      const r = await askJson(user, model, `You clean a column of names (people, organizations, accounts) from media monitoring data${instruction ? `: ${instruction}` : ''}. For each numbered value return the clean name: full proper names in Title Case, slugs like "agus+harimurti+yudhoyono" → "Agus Harimurti Yudhoyono", a partial name → the full name only when another value in the list shows it, fragments of an organization split by a comma → the full organization name. Junk (pronouns like Saya/Kami, generic words, job-title fragments, an organization in a person column) → "-". Never invent names. Reply with JSON only: {"1":"clean name","2":"-",...}.`, batch.map((x, k) => `${k + 1}. ${red.mask(x)}`).join('\n'), 'report.normalize', 6000, 'low');
      batch.forEach((x, k) => { const v = r[k + 1]; if (typeof v === 'string' && v.trim()) map.set(x, red.unmask(v.trim()).slice(0, 160)); });
    }
    return map;
  };
}

// Runs happen in the background (big files and AI labelling can take minutes); the page polls for progress.
const jobs = new Map(); // dataset id → { status, step, steps, text, done, total, error, started }
export function jobStatus(user, did) { ownDataset(user, did); return jobs.get(did) || { status: 'idle' }; }
export function startRun(user, did, { plan: rawPlan, sheet }) {
  const d = ownDataset(user, did); if (jobs.get(did)?.status === 'running') throw err(409, 'This dataset is already being processed.');
  const plan = sanitizePlan(rawPlan || (d.plan ? JSON.parse(d.plan) : { steps: [] }));
  const job = { status: 'running', step: 0, steps: plan.steps.length, text: 'Reading the file…', done: 0, total: 0, started: now() }; jobs.set(did, job);
  (async () => {
    try {
      const sheets = await loadSource(d); const t = pickSheet(sheets, sheet || d.sheet); const s = getSettings(); const client = d.client_id ? one(`SELECT * FROM clients WHERE id=?`, d.client_id) : null;
      const r = await runPlan(t, plan, { tagger: makeTagger(user, did, p => Object.assign(job, { done: p.done, total: p.total, cached: p.cached ?? job.cached }), client), normalizer: makeNormalizer(user, did), maxAiRows: s.reports?.maxAiRows || 100000,
        onStep: (i, st) => Object.assign(job, { step: i + 1, text: describe(st), done: 0, total: 0, cached: 0 }) });
      const removedBy = {}; for (const x of r.removed) { const k = /^duplikat/i.test(x.reason) ? 'Duplikat' : /^noise/i.test(x.reason) ? 'Noise' : 'Lainnya'; removedBy[k] = (removedBy[k] || 0) + 1; }
      fs.writeFileSync(path.join(dsDir(did), 'result.json'), JSON.stringify({ sheet: t.name, initial: t.rows.length, table: r.table, summaries: r.summaries, log: r.log, removed: r.removed, removedBy, plan, at: now() }), { mode: 0o600 });
      run(`UPDATE datasets SET plan=?, log=?, sheet=?, result_rows=?, updated=? WHERE id=?`, JSON.stringify(plan), JSON.stringify(r.log), t.name, r.table.rows.length, now(), did);
      const aiRows = r.log.reduce((a, l) => a + (l.aiRows || 0), 0);
      audit(user.id, 'report.curate', { dataset: did, steps: r.log.length, failed: r.log.filter(l => !l.ok).length, aiRows, rows: r.table.rows.length, seconds: Math.round((now() - job.started) / 1000) });
      Object.assign(job, { status: 'done', text: 'Done', finished: now() });
    } catch (e) { Object.assign(job, { status: 'error', error: e.message, finished: now() }); }
    setTimeout(() => { if (jobs.get(did) === job) jobs.delete(did); }, 10 * 60e3).unref?.();
  })();
  return job;
}
// What AI labelling would cost before running it: unique texts not yet labelled × tokens per text.
export async function estimateRun(user, did, { plan: rawPlan, sheet }) {
  const d = ownDataset(user, did); const plan = sanitizePlan(rawPlan || { steps: [] }); const tags = plan.steps.filter(x => x.op === 'ai_tag');
  if (!tags.length) return { aiRows: 0, usd: 0, minutes: 0 };
  const t = pickSheet(await loadSource(d), sheet || d.sheet); let texts = 0, chars = 0;
  for (const st of tags) { const idx = st.from.map(c => t.columns.findIndex(x => x.toLowerCase() === c.toLowerCase())).filter(i => i >= 0);
    const uniq = new Set(t.rows.map(r => idx.map(i => r[i]).join(' — ').slice(0, 600)).filter(Boolean)); texts += uniq.size; for (const u of uniq) chars += u.length; }
  const m = helperModel(user); const price = m.price || { in: 0, out: 0 }; const inTok = chars / 3.5 + texts * 6 + Math.ceil(texts / TAG_BATCH) * 250, outTok = texts * 8;
  return { aiRows: texts, model: m.label, usd: +((inTok * price.in + outTok * price.out) / 1e6).toFixed(3), minutes: Math.max(1, Math.round(Math.ceil(texts / TAG_BATCH) / TAG_PARALLEL * 6 / 60)), rows: t.rows.length };
}
// Summary sheets use COUNTIFS formulas on the Data sheet when no later step changed the rows, so the numbers stay
// right when someone edits the data in Excel.
const SAFE_AFTER = new Set(['summary', 'pivot', 'sort']);
function withFormulas(res, sum, dataCols) {
  const later = res.plan.steps.slice((sum.step ?? res.plan.steps.length) + 1); if (sum.step == null || later.some(x => !SAFE_AFTER.has(x.op))) return sum;
  const L = i => { let x = ''; i++; while (i) { const m = (i - 1) % 26; x = String.fromCharCode(65 + m) + x; i = Math.floor((i - 1) / 26); } return x; };
  const st = res.plan.steps[sum.step]; const colOf = name => dataCols.findIndex(c => c.toLowerCase() === String(name).toLowerCase()); const n = sum.rows.length;
  if (st.op === 'summary' && st.group_by.length && st.group_by.length <= 2) {
    const gi = st.group_by.map(colOf); if (gi.some(i => i < 0)) return sum;
    const ci = st.measures.findIndex(m => m.fn === 'count'); if (ci < 0) return sum; const col = st.group_by.length + ci;
    const rows = sum.rows.map((r, k) => { const isTotal = /^total$/i.test(String(r[0])); const out = [...r];
      out[col] = isTotal ? { f: `SUM(${L(col)}2:${L(col)}${n})`, v: r[col] } : { f: `COUNTIFS(${gi.map((g, j) => `Data!$${L(g)}:$${L(g)},${st.explode ? `"*"&$${L(j)}${k + 2}&"*"` : `$${L(j)}${k + 2}`}`).join(',')})`, v: r[col] }; return out; });
    return { ...sum, rows };
  }
  if (st.op === 'pivot' && st.fn === 'count') {
    const ri = colOf(st.rows), ci = colOf(st.columns); if (ri < 0 || ci < 0) return sum; const last = sum.columns.length - 1; const hasTotal = /^total$/i.test(sum.columns[last]);
    const rows = sum.rows.map((r, k) => { const isTotal = /^total$/i.test(String(r[0])); return r.map((v, j) => {
      if (j === 0 || sum.columns[j] === 'Lainnya') return v;
      if (isTotal) return { f: `SUM(${L(j)}2:${L(j)}${n})`, v };
      if (hasTotal && j === last) return { f: `SUM(B${k + 2}:${L(last - 1)}${k + 2})`, v };
      return { f: `COUNTIFS(Data!$${L(ri)}:$${L(ri)},$A${k + 2},Data!$${L(ci)}:$${L(ci)},${L(j)}$1)`, v }; }); });
    return { ...sum, rows };
  }
  return sum;
}
export async function datasetXlsx(user, did, { upper = true } = {}) {
  const d = ownDataset(user, did); const res = readResult(did); if (!res) throw err(409, 'Run the plan first.');
  const cols = upper ? res.table.columns.map(c => String(c).toUpperCase()) : res.table.columns;
  const removed = res.removed || [];
  const counts = res.removedBy || {}; const initial = res.initial ?? (res.table.rows.length + removed.length);
  const recon = `Data awal ${initial} = data final ${res.table.rows.length} + duplikat ${counts.Duplikat || 0} + noise ${counts.Noise || 0}${counts.Lainnya ? ` + difilter ${counts.Lainnya}` : ''}`;
  const notes = { name: 'Catatan kurasi', columns: ['Langkah', 'Keterangan', 'Baris sebelum', 'Baris sesudah', 'Status'], rows: [...res.log.map((l, i) => [i + 1, l.text, l.before, l.after, l.ok ? (l.changed != null ? `OK (${l.changed} sel diubah)` : l.aiRows ? `OK (AI: ${l.aiRows} baris)` : l.detail ? `OK (${Object.entries(l.detail).filter(([, v]) => v).map(([k, v]) => `${k}: ${v}`).join(', ') || 'tidak ada'})` : 'OK') : 'Dilewati: ' + l.error]), ['', recon, '', '', '']], noFilter: true };
  const logSheet = { name: 'Log Pembersihan', columns: ['NO', 'ALASAN', 'MEDIA', 'JUDUL', 'URL', 'TANGGAL', 'URL YANG DIPERTAHANKAN'], rows: removed.map((x, i) => [i + 1, x.reason, x.media, x.title, x.url, x.date, x.ref || '']) };
  const sums = res.summaries.map(sm => withFormulas(res, sm, res.table.columns));
  const buf = await writeXlsx([{ name: 'Data', columns: cols, rows: res.table.rows }, ...sums, ...(removed.length ? [logSheet] : []), notes]);
  return { buf, name: `${d.name.replace(/[^\p{L}\p{N} _-]+/gu, '').trim() || 'data'} (kurasi).xlsx` };
}
// A Markdown digest of a curated dataset, attached to a chat so people can ask questions and brainstorm about it.
export function datasetDigest(user, did) {
  const d = ownDataset(user, did); const res = readResult(did); if (!res) throw err(409, 'Run the plan first.');
  const keep = res.table.columns.map((c, i) => (reportSensitive(c, extraCols()) ? -1 : i)).filter(i => i >= 0);
  const cell = v => String(v ?? '').replace(/\|/g, '/').replace(/\s+/g, ' ').slice(0, 220);
  const md = t => `| ${t.columns.map(cell).join(' | ')} |\n|${t.columns.map(() => '---').join('|')}|\n${t.rows.map(r => `| ${r.map(cell).join(' | ')} |`).join('\n')}`;
  let out = `# ${d.name}\n\nCurated dataset: ${res.table.rows.length} rows. Columns: ${res.table.columns.join(', ')}.\n\n`;
  for (const s of res.summaries) out += `## ${s.name}\n\n${md({ columns: s.columns, rows: s.rows.slice(0, 100) })}\n\n`;
  const rows = res.table.rows.slice(0, 400).map(r => keep.map(i => r[i]));
  out += `## Data (${rows.length < res.table.rows.length ? `first ${rows.length} of ${res.table.rows.length} rows` : 'all rows'}${keep.length < res.table.columns.length ? '; personal-data columns left out' : ''})\n\n${md({ columns: keep.map(i => res.table.columns[i]), rows })}\n`;
  const bid = id(); const dir = path.join(config.dataDir, 'blobs', user.id); fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const buf = Buffer.from(out, 'utf8'); const name = `${d.name} (data).md`;
  fs.writeFileSync(path.join(dir, bid), buf, { mode: 0o600 });
  run(`INSERT INTO blobs(id,user_id,name,mime,size,kind,created) VALUES(?,?,?,?,?,?,?)`, bid, user.id, name, 'text/markdown', buf.length, 'text', now());
  return { id: bid, name, mime: 'text/markdown', size: buf.length, kind: 'text' };
}

/* ================= images: screenshots for decks, client logos ================= */
const IMG_RE = /^image\/(png|jpeg)$/;
export function saveImage(user, { buf, mime, filename }) {
  const m = IMG_RE.exec(mime || '') || (/\.png$/i.test(filename) ? [, 'png'] : /\.jpe?g$/i.test(filename) ? [, 'jpeg'] : null);
  if (!m) throw err(415, 'Upload a PNG or JPG image (export SVG logos as PNG).');
  const iid = id(); const dir = path.join(DIR, 'images', user.id); fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(dir, `${iid}.${m[1]}`), buf, { mode: 0o600 }); return { id: iid, name: String(filename || 'image').slice(0, 120), ext: m[1] };
}
function loadImage(user, iid) { const dir = path.join(DIR, 'images', user.id); for (const ext of ['png', 'jpeg']) { const f = path.join(dir, `${iid}.${ext}`); if (/^[\w-]+$/.test(iid) && fs.existsSync(f)) return { buf: fs.readFileSync(f), ext, mime: 'image/' + ext }; } return null; }
export function imageFile(user, iid) { const im = loadImage(user, iid); if (!im) throw err(404, 'Image not found'); return im; }
// A client can have several logos (colour, white, partner…). Each is analysed once: brightness and brand colours.
const logosDir = cid => path.join(DIR, 'clients', cid, 'logos');
export function clientLogos(cid) {
  if (!cid) return []; const c = one(`SELECT logos FROM clients WHERE id=?`, cid); const list = JSON.parse(c?.logos || '[]');
  return list.map(l => { const f = path.join(logosDir(cid), `${l.id}.${l.ext}`); return fs.existsSync(f) ? { ...l, buf: fs.readFileSync(f), mime: 'image/' + l.ext } : null; }).filter(Boolean);
}
export function addClientLogo(user, cid, { buf, mime, filename }) {
  clientRow(cid); const m = IMG_RE.exec(mime || '') || (/\.png$/i.test(filename) ? [, 'png'] : /\.jpe?g$/i.test(filename) ? [, 'jpeg'] : null);
  if (!m) throw err(415, 'Upload logos as PNG or JPG (export SVG logos as PNG).');
  const lid = id(); fs.mkdirSync(logosDir(cid), { recursive: true, mode: 0o700 }); fs.writeFileSync(path.join(logosDir(cid), `${lid}.${m[1]}`), buf, { mode: 0o600 });
  const info = m[1] === 'png' ? logoInfo(buf) : { lum: 0.5, colors: [] };
  const list = JSON.parse(one(`SELECT logos FROM clients WHERE id=?`, cid).logos || '[]'); list.push({ id: lid, ext: m[1], label: String(filename || 'logo').replace(/\.(png|jpe?g)$/i, '').slice(0, 80), lum: +info.lum.toFixed(3), colors: info.colors });
  run(`UPDATE clients SET logos=?, updated=? WHERE id=?`, JSON.stringify(list.slice(-8)), now(), cid); return lid;
}
export function removeClientLogo(user, cid, lid) { clientRow(cid); const list = JSON.parse(one(`SELECT logos FROM clients WHERE id=?`, cid).logos || '[]').filter(l => l.id !== lid); run(`UPDATE clients SET logos=? WHERE id=?`, JSON.stringify(list), cid); fs.rmSync(path.join(logosDir(cid), `${lid}.png`), { force: true }); fs.rmSync(path.join(logosDir(cid), `${lid}.jpeg`), { force: true }); }
export function clientLogoFile(cid, lid) { const l = clientLogos(cid).find(x => x.id === lid); if (!l) throw err(404, 'Logo not found'); return l; }
// Footer on light slides gets the darkest logo; a dark cover gets the brightest.
function pickLogos(cid) { const ls = clientLogos(cid); if (!ls.length) return {}; const byLum = [...ls].sort((a, b) => a.lum - b.lum); return { logoOnLight: byLum[0], logoOnDark: byLum.at(-1) }; }
// Style choices for a client: a palette from its logos first (recommended), then presets that suit its voice.
export function stylesFor(cid) {
  const c = cid ? one(`SELECT * FROM clients WHERE id=?`, cid) : null; const colors = clientLogos(cid).flatMap(l => l.colors || []);
  const p = parsePersona(c?.persona, CLIENT_FIELDS); const list = recommendStyles([...new Set(colors)], `${c?.name || ''} ${c?.description || ''} ${p.voice || ''} ${p.audiences || ''}`);
  return { styles: list, current: c?.style ? JSON.parse(c.style) : null };
}
export function setClientStyle(user, cid, style) { clientRow(cid); const st = sanitizeStyle(style); run(`UPDATE clients SET style=?, updated=? WHERE id=?`, st ? JSON.stringify(st) : null, now(), cid); }

// "Sumatera → Sumatra" / "Sumatera -> Sumatra" / "Sumatera = Sumatra", one per line or separated by ';'
export function spellingPairs(client) {
  const txt = parsePersona(client?.persona, CLIENT_FIELDS).spelling || '';
  return txt.split(/[\n;]+/).map(l => l.split(/\s*(?:→|->|=>|=)\s*/)).filter(p => p.length === 2 && p[0].trim() && p[1].trim()).map(([a, b]) => [a.trim(), b.trim()]);
}
// Structure for a report type: the client's own for that type, else the client's general structure, else the type's default.
const structKey = (typeId, channel) => (channel && channel !== 'medmas' ? `${typeId}:${channel}` : typeId);
export function structureFor(client, typeId, channel = 'medmas') {
  const own = client ? JSON.parse(client.structures || '{}')[structKey(typeId, channel)] : ''; if (own?.trim()) return { text: own, source: 'client' };
  const general = parsePersona(client?.persona, CLIENT_FIELDS).structure; if (general?.trim() && (!typeId || typeId === 'weekly') && channel === 'medmas') return { text: general, source: 'client' };
  const t = reportType(typeId); const base = t?.structure || ''; return { text: adaptStructure(base, channel) || general || '', source: base ? 'default' : general ? 'client' : 'none' };
}
export function structurePreview(cid, typeId, channel) {
  const c = cid ? one(`SELECT * FROM clients WHERE id=?`, cid) : null; const st = structureFor(c, typeId, channel || 'medmas'); const finals = finalsPreview(c?.id, typeId, channel || 'medmas');
  if (st.source !== 'client' && finals.using.length) { const fin = finalsNote(c.id, typeId, channel || 'medmas'); if (fin.structure) return { text: fin.structure, source: 'final', finals }; }
  return { ...st, finals };
}
export function setClientStructure(user, cid, { type, channel, text }) { const c = clientRow(cid); if (!reportType(type)) throw err(400, 'Unknown report type'); const m = JSON.parse(c.structures || '{}'); const key = structKey(type, channel); if (String(text || '').trim()) m[key] = String(text).slice(0, 6000); else delete m[key]; run(`UPDATE clients SET structures=?, updated=? WHERE id=?`, JSON.stringify(m), now(), cid); }

/* ---------- style profiles: the language and styling patterns of a senior's reports ---------- */
// The models are not retrained: Canopus distils the pattern once (a style profile plus typical sentences) and gives it
// to Claude and GPT with every deck that follows this senior. It is rebuilt whenever the senior adds a report.
const PROFILE_FIELDS = [['summary', 'In short'], ['titles', 'Slide titles'], ['structure', 'Flow of the report'], ['findings', 'How findings and causes are phrased'], ['recommendations', 'How recommendations are written'], ['language', 'Tone, sentence length and vocabulary'], ['design', 'Visual habits'], ['avoid', 'Never']];
export async function buildStyleProfile(user, cid) {
  const c = one(`SELECT * FROM collections WHERE id=? AND kind IN ('senior','person')`, cid); if (!c || !allowedCollections(user).some(x => x.id === cid)) throw err(404, 'Space not found');
  if (user.role !== 'admin' && c.owner_id !== user.id) throw err(403, 'Only the owner of this space or an administrator can rebuild its style profile.');
  if (c.local_only) throw err(403, 'This space is on-premise only, so its reports cannot be sent to a cloud AI to build a style profile.');
  const docs = all(`SELECT id, title FROM docs WHERE collection_id=? AND status='ready' ORDER BY created DESC LIMIT 8`, cid); if (!docs.length) throw err(409, 'Add at least one report first.');
  const per = Math.floor(16000 / docs.length); const red = redactorFor(user, 'style:' + cid);
  const text = docs.map(d => `=== ${d.title} ===\n${all(`SELECT text FROM kchunks WHERE doc_id=? ORDER BY idx`, d.id).map(r => r.text).join('\n').slice(0, per)}`).join('\n\n');
  checkLimits(user); const model = reportModel(user, null, 'writing');
  const raw = await askJson(user, model, `You are an editor who reverse-engineers a writing and presentation style. Below are excerpts of reports by one senior analyst (codename "${c.name}"). Describe the style so other analysts and AI models can write new reports the same way. Describe patterns, never facts. Reply with JSON only: {${PROFILE_FIELDS.map(([k]) => `"${k}": ${k === 'summary' ? '2–3 sentences' : 'one short paragraph'}`).join(', ')}, "examples": [4–6 short sentences or titles copied from the text that typify the style, with every number replaced by "X" and every name of a person replaced by "[nama]"]}.${red.enabled ? ' ' + SYSTEM_NOTE : ''}`, red.mask(text), 'report.style', 4000, 'medium');
  const prof = { ...Object.fromEntries(PROFILE_FIELDS.map(([k]) => [k, String(red.unmask(String(raw[k] || ''))).slice(0, 1200)])), examples: (Array.isArray(raw.examples) ? raw.examples : []).slice(0, 6).map(x => String(red.unmask(String(x))).replace(/\d[\d.,]*/g, 'X').slice(0, 240)), from: docs.length };
  run(`UPDATE collections SET style_profile=?, style_updated=? WHERE id=?`, JSON.stringify(prof), now(), cid); return prof;
}
export function saveStyleProfile(user, cid, profile) {
  const c = one(`SELECT * FROM collections WHERE id=? AND kind IN ('senior','person')`, cid); if (!c) throw err(404, 'Space not found');
  if (user.role !== 'admin' && c.owner_id !== user.id) throw err(403, 'Only the owner of this space or an administrator can edit its style profile.');
  const prof = { ...Object.fromEntries(PROFILE_FIELDS.map(([k]) => [k, String(profile?.[k] || '').slice(0, 1500)])), examples: (Array.isArray(profile?.examples) ? profile.examples : String(profile?.examples || '').split('\n')).map(x => String(x).trim()).filter(Boolean).slice(0, 8), edited: true };
  run(`UPDATE collections SET style_profile=?, style_updated=? WHERE id=?`, JSON.stringify(prof), now(), cid); return prof;
}
export const STYLE_PROFILE_FIELDS = PROFILE_FIELDS;
function styleBlock(c) {
  const p = c?.style_profile ? JSON.parse(c.style_profile) : null; if (!p) return '';
  const who = c.kind === 'senior' ? `★${c.name}` : c.name;
  return `\n\nWriting and presentation style to follow — the pattern of senior analyst ${who} (follow how they write, never copy facts or numbers):\n${PROFILE_FIELDS.filter(([k]) => p[k]).map(([k, l]) => `- ${l}: ${p[k]}`).join('\n')}${p.examples?.length ? `\nTypical sentences (numbers shown as X):\n${p.examples.map(x => `  • ${x}`).join('\n')}` : ''}`;
}

/* ---------- reference reports from seniors (knowledge by person) ---------- */
// Reports that analysts can follow: PowerPoint (design + structure + writing style) or PDF/Word (structure + writing style).
export function referenceReports(user) {
  const cols = allowedCollections(user).filter(c => ['senior', 'person', 'team', 'client'].includes(c.kind) && !c.local_only); if (!cols.length) return [];
  const styles = cols.filter(c => c.kind === 'senior' && c.style_profile).map(c => ({ id: 'senior:' + c.id, title: `URS ★${c.name} — language & style from all reports`, kind: 'senior', by: '★ ' + c.name, design: false, style: true }));
  return [...styles, ...all(`SELECT d.id, d.title, d.filename, d.created, d.collection_id, c.kind, c.name collection, COALESCE(NULLIF(u.name,''),u.email) owner FROM docs d JOIN collections c ON c.id=d.collection_id LEFT JOIN users u ON u.id=c.owner_id
    WHERE d.status='ready' AND d.collection_id IN (${cols.map(() => '?').join(',')}) AND (lower(d.filename) LIKE '%.pptx' OR lower(d.filename) LIKE '%.pdf' OR lower(d.filename) LIKE '%.docx') ORDER BY c.kind='senior' DESC, c.kind='person' DESC, c.name, d.created DESC`, ...cols.map(c => c.id))
    .map(d => ({ id: d.id, title: d.title, filename: d.filename, created: d.created, kind: d.kind, by: d.kind === 'senior' ? '★ ' + d.collection : d.kind === 'person' ? d.owner : d.collection, design: /\.pptx$/i.test(d.filename) }))];
}
function referenceDoc(user, did, forAi = false) {
  const d = one(`SELECT * FROM docs WHERE id=?`, did); if (!d || !allowedCollections(user).some(c => c.id === d.collection_id)) throw err(404, 'Reference report not found');
  if (forAi && one(`SELECT local_only FROM collections WHERE id=?`, d.collection_id)?.local_only) throw err(403, 'This report is in an on-premise-only collection, so it cannot be sent to a cloud AI as a reference.');
  const col = one(`SELECT kind, name FROM collections WHERE id=?`, d.collection_id); // seniors are named only by their codename, also towards the AI
  return { ...d, buf: fs.readFileSync(path.join(config.dataDir, 'docs', d.id)), owner: col?.kind === 'senior' ? col.name : one(`SELECT COALESCE(NULLIF(u.name,''),u.email) n FROM collections c LEFT JOIN users u ON u.id=c.owner_id WHERE c.id=?`, d.collection_id)?.n || '' };
}
async function referenceNote(user, did) {
  const d = referenceDoc(user, did, true); const pages = all(`SELECT text FROM kchunks WHERE doc_id=? ORDER BY idx`, d.id).map(r => r.text).join('\n').slice(0, 9000);
  let structure = ''; if (/\.pptx$/i.test(d.filename)) { try { const info = describeTemplate(await openTemplate(d.buf)); structure = info.structure.map((x, i) => `${i + 1}. ${x.title || '(no title)'}${x.has?.length ? ` [${x.has.join(', ')}]` : ''}`).join('\n'); } catch {} }
  const col = one(`SELECT * FROM collections WHERE id=?`, d.collection_id);
  return { doc: d, structure, style: styleBlock(col), text: styleBlock(col) + `\n\nReference report chosen by the analyst: "${d.title}"${d.owner ? ` by ${d.owner}` : ''}. Follow its structure, depth, tone and writing style — the way it titles slides, phrases findings, explains causes and makes recommendations — but with this period's data and content; never copy its numbers or facts.${structure ? `\nIts slides:\n${structure}` : ''}\nExcerpts of its text (style examples):\n${pages}` };
}
const maxOf = text => { const m = String(text || '').match(/maks(?:imal|imum)?\.?\s*(\d+)\s*slide|max(?:imum)?\.?\s*(\d+)\s*slides?/i); return m ? +(m[1] || m[2]) : 0; };
const maxSlidesOf = client => { const m = (parsePersona(client?.persona, CLIENT_FIELDS).structure || '').match(/maks(?:imal|imum)?\.?\s*(\d+)\s*slide|max(?:imum)?\.?\s*(\d+)\s*slides?/i); return m ? +(m[1] || m[2]) : 0; };

/* ================= decks ================= */
function ownDeck(user, kid) { const k = one(`SELECT * FROM decks WHERE id=? AND user_id=?`, kid, user.id); if (!k) throw err(404, 'Presentation not found'); return k; }
const deckOut = k => ({ id: k.id, clientId: k.client_id, channel: k.channel || 'medmas', reference: k.reference || null, reportType: k.report_type || null, period: k.period || '', structure: k.structure || '', style: k.style ? JSON.parse(k.style) : null, images: JSON.parse(k.images || '[]'), title: k.title, template: k.template_id || 'plain', datasets: JSON.parse(k.datasets), brief: k.brief, outline: k.outline ? JSON.parse(k.outline) : null, notes: k.notes || '', created: k.created, updated: k.updated });
export function listDecks(user) { return all(`SELECT * FROM decks WHERE user_id=? ORDER BY updated DESC`, user.id).map(k => { const o = deckOut(k); return { ...o, slides: o.outline?.slides.length || 0, outline: undefined, brief: o.brief.slice(0, 200) }; }); }
export function getDeck(user, kid) { return deckOut(ownDeck(user, kid)); }
export function deleteDeck(user, kid) { const k = ownDeck(user, kid); run(`DELETE FROM decks WHERE id=?`, k.id); return k; }

// Tables a deck can use: for each dataset, its curated table ("Data") and summaries, addressed as "Dataset / Table".
function deckTables(user, datasetIds) {
  const out = [];
  for (const did of datasetIds) {
    const d = one(`SELECT * FROM datasets WHERE id=? AND user_id=?`, did, user.id); if (!d) continue; const res = readResult(did); if (!res) continue;
    out.push({ dataset: d.name, name: 'Data', ref: `${d.name} / Data`, columns: res.table.columns, rows: res.table.rows, main: true });
    for (const s of res.summaries) out.push({ dataset: d.name, name: s.name, ref: `${d.name} / ${s.name}`, columns: s.columns, rows: s.rows });
  }
  return out;
}
const resolver = tables => ref => { const r = String(ref || '').toLowerCase().trim(); return tables.find(t => t.ref.toLowerCase() === r) || tables.find(t => t.name.toLowerCase() === r) || tables.find(t => r.endsWith('/ ' + t.name.toLowerCase())) || null; };

const OUTLINE_BASE = `You are a senior media and communications analyst. You write report decks (weekly media monitoring, issue analysis, communication strategy) for a communications team and its clients, from the curated data and the brief you are given. Canopus builds the slides on the client's PowerPoint template and fills charts, tables and news samples from the real data.

Reply with ONE JSON object only: {"title": deck title, "footer": short footer text (report name and period, e.g. "Weekly Report Media Massa · 23–29 Oktober 2026"), "notes": 1–3 sentences for the user (what you built, data that was missing, ties or borderline cases to check), "slides": [ ... ]}
Slide kinds:
- {"kind":"title","title":...,"subtitle":"period · unit","image":optional screenshot/photo id}
- {"kind":"section","title":...}
- {"kind":"summary","title":"Executive Summary","headline":one synthesis sentence with the key phrase in **bold**,"findings":[{"label":"DORONGAN"|"RISIKO"|"SOROTAN"|…,"text":one full sentence with its key number in **bold**}] (3),"focus":one full sentence on what to do or watch next period}
- {"kind":"bullets","title":...,"bullets":["full sentence", "- sub-point", ...]}  max 6
- {"kind":"two","title":...,"left_title":...,"left":[...],"right_title":...,"right":[...]}
- {"kind":"kpi","title":...,"items":[{"value":"2.663","label":"total pemberitaan","note":optional}],"caption":...}
- {"kind":"chart","title":...,"source":"<Dataset> / <Table>","chart":"column"|"bar"|"line"|"pie"|"doughnut","category":column,"series":[numeric columns],"stacked":bool,"highlight":category to emphasize (e.g. the peak day),"note":short on-chart annotation (e.g. "26 Okt: 555 berita, MagangHub Batch 3"),"filter":{"column":c,"value":v} optional,"caption":one full sentence}
- {"kind":"table","title":...,"source":"<Dataset> / <Table>","columns":[≤6],"top":N,"filter":{"column":"MEDIA TYPE","value":"TV"} optional (an empty result is shown as "Tidak ada pemberitaan …", e.g. TV with 0),"caption":...}
- {"kind":"news","title":"Sampel Berita Positif"|…,"source":"<Dataset> / Data","sentiment":"positif"|"negatif","items":[{"headline":exact headline copied from the data,"why":one sentence on why it matters}] (4)}  outlet, date and link are taken from the data
- {"kind":"image","title":...,"image":screenshot id,"points":[2–4 full sentences of analysis],"caption":source note}  keeps a provided screenshot (e.g. dashboard word cloud or map) as is
- {"kind":"quote","title":...,"quote":exact quote from the data,"source":"who, outlet, date"}
- {"kind":"matrix","title":...,"quadrants":[{"title":...,"points":[...]}, x4],"caption":...}  risk mapping, SWOT, stakeholders
- {"kind":"actions","title":...,"rows":[{"action":...,"owner":...,"when":...,"kpi":...}],"caption":...}
- {"kind":"closing","title":...,"subtitle":...}

Order of authority: the client's persona and report structure first, then the analyst's persona, then the house style below. Always: use only facts and numbers from the data catalog, screenshots or brief, and never invent outlets, quotes or figures.
- When a report structure is given, follow it exactly: one slide per listed section, in that order, with those titles, and respect any slide limit. Otherwise follow the template's reference structure, or a standard media-monitoring order: cover, executive summary, trend, media distribution, spokespersons, sentiment, issues, programs, leaders, word cloud, locations, positive and negative news samples, risk mapping, opportunities and recommendations.`;
const houseStyle = () => String(getSettings().reportStyle || '').trim();
const outlineSystem = () => OUTLINE_BASE + (houseStyle() ? `\n\nHouse style (the team's default; the client's persona and structure override it):\n${houseStyle()}` : '');

const FINALIZE_SYSTEM = `You are the second, senior analyst on a report presentation. Another analyst drafted it from the same data. Your job: analyze the data yourself, then finalize both the analysis and the language.

Work in this order:
1. Read the data catalog (curated spreadsheet: summaries and rows) on your own and note the key findings: volumes, shares, trends, peaks, outlets, topics/issues, spokespeople, notable coverage, anything unusual.
2. Compare with the draft: correct claims the data does not support, sharpen weak insights, and add important findings the draft missed.
3. Finalize the language for senior readers.

Reply with ONE JSON object only: {"title": ..., "notes": 1–2 sentences on what you found and changed, "slides": [ ... ]}
- Keep every draft slide, with its "n" number, kind and order. Rewrite the content following the house style and the client's persona given in the brief: complete sentences, every number followed by what it means, causes tied to the client's own activities, specific recommendations (who, what, when, how success is measured), and an executive summary that synthesizes instead of repeating numbers. Keep slide titles in the style the house style asks for.
- You may add up to 3 NEW slides (without "n") where the data shows something important the draft missed. Place them where they fit. A new chart or table must use a "source" and column names exactly as in the data catalog.
- Never change "source", "columns", "chart", "category", "series", "stacked" or "top" of draft slides. Never invent facts, quotes, figures or outlets; every number must match the data. Keep placeholders like ⟦NAME_1⟧ exactly.
- Language: the brief's language (usually Indonesian, formal, EYD), consistent terms and number formats.
Slide formats are the same as in the draft (kinds: title, section, summary, bullets, two, kpi, quote, matrix, actions, chart, table, news, image, closing). For news slides keep headlines exactly as in the data.`;

// The data the AI may read about a deck's datasets: summaries in full, the curated table as a sample without personal columns.
function catalogText(tables, sampleRows = 40) {
  const extra = extraCols(); const cell = v => String(v ?? '').replace(/\s+/g, ' ').slice(0, 200); let catalog = '';
  for (const t of tables) {
    const keep = t.columns.map((c, i) => (reportSensitive(c, extra) ? -1 : i)).filter(i => i >= 0);
    if (t.main) catalog += `\n### ${t.ref}  (${t.rows.length} rows; columns: ${t.columns.map(c => `"${c}"`).join(', ')})\n${sampleRows < t.rows.length ? `Sample of ${sampleRows} rows` : 'All rows'} (personal-data columns left out):\n${t.rows.slice(0, sampleRows).map(r => keep.map(i => `${t.columns[i]}: ${cell(r[i])}`).join(' · ')).join('\n')}\n`;
    else catalog += `\n### ${t.ref}  (columns: ${t.columns.map(c => `"${c}"`).join(', ')})\n${t.rows.slice(0, 60).map(r => r.map(cell).join(' | ')).join('\n')}\n`;
  }
  return catalog;
}
// Second stage: another model (e.g. GPT) polishes the analyst's draft. It may rewrite text, but kinds, sources, columns
// and chart settings stay as the analysis set them, so the visuals remain tied to the real data.
async function finalizeOutline(user, outline, { brief, catalog, finalizeModel, red }) {
  const finalizer = reportModel(user, finalizeModel, 'writing'); checkLimits(user);
  const draft = red.mask(JSON.stringify({ title: outline.title, slides: outline.slides.map((x, i) => ({ n: i + 1, ...x })) }));
  const fin = await askJson(user, finalizer, FINALIZE_SYSTEM + (houseStyle() ? `\n\nHouse style (the team's default; the client's persona overrides it):\n${houseStyle()}` : '') + (red.enabled ? '\n\n' + SYSTEM_NOTE : ''), `Brief from the user:\n${red.mask(String(brief || '').slice(0, 4000))}\n\nData catalog (the curated spreadsheet — analyze it yourself):${red.mask(catalog).slice(0, 90000)}\n\nDraft outline from the first analyst:\n${draft}`, 'report.finalize', 16000, 'medium');
  const one_ = r => sanitizeOutline({ slides: [r] }).slides[0];
  const LOCK = ['kind', 'source', 'columns', 'top', 'chart', 'category', 'series', 'stacked', 'filter', 'image'];
  const out = []; const used = new Set(); let added = 0, kept = 0;
  for (const r of Array.isArray(fin.slides) ? fin.slides : []) {
    const n = Number.isInteger(r?.n) ? r.n - 1 : -1; const orig = outline.slides[n];
    if (orig && !used.has(n)) { // a draft slide: take the new text, keep its kind and data settings
      const p = r.kind === orig.kind ? one_(unmaskDeep(red, r)) : null; used.add(n);
      out.push(p ? { ...p, ...Object.fromEntries(LOCK.filter(k => orig[k] !== undefined).map(k => [k, orig[k]])), _n: n } : { ...orig, _n: n }); continue;
    }
    if (n < 0 && added < 3) { const p = one_(unmaskDeep(red, r)); if (p) { out.push({ ...p, added: true }); added++; } }
  }
  // Draft slides the reviewer left out are put back where they were.
  outline.slides.forEach((s0, i) => { if (!used.has(i)) { kept++; const at = out.findIndex(x => x._n > i); out.splice(at < 0 ? out.length : at, 0, { ...s0, _n: i }); } });
  const { slides: _drop, title: _t, ...keep } = outline; // footer, cover and other deck settings carry over
  const result = { ...keep, title: (typeof fin.title === 'string' && fin.title.trim() ? red.unmask(fin.title).slice(0, 160) : outline.title), slides: out.map(({ added: _a, _n: _b, ...x }) => x).slice(0, 40) };
  const note = [red.unmask(String(fin.notes || '')), added ? `${finalizer.label} added ${added} slide${added > 1 ? 's' : ''} from its own reading of the data.` : '', kept ? `${kept} draft slide${kept > 1 ? 's were' : ' was'} kept unchanged.` : ''].filter(Boolean).join(' ');
  return { outline: result, finalizer, note };
}

// Cover photo: the user picks one, or Canopus picks the best of the uploads (closest to a landscape slide, highest resolution).
function chooseCover(user, cover) {
  const cands = (cover?.candidates || []).map(String).filter(x => loadImage(user, x)); if (!cands.length || cover?.layout === 'none') return null;
  let pick = cover.mode === 'pick' && cands.includes(String(cover.image)) ? String(cover.image) : null;
  const size = id_ => imgSize(loadImage(user, id_).buf) || { w: 1, h: 1 };
  if (!pick) pick = [...cands].sort((a, b) => { const sc = x => { const z = size(x); const r = z.w / z.h; return -Math.abs(Math.log(r / (16 / 9))) * 2 + Math.log10(z.w * z.h); }; return sc(b) - sc(a); })[0];
  const z = size(pick); const layout = ['full', 'split'].includes(cover?.layout) ? cover.layout : (z.w / z.h >= 1.2 ? 'full' : 'split');
  return { image: pick, layout, mode: cover?.mode === 'pick' ? 'pick' : 'auto', candidates: cands };
}
export async function draftDeck(user, { title, template, datasets = [], brief, model: requested, finalizeModel, knowledge, client: clientId, images = [], style, cover, reportType: rt, period, channel, reference, useReferenceDesign, learnFinals }) {
  checkLimits(user); const client = clientRow(clientId);
  const ids = [...new Set(datasets)].slice(0, 6); const tables = deckTables(user, ids);
  const tdesc = await templateDesc(user, template);
  const model = reportModel(user, requested, 'writing'); const kid = id();
  const red = redactorFor(user, 'deck:' + kid); const catalog = catalogText(tables);
  let excerpts = '';
  if (knowledge && brief) { const hits = search(user, String(brief).slice(0, 300), { limit: 6, collections: client?.collection_id ? [client.collection_id] : null }).filter(h => !h.localOnly); if (hits.length) excerpts = `\n\nRelevant internal documents:\n${hits.map((h, i) => `[${i + 1}] ${h.title}${h.page ? ' p.' + h.page : ''}: ${h.text.slice(0, 900)}`).join('\n')}`; }
  const struct = !reference && tdesc.info.structure?.length ? `\n\nReference structure from the template "${tdesc.name}" (slides in an earlier report; follow its order and style, with new content):\n${tdesc.info.structure.map((s, i) => `${i + 1}. ${s.title || '(no title)'}${s.has?.length ? ` [${s.has.join(', ')}]` : ''}${s.text ? ' — ' + s.text.slice(0, 160) : ''}`).join('\n')}` : '';
  const clientNote = [clientBlock(client), analystBlock(user)].filter(Boolean).join('\n\n') + '\n\n';
  const prompt = red.mask(`${clientNote}Brief from the user:\n${String(brief || 'Create a report presentation from this data.').slice(0, 6000)}${title ? `\n\nWorking title: ${title}` : ''}\n\nToday: ${new Date().toISOString().slice(0, 10)}${struct}\n\nData catalog:${catalog || '\n(no datasets attached — write from the brief only, without charts or tables)'}${excerpts}`);
  // Screenshots (e.g. dashboard word cloud, map) go into the deck; the analysis model also reads them when image uploads are allowed.
  const imgs = (Array.isArray(images) ? images : []).slice(0, 8).map(x => ({ id: String(x.id || ''), label: String(x.label || x.name || '').slice(0, 120) })).filter(x => loadImage(user, x.id));
  const allowImages = getSettings().imageUploads; const vision = allowImages ? imgs.map(x => { const im = loadImage(user, x.id); return { mime: im.mime, data: im.buf.toString('base64') }; }) : [];
  const imgNote = imgs.length ? `\n\nScreenshots provided (use their ids in "image" slides${allowImages ? '; they are attached in this order' : '; you cannot see them, so describe only what the brief says about them'}):\n${imgs.map(x => `- ${x.id}: ${x.label || 'screenshot'}`).join('\n')}` : '';
  const tp = reportType(rt); const per = String(period || '').trim().slice(0, 80); const chn = channelOf(channel); const seniorStyle = String(reference || '').startsWith('senior:') ? one(`SELECT * FROM collections WHERE id=? AND kind='senior'`, String(reference).slice(7)) : null;
  if (seniorStyle && !allowedCollections(user).some(c => c.id === seniorStyle.id)) throw err(404, 'Senior reference not found');
  const ref = reference && !seniorStyle ? await referenceNote(user, String(reference)) : seniorStyle ? { text: styleBlock(seniorStyle), style: styleBlock(seniorStyle), structure: '', doc: null } : null; const rstruct = ref?.structure ? { text: ref.structure, source: 'reference' } : structureFor(client, tp?.id, chn.id);
  // The client's final reports (as the editor approved them) for this type and channel. Their structure is used when
  // the client has not written its own; their titles, phrasing and the editor's corrections always guide the writing.
  const fin = !reference && learnFinals !== false && client ? finalsNote(client.id, tp?.id, chn.id) : { text: '', structure: '', used: [] };
  if (fin.structure && rstruct.source !== 'client') { rstruct.text = fin.structure; rstruct.source = 'final'; }
  if (ref?.doc && useReferenceDesign !== false && /\.pptx$/i.test(ref.doc.filename)) template = 'doc:' + ref.doc.id;
  const cap = maxOf(rstruct.text) || (tp?.maxSlides || 0); const capNote = `\n\n${chn.note}${tp ? `\n${typeNote(tp, per)}` : ''}${ref ? ref.text : ''}${fin.text}${rstruct.text ? `\n\nReport structure for this deck (${rstruct.source === 'reference' ? 'from the chosen reference report' : rstruct.source === 'final' ? "from the client's latest final report, as the editor approved it — keep its slides and order, with this period's content" : rstruct.source === 'client' ? "the client's own" : `default for ${tp?.label || 'this report'}`}) — follow it exactly, one slide per line, in this order:\n${rstruct.text}` : ''}${cap ? `\n\nSlide limit: at most ${cap} slides.` : ''}`;
  const raw = await askJson(user, model, outlineSystem() + (red.enabled ? '\n\n' + SYSTEM_NOTE : ''), prompt + red.mask(imgNote + capNote), 'report.outline', 16000, 'medium', vision);
  let outline = sanitizeOutline(unmaskDeep(red, raw)); let notes = red.unmask(String(raw.notes || ''));
  if (!outline.slides.length) throw err(502, 'The AI did not return any slides. Try again with a more specific brief.');
  const cov = chooseCover(user, cover); if (cov) outline.cover = cov;
  if (cap && outline.slides.length > cap) { notes = [notes, `Trimmed to the ${cap}-slide limit.`].filter(Boolean).join(' '); outline.slides = outline.slides.slice(0, cap); }
  let finalizer = null;
  if (finalizeModel && finalizeModel !== 'none') { const f = await finalizeOutline(user, outline, { brief: [clientBlock(client), analystBlock(user), ref?.style || '', fin.text ? fin.text.slice(0, 4000) : '', brief || ''].filter(Boolean).join('\n\n'), catalog: catalogText(tables, 150), finalizeModel, red }); outline = f.outline; finalizer = f.finalizer; notes = [notes, f.note].filter(Boolean).join(' '); }
  notes = [`Analysis: ${model.label}${finalizer ? ` · finalized by ${finalizer.label}` : ''}.`, fin.used.length ? `Learned from final report${fin.used.length > 1 ? 's' : ''}: ${fin.used.map(f => `“${f.title}”`).join(', ')}.` : '', notes].filter(Boolean).join(' ');
  if (!outline.footer && tp && tp.id !== 'adhoc') outline.footer = `${tp.label.replace(/ report$/, ' Report')}${per ? ` · ${per}` : ''}`;
  const t = String(title || outline.title || 'Presentation').slice(0, 160);
  const st = sanitizeStyle(style); run(`INSERT INTO decks(id,user_id,title,template_id,datasets,brief,outline,notes,created,updated,client_id,images,style,report_type,period,structure,channel,reference) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, kid, user.id, t, template && !['default', 'plain'].includes(template) ? template : null, JSON.stringify(ids), String(brief || '').slice(0, 6000), JSON.stringify(outline), notes.slice(0, 1000), now(), now(), client?.id || null, JSON.stringify(imgs), st ? JSON.stringify(st) : null, tp?.id || null, per, rstruct.text || null, chn.id, ref?.doc?.id || (seniorStyle ? 'senior:' + seniorStyle.id : null));
  return { ...getDeck(user, kid), model: { id: model.id, label: model.label }, finalizer: finalizer && { id: finalizer.id, label: finalizer.label } };
}
// Finalize (again) after the user edited the slides.
export async function refinalizeDeck(user, kid, { finalizeModel }) {
  checkLimits(user); const k = getDeck(user, kid); if (!k.outline) throw err(409, 'This presentation has no outline yet.');
  const red = redactorFor(user, 'deck:' + kid);
  const c = k.clientId ? one(`SELECT * FROM clients WHERE id=?`, k.clientId) : null;
  const refCol = k.reference ? (k.reference.startsWith('senior:') ? one(`SELECT * FROM collections WHERE id=?`, k.reference.slice(7)) : one(`SELECT c.* FROM collections c JOIN docs d ON d.collection_id=c.id WHERE d.id=?`, k.reference)) : null;
  const f = await finalizeOutline(user, k.outline, { brief: [clientBlock(c), analystBlock(user), styleBlock(refCol), k.brief].filter(Boolean).join('\n\n'), catalog: catalogText(deckTables(user, k.datasets), 150), finalizeModel, red });
  run(`UPDATE decks SET outline=?, notes=?, updated=? WHERE id=?`, JSON.stringify(f.outline), `Finalized by ${f.finalizer.label}. ${f.note}`.trim().slice(0, 1000), now(), kid);
  return { ...getDeck(user, kid), finalizer: { id: f.finalizer.id, label: f.finalizer.label } };
}
export function saveDeck(user, kid, { title, outline, template, datasets, images, style, cover }) {
  if (outline && cover !== undefined) outline.cover = cover ? chooseCover(user, cover) : null;
  if (style !== undefined) { const st = sanitizeStyle(style); run(`UPDATE decks SET style=? WHERE id=? AND user_id=?`, st ? JSON.stringify(st) : null, kid, user.id); }
  if (Array.isArray(images)) run(`UPDATE decks SET images=? WHERE id=? AND user_id=?`, JSON.stringify(images.slice(0, 12).map(x => ({ id: String(x.id), label: String(x.label || '').slice(0, 120) })).filter(x => loadImage(user, x.id))), kid, user.id);
  const k = ownDeck(user, kid); if (template && String(template).startsWith('doc:')) referenceDoc(user, template.slice(4)); else if (template) templateRow(user, template);
  run(`UPDATE decks SET title=?, outline=?, template_id=?, datasets=?, updated=? WHERE id=?`, String(title ?? k.title).slice(0, 160) || 'Presentation', outline ? JSON.stringify(sanitizeOutline(outline)) : k.outline,
    template ? (['default', 'plain'].includes(template) ? null : template) : k.template_id, datasets ? JSON.stringify([...new Set(datasets)].slice(0, 6)) : k.datasets, now(), kid);
  return getDeck(user, kid);
}
export async function deckPptx(user, kid) {
  const k = getDeck(user, kid); if (!k.outline) throw err(409, 'This presentation has no outline yet.');
  const tables = deckTables(user, k.datasets); const client = k.clientId ? one(`SELECT * FROM clients WHERE id=?`, k.clientId) : null;
  const images = new Map(k.images.map(x => [x.id, loadImage(user, x.id)]).filter(([, v]) => v));
  const style = k.style || (client?.style ? JSON.parse(client.style) : null); // none chosen → the template's own colours
  for (const c of k.outline.cover?.candidates || []) if (!images.has(c)) { const im = loadImage(user, c); if (im) images.set(c, im); }
  const r = await buildDeck(templateBuf(user, k.template), k.outline, resolver(tables), { ...pickLogos(k.clientId), style, images, cover: k.outline.cover, replace: spellingPairs(client), footer: k.outline.footer || k.title });
  return { ...r, warnings: [...r.warnings, ...checkDeck(user, kid).map(c => c.text)], name: `${k.title.replace(/[^\p{L}\p{N} _-]+/gu, '').trim() || 'presentation'}.pptx` };
}
// Quality checks before delivery, from the team's review rules: slide limit, structure, banned labels and terms,
// fragments, numbering, spelling, and numbers that do not appear in the data.
export function checkDeck(user, kid) {
  const k = getDeck(user, kid); if (!k.outline) return []; const out = []; const add = (level, slide, text) => out.push({ level, slide, text: slide ? `Slide ${slide}: ${text}` : text });
  const client = k.clientId ? one(`SELECT * FROM clients WHERE id=?`, k.clientId) : null; const persona = parsePersona(client?.persona, CLIENT_FIELDS);
  const structText = k.structure || persona.structure || ''; const cap = maxOf(structText) || reportType(k.reportType)?.maxSlides || 0; if (cap && k.outline.slides.length > cap) add('error', 0, `${k.outline.slides.length} slides — the limit for this report is ${cap}.`);
  const wanted = structText.split('\n').map(l => l.replace(/^\s*[\d.)-]+\s*/, '').split(/\s+[—–-]\s+|:/)[0].trim()).filter(l => l && !/^maks|^max/i.test(l) && l.length < 60);
  const titles = k.outline.slides.map(x => (x.title || '').toLowerCase());
  for (const w of wanted) if (!titles.some(t => t.includes(w.toLowerCase().slice(0, 18)))) add('warn', 0, `The report structure asks for “${w}”, but no slide has that title.`);
  const avoid = [...(persona.avoid || '').split(/[,;\n]+/), ...spellingPairs(client).map(([a]) => a)].map(x => x.replace(/^["'“]|["'”]$/g, '').trim()).filter(x => x.length >= 3);
  const numbers = new Set(deckTables(user, k.datasets).flatMap(t => t.rows.slice(0, 20000).flatMap(r => r.map(v => String(v))))); const text = v => String(v || '');
  k.outline.slides.forEach((sl, i) => {
    const n = i + 1; const all = JSON.stringify(sl);
    if (/^\s*\d+[.)]?\s+\S/.test(sl.title || '')) add('warn', n, `title starts with a number (“${sl.title}”).`);
    if (/\b(catatan|pembacaan)\s*:/i.test(all)) add('warn', n, 'contains a “Catatan:” or “Pembacaan:” label — work it into the text.');
    for (const a of avoid) if (new RegExp(`(?<![\\p{L}])${a.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\p{L}])`, 'iu').test(all)) add('warn', n, `uses “${a}”, which the client avoids (spelling rules are applied automatically in the file).`);
    const lines = [...(sl.bullets || []), ...(sl.left || []), ...(sl.right || []), ...(sl.points || []), ...(sl.findings || []).map(f => f.text), sl.caption, sl.focus].filter(Boolean).map(text);
    for (const l of lines) { const words = l.replace(/\*\*/g, '').trim().split(/\s+/); if (words.length <= 3 && !/[.!?]$/.test(l)) add('warn', n, `“${l}” reads like a label, not a sentence.`); }
    for (const m of all.matchAll(/(?<![\w.,])(\d{1,3}(?:\.\d{3})+|\d{3,})(?![\w.,]?\d)/g)) { const raw = m[1]; const plain = raw.replace(/\./g, ''); if (+plain >= 1900 && +plain <= 2100) continue; if (!numbers.has(plain) && !numbers.has(raw)) { add('info', n, `the number ${raw} was not found in the data tables — check it.`); break; } }
  });
  return out;
}
// The catalog the outline editor needs to offer valid sources and columns.
export function deckSources(user, datasetIds) { return deckTables(user, datasetIds).map(t => ({ ref: t.ref, columns: t.columns, rows: t.rows.length, main: !!t.main })); }
export const REPORT_META = { channels: CHANNELS.map(({ id, label }) => ({ id, label })), ops: OPS, kinds: SLIDE_KINDS, presets: STYLE_PRESETS, types: REPORT_TYPES.map(({ id, label, short, period, maxSlides, structure, focus }) => ({ id, label, short, period, maxSlides, structure, focus })) };
