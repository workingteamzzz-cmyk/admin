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
async function readSheets(buf, filename) {
  if (/\.xlsx$/i.test(filename)) {
    const ExcelJS = (await import('exceljs')).default; const wb = new ExcelJS.Workbook(); await wb.xlsx.load(buf);
    const sheets = [];
    wb.eachSheet(ws => { const rows = [];
      ws.eachRow({ includeEmpty: false }, r => { const vals = []; r.eachCell({ includeEmpty: true }, (c, i) => { let v = c.value; if (v instanceof Date) v = v.toISOString().slice(0, 10); else if (v && typeof v === 'object') v = v.text ?? v.result ?? (v.richText ? v.richText.map(t => t.text).join('') : ''); vals[i - 1] = v == null ? '' : String(v); }); rows.push(vals.map(v => v ?? '')); });
      if (rows.length) sheets.push({ name: ws.name, rows }); });
    return sheets;
  }
  const text = buf.toString('utf8').replace(/^﻿/, '');
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

export async function extractText(buf, filename, mime = '') {
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
