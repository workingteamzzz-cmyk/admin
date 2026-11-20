// Reports: curated spreadsheets and presentation decks built on the organization's own templates.
// The AI only writes *plans* (which steps to run, what each slide says). The data work and the files are produced on
// this server. What the AI may see is limited: column profiles for planning, short texts for labelling, and summary
// tables plus a sample of non-personal columns for writing the slides. Masking applies to everything it receives.
import fs from 'node:fs';
import path from 'node:path';
import { config, ROOT } from './config.mjs';
import { db, one, all, run, id, now, sha256, getSettings, audit } from './db.mjs';
import { Redactor, SYSTEM_NOTE } from './redact.mjs';
import { complete, reportModel, helperModel, limitProblem } from './ai.mjs';
import { search } from './knowledge.mjs';
import { loadWorkbook, profile, sanitizePlan, describe, runPlan, writeXlsx, reportSensitive, OPS, FILTERS, CLEANS, DERIVES, MEASURES } from './tables.mjs';
import { openTemplate, describeTemplate, buildDeck, sanitizeOutline, SLIDE_KINDS } from './slides.mjs';

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
for (const sql of ['ALTER TABLE report_templates ADD COLUMN client_id TEXT', 'ALTER TABLE datasets ADD COLUMN client_id TEXT', 'ALTER TABLE decks ADD COLUMN client_id TEXT']) { try { db.exec(sql); } catch {} }
const DIR = path.join(config.dataDir, 'reports');
fs.mkdirSync(path.join(DIR, 'datasets'), { recursive: true, mode: 0o700 });
fs.mkdirSync(path.join(DIR, 'templates'), { recursive: true, mode: 0o700 });
const DEFAULT_TEMPLATE = path.join(ROOT, 'assets', 'default-template.pptx');
const err = (status, message) => Object.assign(new Error(message), { status });
const dsDir = d => path.join(DIR, 'datasets', d);

