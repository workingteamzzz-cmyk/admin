// Internal knowledge: text extraction, chunking, local full-text index, and permission-aware search.
// Nothing here calls an external service; documents are indexed on this server only.
import fs from 'node:fs';
import path from 'node:path';
import { db, one, all, run, id, now, sha256, tx, allowedCollections } from './db.mjs';
import { config, CLASSIFICATIONS } from './config.mjs';

const TEXT_EXT = /\.(txt|md|markdown|csv|tsv|json|xml|ya?ml|log)$/i;
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
export async function extractText(buf, filename, mime = '') {
  if (/\.pdf$/i.test(filename) || mime === 'application/pdf') return pdfPages(buf);
  if (/\.docx$/i.test(filename)) { const mammoth = (await import('mammoth')).default; const r = await mammoth.extractRawText({ buffer: buf }); return [r.value]; }
  if (HTML_EXT.test(filename)) return [buf.toString('utf8').replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+\n/g, '\n')];
  if (TEXT_EXT.test(filename) || /^text\//.test(mime)) return [buf.toString('utf8')];
  throw Object.assign(new Error('Unsupported file type. Use PDF, DOCX, TXT, MD, CSV or HTML.'), { status: 415 });
}

/* ---------- chunking ---------- */
const TARGET = 1100, OVERLAP = 180;
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
    const pages = await extractText(buf, filename, mime);
    const chunks = chunkPages(pages);
    if (!chunks.length) throw new Error('No readable text found. Scanned PDFs need OCR before they can be indexed.');
    tx(() => {
      const ins = db.prepare(`INSERT INTO kchunks(text,title,doc_id,page,idx) VALUES(?,?,?,?,?)`);
      chunks.forEach((c, i) => ins.run(c.text, docTitle, docId, pages.length > 1 ? c.page : null, i));
      run(`UPDATE docs SET status='ready', chunks=?, pages=? WHERE id=?`, chunks.length, pages.length, docId);
    });
  } catch (e) {
    run(`UPDATE docs SET status='error', error=? WHERE id=?`, String(e.message).slice(0, 300), docId);
  }
  return one(`SELECT * FROM docs WHERE id=?`, docId);
}
export function deleteDoc(docId) {
  tx(() => { run(`DELETE FROM kchunks WHERE doc_id=?`, docId); run(`DELETE FROM docs WHERE id=?`, docId); });
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
export function search(user, query, { limit = 6 } = {}) {
  const match = ftsQuery(query);
  const cols = allowedCollections(user);
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
  return out.map(r => ({ docId: r.doc_id, title: r.title, page: r.page, text: r.text, collection: colName[r.collection_id], classification: r.classification }));
}
