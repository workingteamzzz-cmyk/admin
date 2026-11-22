// Internal knowledge: text extraction, chunking, local full-text index, and permission-aware search.
// Nothing here calls an external service; documents are indexed on this server only.
import fs from 'node:fs';
import path from 'node:path';
import { db, one, all, run, id, now, sha256, tx, allowedCollections, getSettings } from './db.mjs';
import { config, CLASSIFICATIONS } from './config.mjs';

const TEXT_EXT = /\.(txt|md|markdown|json|xml|ya?ml|log)$/i;
const HTML_EXT = /\.html?$/i;

/* ---------- extraction ---------- */
let pdfjs;
async function pdfPages(buf) {
  pdfjs ??= await import('pdfjs-dist/legacy/build/pdf.mjs');
  const doc = await pdfjs.getDocument({ data: new Uint8Array(buf), isEvalSupported: false, disableFontFace: true, useSystemFonts: false, verbosity: 0 }).promise;
  const pages = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const p = await doc.getPage(i); const tc = await p.getTextContent();
    pages.push(tc.items.map(it => it.str + (it.hasEOL ? '\n' : ' ')).join('').replace(/[ \t]+\n/g, '\n').trim());
  }
  await (doc.cleanup?.() ?? null);
  return pages;
}
/* ---------- tables (CSV / TSV / XLSX) ---------- */
// Columns whose values are personal data. Values in these columns are always masked before reaching the AI.
const SENSITIVE_COLS = [
  ['ID', /\b(nik|no\.?\s*rm|nomor rekam medis|rekam medis|mrn|nip|npwp|no\.?\s*(ktp|kk|bpjs|identitas|pasien)|id\s*pasien|patient\s*id|medical record)\b/i],
  ['NAME', /\b(nama|name|pasien|patient|keluarga|wali|penanggung jawab)\b/i],
  ['ADDRESS', /\b(alamat|address|domisili)\b/i],
  ['PHONE', /\b(telepon|telp|no\.?\s*hp|hp|phone|whatsapp|wa|ponsel)\b/i],
  ['EMAIL', /\be-?mail\b/i],
  ['DOB', /\b(tgl\.?\s*lahir|tanggal lahir|date of birth|dob|ttl)\b/i],
];
export function sensitiveKind(header, extra = []) { for (const [k, re] of SENSITIVE_COLS) if (re.test(header)) return k; const h = String(header).toLowerCase(); if (extra.some(x => x && h.includes(String(x).toLowerCase()))) return 'DATA'; return null; }
function parseDelimited(text, delim) {
  const rows = []; let row = [], cell = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else q = false; } else cell += c; }
    else if (c === '"') q = true; else if (c === delim) { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') { if (c === '\r' && text[i + 1] === '\n') i++; row.push(cell); rows.push(row); row = []; cell = ''; }
    else cell += c;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows.filter(r => r.some(v => String(v).trim()));
}
// Minimal, dependency-light XLSX reader (an .xlsx file is a zip of XML parts). Reads cell values, shared strings
// and date formats; ignores formulas' logic (uses cached results), styles and charts.
const XML_ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
const unxml = t => String(t).replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e) => e[0] === '#' ? String.fromCodePoint(e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : +e.slice(1)) : XML_ENT[e] ?? m);
const attr = (tag, name) => tag.match(new RegExp(`\\s${name}="([^"]*)"`))?.[1];
function colIndex(ref) { const l = ref.match(/^[A-Z]+/)?.[0] || 'A'; let n = 0; for (const c of l) n = n * 26 + (c.charCodeAt(0) - 64); return n - 1; }
function excelDate(serial) { const d = new Date(Math.round((serial - 25569) * 864e5)); return isNaN(d) ? String(serial) : d.toISOString().slice(0, 10); }
async function readXlsx(buf) {
  const JSZip = (await import('jszip')).default; const zip = await JSZip.loadAsync(buf);
  const file = async n => { const f = zip.file(n); return f ? f.async('string') : ''; };
  if (Object.keys(zip.files).length > 2000) throw new Error('Spreadsheet has too many parts');
  const shared = [...(await file('xl/sharedStrings.xml')).matchAll(/<si>([\s\S]*?)<\/si>/g)].map(m => unxml([...m[1].matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map(t => t[1]).join('')));
  const styles = await file('xl/styles.xml');
  const customFmt = Object.fromEntries([...styles.matchAll(/<numFmt\s[^>]*>/g)].map(m => [attr(m[0], 'numFmtId'), unxml(attr(m[0], 'formatCode') || '')]));
  const xfs = (styles.match(/<cellXfs[^>]*>([\s\S]*?)<\/cellXfs>/)?.[1] || '').match(/<xf\s[^>]*?\/?>/g) || [];
  const isDateStyle = xfs.map(x => { const id = +attr(x, 'numFmtId'); return (id >= 14 && id <= 22) || (id >= 45 && id <= 47) || /(^|[^"\\])[dmy]/i.test((customFmt[id] || '').replace(/"[^"]*"/g, '')); });
  const wb = await file('xl/workbook.xml'); const rels = await file('xl/_rels/workbook.xml.rels');
  const relTarget = Object.fromEntries([...rels.matchAll(/<Relationship\s[^>]*>/g)].map(m => [attr(m[0], 'Id'), attr(m[0], 'Target')]));
  const sheets = [];
  for (const m of wb.matchAll(/<sheet\s[^>]*>/g)) {
    const name = unxml(attr(m[0], 'name') || 'Sheet'); let target = relTarget[attr(m[0], 'r:id')] || ''; target = target.replace(/^\/?(xl\/)?/, 'xl/');
    const xml = await file(target); const rows = [];
    for (const r of xml.matchAll(/<row[^>]*>([\s\S]*?)<\/row>/g)) {
      const vals = [];
      for (const c of r[1].matchAll(/<c\s([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
        const a = ' ' + c[1]; const t = attr(a, 't'); const sIdx = +(attr(a, 's') || 0); const inner = c[2] || '';
        let v = inner.match(/<v>([\s\S]*?)<\/v>/)?.[1];
        if (t === 's') v = shared[+v] ?? ''; else if (t === 'inlineStr') v = [...inner.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map(x => unxml(x[1])).join('');
        else if (t === 'b') v = v === '1' ? 'TRUE' : 'FALSE'; else if (v != null && t !== 'str' && t !== 'e' && isDateStyle[sIdx] && !isNaN(+v)) v = excelDate(+v); else v = v == null ? '' : unxml(v);
        vals[colIndex(attr(a, 'r') || 'A')] = String(v);
      }
      if (vals.some(x => x && x.trim())) rows.push(Array.from(vals, x => x ?? ''));
    }
    if (rows.length) sheets.push({ name, rows });
  }
  return sheets;
}
export async function readSheets(buf, filename) {
  if (/\.xlsx$/i.test(filename)) return readXlsx(buf);
  const text = buf.toString('utf8').replace(/^\uFEFF/, '');
  const first = text.split('\n')[0]; const delim = /\.tsv$/i.test(filename) ? '\t' : (first.split(';').length > first.split(',').length ? ';' : ',');
  return [{ name: filename, rows: parseDelimited(text, delim) }];
}
// Turns a table into readable "Column: value" lines (one per row) and collects values of sensitive columns.
export async function extractTable(buf, filename) {
  const sheets = await readSheets(buf, filename); const pages = []; const sensitive = [];
  for (const sh of sheets) {
    const [header, ...rows] = sh.rows; if (!header) continue;
    const head = header.map((h, i) => String(h || `Column ${i + 1}`).trim());
    const extra = getSettings().redaction.columns || []; const kinds = head.map(h => sensitiveKind(h, extra));
    const lines = rows.map((r, n) => { r.forEach((v, i) => { const val = String(v ?? '').trim(); if (kinds[i] && val.length >= 3) sensitive.push({ kind: kinds[i], value: val }); });
      return `Row ${n + 1} — ` + head.map((h, i) => `${h}: ${String(r[i] ?? '').trim() || '-'}`).join('; '); });
    pages.push((sheets.length > 1 ? `Sheet: ${sh.name}\n` : '') + `Columns: ${head.join(', ')}\n` + lines.join('\n'));
  }
  return { pages, sensitive, table: true };
}
export async function extractDoc(buf, filename, mime = '') {
  if (/\.(csv|tsv|xlsx)$/i.test(filename)) return extractTable(buf, filename);
  return { pages: await extractText(buf, filename, mime), sensitive: [], table: false };
}

async function pptxSlides(buf) {
  const JSZip = (await import('jszip')).default; const zip = await JSZip.loadAsync(buf);
  const pres = await zip.file('ppt/presentation.xml')?.async('string') || ''; const rels = await zip.file('ppt/_rels/presentation.xml.rels')?.async('string') || '';
  const target = Object.fromEntries([...rels.matchAll(/<Relationship\b[^>]*\/>/g)].map(m => [attr(m[0], 'Id'), attr(m[0], 'Target')]));
  const out = [];
  for (const m of pres.matchAll(/<p:sldId\b[^>]*>/g)) {
    const t = target[attr(m[0], 'r:id')]; const x = t ? await zip.file('ppt/' + t.replace(/^\/?ppt\//, ''))?.async('string') : ''; if (!x) continue;
    const paras = [...x.matchAll(/<a:p>([\s\S]*?)<\/a:p>/g)].map(p => [...p[1].matchAll(/<a:t>([\s\S]*?)<\/a:t>/g)].map(r => unxml(r[1])).join('')).filter(Boolean);
    const tables = [...x.matchAll(/<a:tr\b[\s\S]*?<\/a:tr>/g)].length; const charts = (x.match(/drawingml\/2006\/chart/g) || []).length;
    out.push(`Slide ${out.length + 1}${charts ? ' [chart]' : ''}${tables ? ' [table]' : ''}\n${paras.join('\n')}`);
  }
  return out;
}
export async function extractText(buf, filename, mime = '') {
  if (/\.pptx$/i.test(filename)) return pptxSlides(buf);
  if (/\.pdf$/i.test(filename) || mime === 'application/pdf') return pdfPages(buf);
  if (/\.docx$/i.test(filename)) { const mammoth = (await import('mammoth')).default; const r = await mammoth.extractRawText({ buffer: buf }); return [r.value]; }
  if (HTML_EXT.test(filename)) return [buf.toString('utf8').replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+\n/g, '\n')];
  if (/\.(csv|tsv|xlsx)$/i.test(filename)) return (await extractTable(buf, filename)).pages;
  if (TEXT_EXT.test(filename) || /^text\//.test(mime)) return [buf.toString('utf8')];
  throw Object.assign(new Error('Unsupported file type. Use PDF, DOCX, XLSX, CSV, TXT, MD or HTML.'), { status: 415 });
}

/* ---------- chunking ---------- */
const TARGET = 1100, OVERLAP = 180;
export function chunkTable(pages) {
  const out = [];
  pages.forEach((text, pi) => {
    const lines = text.split('\n'); const head = lines.filter(l => /^(Sheet|Columns):/.test(l)).join('\n'); let cur = [];
    const flush = () => { if (cur.length) out.push({ page: null, text: (head ? head + '\n' : '') + cur.join('\n') }); cur = []; };
    for (const l of lines.filter(l => !/^(Sheet|Columns):/.test(l))) { if (cur.join('\n').length + l.length > TARGET && cur.length) flush(); cur.push(l); }
    flush();
  });
  return out;
}
export function chunkPages(pages) {
  const out = [];
  pages.forEach((text, pi) => {
    const paras = text.split(/\n{2,}|(?<=[.!?])\s*\n/).map(s => s.replace(/\s+/g, ' ').trim()).filter(Boolean);
    let cur = '';
    const pushCur = () => { if (cur.trim().length > 20) out.push({ page: pi + 1, text: cur.trim() }); };
    for (let p of paras) {
      while (p.length > TARGET * 1.5) { // very long paragraph: split on sentences
        const cut = p.lastIndexOf('. ', TARGET) > TARGET * 0.5 ? p.lastIndexOf('. ', TARGET) + 1 : TARGET;
        if (cur) { pushCur(); cur = ''; }
        out.push({ page: pi + 1, text: p.slice(0, cut).trim() }); p = p.slice(Math.max(0, cut - OVERLAP));
      }
      if ((cur + ' ' + p).length > TARGET && cur) { pushCur(); cur = cur.slice(-OVERLAP).replace(/^\S*\s/, '') + ' ' + p; }
      else cur = cur ? cur + '\n' + p : p;
    }
    pushCur();
  });
  return out;
}

/* ---------- ingest ---------- */
export function classificationProblem(c) {
  const k = CLASSIFICATIONS[c];
  if (!k) return 'Choose a classification.';
  if (!k.allowed) return `${k.label} documents may not be added to the knowledge base. They are not stored.`;
  return null;
}
export async function ingestDoc({ collectionId, filename, mime, buf, classification, title, userId }) {
  const problem = classificationProblem(classification);
  if (problem) throw Object.assign(new Error(problem), { status: 422 });
  if (!one(`SELECT 1 FROM collections WHERE id=?`, collectionId)) throw Object.assign(new Error('Collection not found'), { status: 404 });
  const hash = sha256(buf);
  const dup = one(`SELECT title FROM docs WHERE collection_id=? AND sha256=?`, collectionId, hash);
  if (dup) throw Object.assign(new Error(`This file is already in the collection as “${dup.title}”.`), { status: 409 });
  const docId = id();
  const dir = path.join(config.dataDir, 'docs'); const file = path.join(dir, docId);
  fs.writeFileSync(file, buf, { mode: 0o600 });
  const docTitle = String(title || filename.replace(/\.[^.]+$/, '')).slice(0, 160);
  run(`INSERT INTO docs(id,collection_id,title,filename,mime,size,classification,status,sha256,uploaded_by,created) VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
    docId, collectionId, docTitle, filename.slice(0, 200), mime, buf.length, classification, 'processing', hash, userId, now());
  try {
    const { pages, sensitive, table } = await extractDoc(buf, filename, mime);
    const chunks = table ? chunkTable(pages) : chunkPages(pages);
    if (!chunks.length) throw new Error('No readable text found. Scanned PDFs need OCR before they can be indexed.');
    tx(() => {
      const ins = db.prepare(`INSERT INTO kchunks(text,title,doc_id,page,idx) VALUES(?,?,?,?,?)`);
      chunks.forEach((c, i) => ins.run(c.text, docTitle, docId, pages.length > 1 ? c.page : null, i));
      run(`UPDATE docs SET status='ready', chunks=?, pages=?, sensitive=? WHERE id=?`, chunks.length, table ? 0 : pages.length, new Set(sensitive.map(x => x.value)).size, docId);
      const insS = db.prepare(`INSERT OR IGNORE INTO doc_sensitive(doc_id,kind,value) VALUES(?,?,?)`);
      for (const v of sensitive) insS.run(docId, v.kind, v.value.slice(0, 200));
    });
    sensitiveCache = null;
  } catch (e) {
    run(`UPDATE docs SET status='error', error=? WHERE id=?`, String(e.message).slice(0, 300), docId);
  }
  return one(`SELECT * FROM docs WHERE id=?`, docId);
}
// All values from sensitive table columns, used by the masker. Cached; reset when documents change.
let sensitiveCache = null;
export function sensitiveValues() { return (sensitiveCache ??= all(`SELECT DISTINCT kind, value FROM doc_sensitive`)); }
export function deleteDoc(docId) {
  tx(() => { run(`DELETE FROM kchunks WHERE doc_id=?`, docId); run(`DELETE FROM doc_sensitive WHERE doc_id=?`, docId); run(`DELETE FROM docs WHERE id=?`, docId); });
  sensitiveCache = null;
  fs.rmSync(path.join(config.dataDir, 'docs', docId), { force: true });
}
export function deleteCollection(cid) {
  for (const d of all(`SELECT id FROM docs WHERE collection_id=?`, cid)) deleteDoc(d.id);
  run(`DELETE FROM collections WHERE id=?`, cid);
}

/* ---------- search ---------- */
const STOP = new Set('yang dan atau dari untuk dengan pada dalam ini itu adalah akan oleh juga sudah telah bagi tentang serta para kami kita mereka the and for with that this from are was were what which who how apa siapa bagaimana kapan berapa'.split(' '));
export function ftsQuery(q) {
  const words = [...new Set((String(q).toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) || []).filter(w => !STOP.has(w)))].slice(0, 12);
  return words.length ? words.map(w => `"${w}"`).join(' OR ') : null;
}
// includeLocalOnly: only true when the answer comes from a model on this server (or no AI at all).
export function search(user, query, { limit = 6, collections = null, includeLocalOnly = false } = {}) {
  const match = ftsQuery(query);
  let cols = allowedCollections(user);
  if (!includeLocalOnly) cols = cols.filter(c => !c.local_only);
  if (collections?.length) cols = cols.filter(c => collections.includes(c.id));
  if (!match || !cols.length) return [];
  const colIds = cols.map(c => c.id);
  const rows = all(`SELECT k.text, k.title, k.doc_id, k.page, k.idx, bm25(kchunks, 1.0, 0.6) score, d.collection_id, d.classification
    FROM kchunks k JOIN docs d ON d.id = k.doc_id
    WHERE kchunks MATCH ? AND d.status='ready' AND d.classification IN ('biasa','terbatas')
      AND d.collection_id IN (${colIds.map(() => '?').join(',')})
    ORDER BY score LIMIT 40`, match, ...colIds);
  const perDoc = new Map(); const out = [];
  for (const r of rows) { const n = perDoc.get(r.doc_id) || 0; if (n >= 3) continue; perDoc.set(r.doc_id, n + 1); out.push(r); if (out.length >= limit) break; }
  const colName = Object.fromEntries(cols.map(c => [c.id, c.name]));
  const localIds = new Set(cols.filter(c => c.local_only).map(c => c.id));
  return out.map(r => ({ docId: r.doc_id, title: r.title, page: r.page, text: r.text, collection: colName[r.collection_id], classification: r.classification, localOnly: localIds.has(r.collection_id) }));
}