/* ================= clients ================= */
// A client is the team's folder for one customer: its templates, saved curation recipes, instructions (voice, key
// messages, sensitivities) and a knowledge collection for its documents. Clients are shared by the whole team.
const clientRow = cid => { if (!cid) return null; const c = one(`SELECT * FROM clients WHERE id=?`, cid); if (!c) throw err(404, 'Client not found'); return c; };
export function listClients() {
  return all(`SELECT c.*, (SELECT COUNT(*) FROM report_templates t WHERE t.client_id=c.id) templates, (SELECT COUNT(*) FROM client_recipes r WHERE r.client_id=c.id) recipes,
    (SELECT COUNT(*) FROM docs d WHERE d.collection_id=c.collection_id) docs FROM clients c ORDER BY c.name COLLATE NOCASE`).map(c => ({ ...c,
    recipeList: all(`SELECT id,name,columns,created FROM client_recipes WHERE client_id=? ORDER BY created DESC`, c.id).map(r => ({ ...r, columns: JSON.parse(r.columns) })) }));
}
export function saveClient(user, cid, { name, description, instructions }) {
  const nm = String(name || '').trim().slice(0, 120); if (!nm) throw err(400, 'Give the client a name.');
  if (one(`SELECT 1 FROM clients WHERE name=? COLLATE NOCASE AND id IS NOT ?`, nm, cid || null)) throw err(409, 'A client with this name already exists.');
  if (cid) { clientRow(cid); run(`UPDATE clients SET name=?, description=?, instructions=?, updated=? WHERE id=?`, nm, String(description || '').slice(0, 500), String(instructions || '').slice(0, 8000), now(), cid); return cid; }
  const nid = id(), col = id();
  run(`INSERT INTO collections(id,name,description,created) VALUES(?,?,?,?)`, col, `Klien · ${nm}`.slice(0, 120), `Documents for client ${nm}: earlier reports, briefs, guidelines.`, now());
  run(`INSERT INTO clients(id,name,description,instructions,collection_id,created_by,created,updated) VALUES(?,?,?,?,?,?,?,?)`, nid, nm, String(description || '').slice(0, 500), String(instructions || '').slice(0, 8000), col, user.id, now(), now());
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
export function deleteRecipe(user, rid) { const r = one(`SELECT * FROM client_recipes WHERE id=?`, rid); if (!r) throw err(404, 'Recipe not found'); run(`DELETE FROM client_recipes WHERE id=?`, rid); return r; }

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
  if (!tid || tid === 'plain' || tid === 'default') return null;
  const r = one(`SELECT * FROM report_templates WHERE id=? AND (owner_id IS NULL OR owner_id=?)`, tid, user.id);
  if (!r) throw err(404, 'Template not found'); return r;
}
function templateBuf(user, tid) { const r = templateRow(user, tid); return fs.readFileSync(r ? path.join(DIR, 'templates', r.id + '.pptx') : PLAIN); }
let plainInfo;
async function templateDesc(user, tid) { const r = templateRow(user, tid); if (!r) { plainInfo ??= await templateInfo(fs.readFileSync(PLAIN)); return { name: 'Plain layout', info: plainInfo }; } return { name: r.name, info: JSON.parse(r.info) }; }
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
async function loadSource(d) { return loadWorkbook(fs.readFileSync(sourceFile(d)), d.filename); }
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
  fs.writeFileSync(sourceFile(d), buf, { mode: 0o600 });
  const main = [...sheets].sort((a, b) => b.rows.length - a.rows.length)[0];
  run(`INSERT INTO datasets(id,user_id,name,filename,size,sheet,rows,created,updated,client_id) VALUES(?,?,?,?,?,?,?,?,?,?)`, did, user.id, filename.replace(/\.(xlsx|csv|tsv)$/i, '').slice(0, 120), filename, buf.length, main.name, main.rows.length, now(), now(), clientId || null);
  return getDataset(user, did);
}
export function listDatasets(user) {
  return all(`SELECT id,name,filename,size,sheet,rows,result_rows,created,updated,client_id clientId,(plan IS NOT NULL) planned,(log IS NOT NULL) curated FROM datasets WHERE user_id=? ORDER BY updated DESC`, user.id);
}
function readResult(did) { const f = path.join(dsDir(did), 'result.json'); return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : null; }
export async function getDataset(user, did) {
  const d = ownDataset(user, did); const sheets = await loadSource(d); const res = readResult(did);
  const plan = d.plan ? JSON.parse(d.plan) : null;
  return { id: d.id, clientId: d.client_id, name: d.name, filename: d.filename, size: d.size, sheet: d.sheet, instruction: d.instruction, created: d.created, updated: d.updated,
    sheets: sheets.map(t => preview(t)), plan: plan && { ...plan, steps: plan.steps.map(s => ({ ...s, text: describe(s) })) }, log: d.log ? JSON.parse(d.log) : null,
    result: res && { table: { name: 'Data', columns: res.table.columns, rows: res.table.rows.length, preview: res.table.rows.slice(0, 50) }, summaries: res.summaries.map(s => ({ ...s, rows: s.rows.slice(0, 200), total: s.rows.length })) } };
}
export function renameDataset(user, did, name) { ownDataset(user, did); run(`UPDATE datasets SET name=?, updated=? WHERE id=?`, String(name || '').trim().slice(0, 120) || 'Dataset', now(), did); }
export function deleteDataset(user, did) { const d = ownDataset(user, did); fs.rmSync(dsDir(d.id), { recursive: true, force: true }); run(`DELETE FROM datasets WHERE id=?`, d.id); return d; }
const pickSheet = (sheets, name) => sheets.find(s => s.name === name) || [...sheets].sort((a, b) => b.rows.length - a.rows.length)[0];

/* ---------- AI helpers ---------- */
function redactorFor(user, scope) { const s = getSettings(); return new Redactor({ userId: user.id, chatId: scope, enabled: s.redaction.enabled, terms: s.redaction.terms, values: [] }); }
function checkLimits(user) { const lim = limitProblem(user); if (lim && lim.code !== 'rate') throw err(402, lim.message); }
function parseJson(text) {
  const t = String(text || '').replace(/^```(?:json)?\s*|\s*```$/g, '');
  const a = t.indexOf('{'), b = t.lastIndexOf('}'); if (a < 0 || b < a) throw new Error('no JSON object');
  return JSON.parse(t.slice(a, b + 1));
}
async function askJson(user, model, system, prompt, purpose, maxTokens, effort = 'medium') {
  let out = await complete(user, model, system, prompt, purpose, maxTokens, effort);
  try { return parseJson(out); } catch {
    out = await complete(user, model, system, prompt + '\n\nIMPORTANT: your previous answer was not valid JSON. Reply with one valid JSON object only, no other text.', purpose, maxTokens, effort);
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
- {"op":"summary","name":sheet name,"group_by":[up to 3 columns],"measures":[{"fn":one of ${MEASURES.join('|')},"column":c,"as":label}],"sort_by":output column,"dir":"desc","top":N,"total":true|false}  percent = share of rows
- {"op":"pivot","name":sheet name,"rows":c,"columns":c,"fn":"count"|"sum"|"avg","value":c,"total":true}  e.g. date × sentiment

Guidelines: start with cleaning (trim, empty_words; date/number where the profile shows mixed formats); standardize obvious variants seen in the common values; remove duplicates; then the user's filters; then summaries useful for the report (for media monitoring: coverage per outlet, sentiment share, issues, daily/weekly trend, top spokespeople, AVE per outlet). Name summaries in the user's language. Keep the plan focused: 4–14 steps. Columns marked "personal" contain personal data: you may filter, dedupe or count by them, but never output their values.`;

export async function planDataset(user, did, { instruction, model: requested, sheet }) {
  checkLimits(user);
  const d = ownDataset(user, did); const sheets = await loadSource(d); const t = pickSheet(sheets, sheet || d.sheet);
  const red = redactorFor(user, 'report:' + did); const model = reportModel(user, requested, 'writing');
  const prof = profile(t, extraCols());
  const prompt = red.mask(`Sheets in the file: ${sheets.map(s => `"${s.name}" (${s.rows.length} rows)`).join(', ')}. Planning for sheet "${t.name}".\n\nColumn profile:\n${JSON.stringify(prof, null, 1)}\n\nUser's instruction:\n${String(instruction || 'Clean this data and prepare the usual summaries for a report.').slice(0, 4000)}`);
  const raw = await askJson(user, model, PLAN_SYSTEM + (red.enabled ? '\n\n' + SYSTEM_NOTE : ''), prompt, 'report.plan', 6000, 'medium');
  const plan = sanitizePlan(unmaskDeep(red, raw));
  run(`UPDATE datasets SET instruction=?, plan=?, sheet=?, updated=? WHERE id=?`, String(instruction || '').slice(0, 4000), JSON.stringify(plan), t.name, now(), did);
  return { plan: { ...plan, steps: plan.steps.map(s => ({ ...s, text: describe(s) })) }, explanation: red.unmask(String(raw.explanation || '')).slice(0, 1500), model: { id: model.id, label: model.label } };
}

// Labels short texts in batches with the cheapest model. Results are cached by (labels, instruction, text).
function makeTagger(user, did) {
  const red = redactorFor(user, 'report:' + did); let model;
  return async (texts, labels, instruction) => {
    model ??= helperModel(user); checkLimits(user);
    let use = labels;
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
    const system = `You label texts${instruction ? `: ${instruction}` : ''}. Allowed labels: ${use.map(l => `"${l}"`).join(', ')}. Choose exactly one allowed label per text. Reply with JSON only: {"1":"label","2":"label",...} using the texts' numbers.${red.enabled ? ' ' + SYSTEM_NOTE : ''}`;
    for (let i = 0; i < todo.length; i += 40) {
      const batch = todo.slice(i, i + 40); checkLimits(user);
      const r = await askJson(user, model, system, batch.map((x, k) => `${k + 1}. ${red.mask(x).replace(/\s+/g, ' ')}`).join('\n'), 'report.tag', 1500, 'low');
      batch.forEach((x, k) => { const v = norm.get(String(r[k + 1] ?? '').trim().toLowerCase()); if (v) run(`INSERT OR REPLACE INTO ai_tag_cache(key,value,created) VALUES(?,?,?)`, keyOf(x), v, now()); });
    }
    return { labels: use, values: texts.map(x => (x ? one(`SELECT value FROM ai_tag_cache WHERE key=?`, keyOf(x))?.value || '' : '')) };
  };
}

export async function runDataset(user, did, { plan: rawPlan, sheet }) {
  const d = ownDataset(user, did); const sheets = await loadSource(d); const t = pickSheet(sheets, sheet || d.sheet);
  const plan = sanitizePlan(rawPlan || (d.plan ? JSON.parse(d.plan) : { steps: [] }));
  const s = getSettings();
  const r = await runPlan(t, plan, { tagger: makeTagger(user, did), maxAiRows: s.reports?.maxAiRows || 3000 });
  fs.writeFileSync(path.join(dsDir(did), 'result.json'), JSON.stringify({ sheet: t.name, table: r.table, summaries: r.summaries, log: r.log, plan, at: now() }), { mode: 0o600 });
  run(`UPDATE datasets SET plan=?, log=?, sheet=?, result_rows=?, updated=? WHERE id=?`, JSON.stringify(plan), JSON.stringify(r.log), t.name, r.table.rows.length, now(), did);
  return { log: r.log, aiRows: r.log.reduce((a, l) => a + (l.aiRows || 0), 0) };
}
export async function datasetXlsx(user, did) {
  const d = ownDataset(user, did); const res = readResult(did); if (!res) throw err(409, 'Run the plan first.');
  const notes = { name: 'Catatan kurasi', columns: ['Langkah', 'Keterangan', 'Baris sebelum', 'Baris sesudah', 'Status'], rows: res.log.map((l, i) => [i + 1, l.text, l.before, l.after, l.ok ? (l.changed != null ? `OK (${l.changed} sel diubah)` : l.aiRows ? `OK (AI: ${l.aiRows} baris)` : 'OK') : 'Dilewati: ' + l.error]), noFilter: true };
  const buf = await writeXlsx([{ name: 'Data', ...res.table }, ...res.summaries, notes]);
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

/* ================= decks ================= */
function ownDeck(user, kid) { const k = one(`SELECT * FROM decks WHERE id=? AND user_id=?`, kid, user.id); if (!k) throw err(404, 'Presentation not found'); return k; }
const deckOut = k => ({ id: k.id, clientId: k.client_id, title: k.title, template: k.template_id || 'plain', datasets: JSON.parse(k.datasets), brief: k.brief, outline: k.outline ? JSON.parse(k.outline) : null, notes: k.notes || '', created: k.created, updated: k.updated });
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

const OUTLINE_SYSTEM = `You are a senior communications analyst. You write report presentations (media monitoring, issue analysis, communication strategy) for a government/organization communications team, based on the data and brief you are given. Canopus turns your outline into slides on the organization's PowerPoint template and fills tables and charts from the real data.

Reply with ONE JSON object only: {"title": deck title, "notes": 1–3 sentences for the user on what you built or what data was missing, "slides": [ ... ]}
Slide kinds:
- {"kind":"title","title":...,"subtitle":"period, unit"}
- {"kind":"section","title":...}
- {"kind":"bullets","title":...,"bullets":["point", "- sub-point", ...]}  max 6 points; use **bold** for key words
- {"kind":"two","title":...,"left_title":...,"left":[...],"right_title":...,"right":[...]}  comparisons, positive vs negative, before/after
- {"kind":"kpi","title":...,"items":[{"value":"1.240","label":"Total pemberitaan","note":"+12% vs minggu lalu"}],"caption":takeaway}  2–4 headline numbers, taken from the data
- {"kind":"chart","title":...,"source":"<Dataset> / <Table>","chart":"column"|"bar"|"line"|"pie"|"doughnut","category":column,"series":[numeric columns],"stacked":bool,"caption":one-sentence insight}
- {"kind":"table","title":...,"source":"<Dataset> / <Table>","columns":[up to 6 columns],"top":N,"caption":insight}
- {"kind":"quote","title":...,"quote":exact quote from the data,"source":"who, outlet, date"}
- {"kind":"matrix","title":...,"quadrants":[{"title":...,"points":[...]}, x4 in reading order: top-left, top-right, bottom-left, bottom-right],"caption":takeaway}  2×2 frameworks: SWOT (Strengths, Weaknesses, Opportunities, Threats), stakeholder map (high influence/supportive ...), risk map, options
- {"kind":"actions","title":...,"rows":[{"action":...,"owner":unit or role,"when":timing,"kpi":how success is measured}],"caption":...}  action plan, 3–8 rows
- {"kind":"closing","title":...,"subtitle":...}
Think and write like a strategy consultant: lead with an executive summary (the 3–4 most important findings and what to do), make every slide title the slide's conclusion ("so what"), separate evidence from interpretation, and end with clear recommendations plus an action plan (owner, timing, success indicator) and the main risks to watch.
Rules: use only numbers and facts present in the data or brief; never invent figures, quotes or outlets. Chart/table sources and column names must match the data catalog exactly. Prefer charts for trends and shares (line for time, doughnut/pie for shares with ≤6 parts, bar for rankings), tables for top lists. Every chart/table slide gets a caption stating the insight. Write in the user's language (usually Indonesian), concise slide titles that state the point. A typical media-monitoring report: title, executive summary, key numbers, sentiment, trend, top outlets, issues, notable coverage/quotes, issue/stakeholder or SWOT matrix, recommendations for communication strategy (key messages, spokespeople, channels), action plan, closing. Follow the template's reference structure when one is given. 8–16 slides unless the brief says otherwise.`;

const FINALIZE_SYSTEM = `You are the second, senior analyst on a report presentation. Another analyst drafted it from the same data. Your job: analyze the data yourself, then finalize both the analysis and the language.

Work in this order:
1. Read the data catalog (curated spreadsheet: summaries and rows) on your own and note the key findings: volumes, shares, trends, peaks, outlets, topics/issues, spokespeople, notable coverage, anything unusual.
2. Compare with the draft: correct claims the data does not support, sharpen weak insights, and add important findings the draft missed.
3. Finalize the language for senior readers.

Reply with ONE JSON object only: {"title": ..., "notes": 1–2 sentences on what you found and changed, "slides": [ ... ]}
- Keep every draft slide, with its "n" number, kind and order. You may rewrite their text: titles as short statements of the point (e.g. "Sentimen negatif naik karena isu distribusi"), concise parallel bullets (max ~15 words), captions as one clear insight, specific recommendations (who, what, when, how success is measured), a strong executive summary (3–4 key findings and actions).
- You may add up to 3 NEW slides (without "n") where the data shows something important the draft missed. Place them where they fit. A new chart or table must use a "source" and column names exactly as in the data catalog.
- Never change "source", "columns", "chart", "category", "series", "stacked" or "top" of draft slides. Never invent facts, quotes, figures or outlets; every number must match the data. Keep placeholders like ⟦NAME_1⟧ exactly.
- Language: the brief's language (usually Indonesian, formal, EYD), consistent terms and number formats.
Slide formats are the same as in the draft (kinds: title, section, bullets, two, kpi, quote, matrix, actions, chart, table, closing).`;

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
  const fin = await askJson(user, finalizer, FINALIZE_SYSTEM + (red.enabled ? '\n\n' + SYSTEM_NOTE : ''), `Brief from the user:\n${red.mask(String(brief || '').slice(0, 4000))}\n\nData catalog (the curated spreadsheet — analyze it yourself):${red.mask(catalog).slice(0, 90000)}\n\nDraft outline from the first analyst:\n${draft}`, 'report.finalize', 16000, 'medium');
  const one_ = r => sanitizeOutline({ slides: [r] }).slides[0];
  const LOCK = ['kind', 'source', 'columns', 'top', 'chart', 'category', 'series', 'stacked'];
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
  const result = { title: (typeof fin.title === 'string' && fin.title.trim() ? red.unmask(fin.title).slice(0, 160) : outline.title), slides: out.map(({ added: _a, _n: _b, ...x }) => x).slice(0, 40) };
  const note = [red.unmask(String(fin.notes || '')), added ? `${finalizer.label} added ${added} slide${added > 1 ? 's' : ''} from its own reading of the data.` : '', kept ? `${kept} draft slide${kept > 1 ? 's were' : ' was'} kept unchanged.` : ''].filter(Boolean).join(' ');
  return { outline: result, finalizer, note };
}

export async function draftDeck(user, { title, template, datasets = [], brief, model: requested, finalizeModel, knowledge, client: clientId }) {
  checkLimits(user); const client = clientRow(clientId);
  const ids = [...new Set(datasets)].slice(0, 6); const tables = deckTables(user, ids);
  const tdesc = await templateDesc(user, template);
  const model = reportModel(user, requested, 'writing'); const kid = id();
  const red = redactorFor(user, 'deck:' + kid); const catalog = catalogText(tables);
  let excerpts = '';
  if (knowledge && brief) { const hits = search(user, String(brief).slice(0, 300), { limit: 6, collections: client?.collection_id ? [client.collection_id] : null }).filter(h => !h.localOnly); if (hits.length) excerpts = `\n\nRelevant internal documents:\n${hits.map((h, i) => `[${i + 1}] ${h.title}${h.page ? ' p.' + h.page : ''}: ${h.text.slice(0, 900)}`).join('\n')}`; }
  const struct = tdesc.info.structure?.length ? `\n\nReference structure from the template "${tdesc.name}" (slides in an earlier report; follow its order and style, with new content):\n${tdesc.info.structure.map((s, i) => `${i + 1}. ${s.title || '(no title)'}${s.has?.length ? ` [${s.has.join(', ')}]` : ''}${s.text ? ' — ' + s.text.slice(0, 160) : ''}`).join('\n')}` : '';
  const clientNote = client ? `Client: ${client.name}${client.description ? ` — ${client.description}` : ''}${client.instructions ? `\nClient guidelines (voice, key messages, terms to use or avoid, audiences) — follow them:\n${client.instructions}` : ''}\n\n` : '';
  const prompt = red.mask(`${clientNote}Brief from the user:\n${String(brief || 'Create a report presentation from this data.').slice(0, 6000)}${title ? `\n\nWorking title: ${title}` : ''}\n\nToday: ${new Date().toISOString().slice(0, 10)}${struct}\n\nData catalog:${catalog || '\n(no datasets attached — write from the brief only, without charts or tables)'}${excerpts}`);
  const raw = await askJson(user, model, OUTLINE_SYSTEM + (red.enabled ? '\n\n' + SYSTEM_NOTE : ''), prompt, 'report.outline', 12000, 'medium');
  let outline = sanitizeOutline(unmaskDeep(red, raw)); let notes = red.unmask(String(raw.notes || ''));
  if (!outline.slides.length) throw err(502, 'The AI did not return any slides. Try again with a more specific brief.');
  let finalizer = null;
  if (finalizeModel && finalizeModel !== 'none') { const f = await finalizeOutline(user, outline, { brief: (client?.instructions ? `Client guidelines: ${client.instructions}\n\n` : '') + (brief || ''), catalog: catalogText(tables, 150), finalizeModel, red }); outline = f.outline; finalizer = f.finalizer; notes = [notes, f.note].filter(Boolean).join(' '); }
  notes = [`Analysis: ${model.label}${finalizer ? ` · finalized by ${finalizer.label}` : ''}.`, notes].filter(Boolean).join(' ');
  const t = String(title || outline.title || 'Presentation').slice(0, 160);
  run(`INSERT INTO decks(id,user_id,title,template_id,datasets,brief,outline,notes,created,updated,client_id) VALUES(?,?,?,?,?,?,?,?,?,?,?)`, kid, user.id, t, template && !['default', 'plain'].includes(template) ? template : null, JSON.stringify(ids), String(brief || '').slice(0, 6000), JSON.stringify(outline), notes.slice(0, 1000), now(), now(), client?.id || null);
  return { ...getDeck(user, kid), model: { id: model.id, label: model.label }, finalizer: finalizer && { id: finalizer.id, label: finalizer.label } };
}
// Finalize (again) after the user edited the slides.
export async function refinalizeDeck(user, kid, { finalizeModel }) {
  checkLimits(user); const k = getDeck(user, kid); if (!k.outline) throw err(409, 'This presentation has no outline yet.');
  const red = redactorFor(user, 'deck:' + kid);
  const c = k.clientId ? one(`SELECT instructions FROM clients WHERE id=?`, k.clientId) : null;
  const f = await finalizeOutline(user, k.outline, { brief: (c?.instructions ? `Client guidelines: ${c.instructions}\n\n` : '') + k.brief, catalog: catalogText(deckTables(user, k.datasets), 150), finalizeModel, red });
  run(`UPDATE decks SET outline=?, notes=?, updated=? WHERE id=?`, JSON.stringify(f.outline), `Finalized by ${f.finalizer.label}. ${f.note}`.trim().slice(0, 1000), now(), kid);
  return { ...getDeck(user, kid), finalizer: { id: f.finalizer.id, label: f.finalizer.label } };
}
export function saveDeck(user, kid, { title, outline, template, datasets }) {
  const k = ownDeck(user, kid); if (template) templateRow(user, template);
  run(`UPDATE decks SET title=?, outline=?, template_id=?, datasets=?, updated=? WHERE id=?`, String(title ?? k.title).slice(0, 160) || 'Presentation', outline ? JSON.stringify(sanitizeOutline(outline)) : k.outline,
    template ? (['default', 'plain'].includes(template) ? null : template) : k.template_id, datasets ? JSON.stringify([...new Set(datasets)].slice(0, 6)) : k.datasets, now(), kid);
  return getDeck(user, kid);
}
export async function deckPptx(user, kid) {
  const k = getDeck(user, kid); if (!k.outline) throw err(409, 'This presentation has no outline yet.');
  const tables = deckTables(user, k.datasets);
  const r = await buildDeck(templateBuf(user, k.template), k.outline, resolver(tables));
  return { ...r, name: `${k.title.replace(/[^\p{L}\p{N} _-]+/gu, '').trim() || 'presentation'}.pptx` };
}
// The catalog the outline editor needs to offer valid sources and columns.
export function deckSources(user, datasetIds) { return deckTables(user, datasetIds).map(t => ({ ref: t.ref, columns: t.columns, rows: t.rows.length, main: !!t.main })); }
export const REPORT_META = { ops: OPS, kinds: SLIDE_KINDS };
