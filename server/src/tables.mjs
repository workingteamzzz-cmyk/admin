// Table engine for reports: reads spreadsheets, profiles columns, runs a curation plan step by step, builds
// summaries/pivots, and writes .xlsx files. Everything here runs on this server; nothing calls an AI except the
// optional `tagger` callback that the caller passes in for "ai_tag" steps.
import { readSheets, sensitiveKind } from './knowledge.mjs';

/* ================= value parsing ================= */
const MONTHS_ID = ['januari', 'februari', 'maret', 'april', 'mei', 'juni', 'juli', 'agustus', 'september', 'oktober', 'november', 'desember'];
const MONTHS_EN = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
const MON_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'Mei', 'Jun', 'Jul', 'Agu', 'Sep', 'Okt', 'Nov', 'Des'];
const DAYS_ID = ['Minggu', 'Senin', 'Selasa', 'Rabu', 'Kamis', 'Jumat', 'Sabtu'];
const s = v => (v == null ? '' : String(v));
const pad = n => String(n).padStart(2, '0');

// "1.234.567" (Indonesian), "1,234,567.5" (English), "1,5", "Rp 2.000", "45%" → number; otherwise null.
export function toNumber(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  let t = s(v).trim().replace(/^rp\.?\s*/i, '').replace(/\s/g, '').replace(/%$/, '');
  if (!t || !/^[-+]?[\d.,]+$/.test(t) || !/\d/.test(t)) return null;
  if (/^[-+]?\d{1,3}(\.\d{3})+(,\d+)?$/.test(t)) t = t.replace(/\./g, '').replace(',', '.');
  else if (/^[-+]?\d{1,3}(,\d{3})+(\.\d+)?$/.test(t)) t = t.replace(/,/g, '');
  else if (/^[-+]?\d+,\d+$/.test(t)) t = t.replace(',', '.');
  else if (!/^[-+]?\d+(\.\d+)?$/.test(t)) return null;
  const n = +t; return Number.isFinite(n) ? n : null;
}
const validYmd = (y, m, d) => y >= 1900 && y <= 2100 && m >= 1 && m <= 12 && d >= 1 && d <= 31;
// ISO, dd/mm/yyyy, dd-mm-yyyy, "12 Januari 2026", "12 Jan 2026", "Jan 12, 2026" → "YYYY-MM-DD"; otherwise null.
export function toDate(v) {
  const t = s(v).trim(); if (!t) return null; let m;
  if ((m = t.match(/^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T\s].*)?$/))) return validYmd(+m[1], +m[2], +m[3]) ? `${m[1]}-${pad(m[2])}-${pad(m[3])}` : null;
  if ((m = t.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})(?:\s.*)?$/))) return validYmd(+m[3], +m[2], +m[1]) ? `${m[3]}-${pad(m[2])}-${pad(m[1])}` : null;
  const mon = w => { const x = w.toLowerCase().replace(/\.$/, ''); let i = MONTHS_ID.findIndex(n => n === x || (x.length >= 3 && n.startsWith(x))); if (i < 0) i = MONTHS_EN.findIndex(n => n === x || (x.length >= 3 && n.startsWith(x))); if (i < 0 && x === 'agu') i = 7; if (i < 0 && x === 'okt') i = 9; if (i < 0 && x === 'des') i = 11; return i + 1; };
  if ((m = t.match(/^(?:\w+,\s*)?(\d{1,2})\s+([A-Za-z.]+)\s+(\d{4})(?:\s.*)?$/))) { const mo = mon(m[2]); return mo && validYmd(+m[3], mo, +m[1]) ? `${m[3]}-${pad(mo)}-${pad(m[1])}` : null; }
  if ((m = t.match(/^([A-Za-z.]+)\s+(\d{1,2}),?\s+(\d{4})$/))) { const mo = mon(m[1]); return mo && validYmd(+m[3], mo, +m[2]) ? `${m[3]}-${pad(mo)}-${pad(m[2])}` : null; }
  return null;
}
const cmpText = v => s(v).trim().replace(/\s+/g, ' ').toLowerCase();
const titleCase = t => t.toLowerCase().replace(/(^|[\s\-/(])(\p{L})/gu, (a, b, c) => b + c.toUpperCase());
const EMPTY_WORDS = new Set(['-', '--', 'n/a', 'na', 'null', 'none', 'nil', '#n/a', 'tidak ada', '(blank)', '?']);
function isoWeek(iso) { const d = new Date(iso + 'T00:00:00Z'); const day = (d.getUTCDay() + 6) % 7; d.setUTCDate(d.getUTCDate() - day + 3); const y = d.getUTCFullYear(); const first = new Date(Date.UTC(y, 0, 4)); return `${y}-W${pad(1 + Math.round(((d - first) / 864e5 - 3 + ((first.getUTCDay() + 6) % 7)) / 7))}`; }
function hostOf(v) { const t = s(v).trim(); if (!t) return ''; try { return new URL(/^https?:\/\//i.test(t) ? t : 'http://' + t).hostname.replace(/^(www|m|amp|mobile)\./i, '').toLowerCase(); } catch { return ''; } }

/* ================= loading & profiling ================= */
// Picks the header row: the first row (within the first 15) that is mostly filled. Title rows above it are skipped.
function toTable(name, rows) {
  const width = Math.max(0, ...rows.slice(0, 50).map(r => r.filter(v => s(v).trim()).length));
  let h = rows.slice(0, 15).findIndex(r => r.filter(v => s(v).trim()).length >= Math.max(1, Math.ceil(width * 0.6)));
  if (h < 0) h = 0;
  const header = rows[h] || []; const n = Math.max(header.length, ...rows.slice(h + 1, h + 200).map(r => r.length));
  const seen = new Map(); const columns = [];
  for (let i = 0; i < n; i++) { let c = s(header[i]).trim().replace(/\s+/g, ' ') || `Column ${i + 1}`; const k = c.toLowerCase(); if (seen.has(k)) { seen.set(k, seen.get(k) + 1); c = `${c} (${seen.get(k)})`; } else seen.set(k, 1); columns.push(c); }
  const body = rows.slice(h + 1).map(r => Array.from({ length: n }, (_, i) => s(r[i]).trim())).filter(r => r.some(Boolean));
  return { name, columns, rows: body, skipped: h };
}
export async function loadWorkbook(buf, filename) {
  const sheets = await readSheets(buf, filename);
  return sheets.map(sh => toTable(sh.name, sh.rows)).filter(t => t.columns.length);
}

// Personal-data columns. In reports, a column called just "Nama"/"Name" (e.g. "Nama Media") is not treated as personal
// unless it clearly refers to a person such as a patient or family member; ID numbers, phones, e-mails, addresses and
// dates of birth always are, plus any column the administrator listed.
export function reportSensitive(header, extra = []) {
  const k = sensitiveKind(header, extra);
  if (k === 'NAME' && !/\b(pasien|patient|keluarga|wali|penanggung jawab|pelapor|korban)\b/i.test(header)) return null;
  return k;
}
export function columnType(values) {
  const f = values.filter(v => s(v).trim()); if (!f.length) return 'empty';
  const sample = f.length > 400 ? f.filter((_, i) => i % Math.ceil(f.length / 400) === 0) : f;
  const num = sample.filter(v => toNumber(v) != null).length, date = sample.filter(v => toDate(v)).length;
  if (date / sample.length >= 0.8) return 'date';
  if (num / sample.length >= 0.8) return 'number';
  return 'text';
}
// What the AI may see about a table: names, types, counts, and — for non-personal columns — the common categories
// and a few short examples. Row-by-row data is never part of the profile.
export function profile(table, extraSensitive = []) {
  return {
    name: table.name, rows: table.rows.length,
    columns: table.columns.map((c, i) => {
      const vals = table.rows.map(r => r[i]); const type = columnType(vals); const filled = vals.filter(v => s(v).trim());
      const counts = new Map(); for (const v of filled) { const k = s(v).trim(); counts.set(k, (counts.get(k) || 0) + 1); }
      const p = { name: c, type, filled: filled.length, distinct: counts.size };
      const sens = reportSensitive(c, extraSensitive); if (sens) { p.personal = sens; return p; }
      if (type === 'number') { const ns = filled.map(toNumber).filter(x => x != null); if (ns.length) { p.min = Math.min(...ns); p.max = Math.max(...ns); } }
      else if (type === 'date') { const ds = filled.map(toDate).filter(Boolean).sort(); if (ds.length) { p.min = ds[0]; p.max = ds.at(-1); } }
      else if (type === 'text') {
        const avg = filled.reduce((a, v) => a + s(v).length, 0) / (filled.length || 1); p.avgLength = Math.round(avg);
        const top = [...counts].sort((a, b) => b[1] - a[1]);
        if (counts.size <= 60 || top[0]?.[1] >= 3) p.values = top.slice(0, 30).filter(([v, n]) => counts.size <= 60 || n >= 2).map(([v, n]) => [v.slice(0, 80), n]);
        if (avg > 25) p.examples = [...counts.keys()].slice(0, 3).map(v => v.slice(0, 140));
        if (/^https?:\/\//i.test(filled[0] || '')) { const hosts = new Map(); for (const v of filled) { const h = hostOf(v); if (h) hosts.set(h, (hosts.get(h) || 0) + 1); } p.domains = [...hosts].sort((a, b) => b[1] - a[1]).slice(0, 15); delete p.examples; delete p.values; }
      }
      return p;
    }),
  };
}

/* ================= the plan ================= */
export const OPS = {
  select: 'Keep only these columns (in this order)', drop: 'Remove columns', rename: 'Rename a column', filter: 'Keep rows that match a condition',
  dedupe: 'Remove duplicate rows', clean: 'Clean values', fill: 'Fill empty cells', replace: 'Standardize values', derive: 'Add a calculated column',
  sort: 'Sort rows', ai_tag: 'Label each row with AI', summary: 'Summary table', pivot: 'Pivot table',
  dedupe_news: 'Remove duplicate news (layered)', ai_filter: 'Remove noise with AI', keywords: 'Detect keywords into a column', ai_normalize: 'Clean names with AI',
};
export const FILTERS = ['eq', 'ne', 'contains', 'not_contains', 'starts_with', 'gt', 'gte', 'lt', 'lte', 'between', 'in', 'not_in', 'empty', 'not_empty'];
export const CLEANS = ['trim', 'upper', 'lower', 'title', 'number', 'date', 'empty_words', 'domain', 'strip_html', 'slug_to_name'];
export const DERIVES = ['date', 'year', 'quarter', 'year_month', 'week', 'weekday', 'domain', 'bucket', 'length_words', 'copy'];
export const MEASURES = ['count', 'count_distinct', 'sum', 'avg', 'min', 'max', 'percent'];

const arr = v => (Array.isArray(v) ? v : v == null || v === '' ? [] : [v]).map(x => s(x).trim()).filter(Boolean);
const str = (v, n = 200) => s(v).trim().slice(0, n);
// Normalizes whatever the AI (or the editor) produced into well-formed steps. Unknown ops are dropped.
export function sanitizePlan(plan) {
  const steps = [];
  for (const raw of (Array.isArray(plan?.steps) ? plan.steps : []).slice(0, 60)) {
    if (!raw || !OPS[raw.op]) continue;
    const st = { op: raw.op };
    switch (raw.op) {
      case 'select': case 'drop': st.columns = arr(raw.columns); break;
      case 'rename': st.from = str(raw.from); st.to = str(raw.to, 120); break;
      case 'filter': st.column = str(raw.column); st.cmp = FILTERS.includes(raw.cmp) ? raw.cmp : 'eq'; st.value = str(raw.value, 500); if (raw.value2 != null) st.value2 = str(raw.value2, 500); st.values = arr(raw.values).slice(0, 200); break;
      case 'dedupe': st.columns = arr(raw.columns); break;
      case 'clean': st.columns = arr(raw.columns); st.actions = arr(raw.actions).filter(a => CLEANS.includes(a)); if (!st.actions.length) st.actions = ['trim']; break;
      case 'fill': st.column = str(raw.column); st.columns = arr(raw.columns); st.method = raw.method === 'previous' ? 'previous' : 'value'; st.value = str(raw.value, 300); break;
      case 'replace': st.column = str(raw.column); st.pairs = (Array.isArray(raw.pairs) ? raw.pairs : []).filter(p => Array.isArray(p) && p.length >= 2).slice(0, 300).map(p => [str(p[0], 300), str(p[1], 300)]); st.match = raw.match === 'contains' ? 'contains' : 'exact'; break;
      case 'derive': st.column = str(raw.column, 120); st.from = str(raw.from); st.fn = DERIVES.includes(raw.fn) ? raw.fn : 'copy'; if (st.fn === 'bucket') st.bins = (Array.isArray(raw.bins) ? raw.bins : []).map(Number).filter(Number.isFinite).sort((a, b) => a - b).slice(0, 20); break;
      case 'sort': st.column = str(raw.column); st.dir = raw.dir === 'desc' ? 'desc' : 'asc'; break;
      case 'ai_tag': st.column = str(raw.column, 120); st.from = arr(raw.from).slice(0, 4); st.labels = arr(raw.labels).slice(0, 80).map(l => l.slice(0, 90)); st.instruction = str(raw.instruction, 2000); st.only_empty = !!raw.only_empty;
        st.consistent_by = str(raw.consistent_by); st.seed = raw.seed === 'client' ? 'client' : ''; st.max_labels = Math.max(3, Math.min(80, +raw.max_labels || 8)); st.allow_new = !!raw.allow_new; break;
      case 'dedupe_news': st.url = str(raw.url); st.title = str(raw.title); st.media = str(raw.media); st.content = str(raw.content); st.near = Math.max(0.7, Math.min(0.99, +raw.near || 0.9)); break;
      case 'ai_filter': st.from = arr(raw.from).slice(0, 4); st.instruction = str(raw.instruction, 2000); st.labels = arr(raw.labels).slice(0, 12).map(l => l.slice(0, 90)); if (!st.labels.length) st.labels = ['Relevan', 'Noise: tidak berkaitan', 'Noise: hanya disebut di Baca juga', 'Noise: kementerian/lembaga negara lain', 'Noise: halaman portal atau judul acak']; st.keep = str(raw.keep, 90) || st.labels[0]; break;
      case 'keywords': st.column = str(raw.column, 120); st.from = arr(raw.from).slice(0, 6); st.terms = arr(raw.terms).slice(0, 60).map(t => t.slice(0, 300)); st.none = raw.none == null ? '-' : str(raw.none, 20); break;
      case 'ai_normalize': st.column = str(raw.column); st.instruction = str(raw.instruction, 1000); st.split = raw.split === undefined ? ',' : str(raw.split, 3); break;
      case 'summary': st.name = str(raw.name, 60) || 'Summary'; st.group_by = arr(raw.group_by).slice(0, 3);
        st.measures = (Array.isArray(raw.measures) ? raw.measures : []).filter(m => m && MEASURES.includes(m.fn)).slice(0, 8).map(m => ({ fn: m.fn, column: str(m.column), as: str(m.as, 80) }));
        if (!st.measures.length) st.measures = [{ fn: 'count', column: '', as: '' }];
        st.sort_by = str(raw.sort_by); st.dir = raw.dir === 'asc' ? 'asc' : 'desc'; st.top = Math.max(0, Math.min(1000, +raw.top || 0)); st.total = !!raw.total; st.top_per_group = !!raw.top_per_group; st.explode = !!raw.explode; break;
      case 'pivot': st.name = str(raw.name, 60) || 'Pivot'; st.rows = str(raw.rows); st.columns = str(raw.columns); st.fn = ['count', 'sum', 'avg'].includes(raw.fn) ? raw.fn : 'count'; st.value = str(raw.value); st.total = raw.total !== false; break;
    }
    if (raw.note) st.note = str(raw.note, 200);
    steps.push(st);
  }
  return { title: str(plan?.title, 120), steps };
}

// Human-readable description of a step (shown in the UI and in the "Curation notes" sheet).
export function describe(st) {
  const q = v => `“${v}”`; const list = a => a.map(q).join(', ');
  switch (st.op) {
    case 'select': return `Keep columns ${list(st.columns)}`;
    case 'drop': return `Remove columns ${list(st.columns)}`;
    case 'rename': return `Rename ${q(st.from)} to ${q(st.to)}`;
    case 'filter': { const w = { eq: 'is', ne: 'is not', contains: 'contains', not_contains: 'does not contain', starts_with: 'starts with', gt: '>', gte: '≥', lt: '<', lte: '≤', between: 'is between', in: 'is one of', not_in: 'is not one of', empty: 'is empty', not_empty: 'is not empty' }[st.cmp];
      const v = ['in', 'not_in'].includes(st.cmp) || (st.values?.length && ['eq', 'ne', 'contains', 'not_contains'].includes(st.cmp)) ? list(st.values.length ? st.values : [st.value]) : st.cmp === 'between' ? `${st.value} and ${st.value2}` : ['empty', 'not_empty'].includes(st.cmp) ? '' : q(st.value);
      return `Keep rows where ${q(st.column)} ${w} ${v}`.trim(); }
    case 'dedupe': return st.columns.length ? `Remove duplicates with the same ${list(st.columns)}` : 'Remove identical rows';
    case 'clean': return `Clean ${st.columns.length ? list(st.columns) : 'all columns'}: ${st.actions.join(', ').replace('empty_words', 'blank out “-”, “N/A”').replace('domain', 'URL → website')}`;
    case 'fill': return st.method === 'previous' ? `Fill empty ${q(st.column)} with the value above` : `Fill empty ${st.column ? q(st.column) : st.columns?.length ? list(st.columns) : 'cells in all columns'} with ${q(st.value)}`;
    case 'dedupe_news': return `Remove duplicate news in layers: same URL (incl. amp/mobile/utm variants)${st.title ? `, same title in the same media` : ''}${st.content ? `, identical or near-identical content (≥${Math.round(st.near * 100)}%) in the same media` : ''} — logged`;
    case 'ai_filter': return `AI removes noise from ${list(st.from)} (keeps “${st.keep}”)${st.instruction ? `: ${st.instruction.slice(0, 120)}${st.instruction.length > 120 ? '…' : ''}` : ''} — logged`;
    case 'keywords': return `New column ${q(st.column)}: ${st.terms.map(t => t.split('=')[0]).join(', ')} found in ${list(st.from)} (none → “${st.none}”)`;
    case 'ai_normalize': return `AI cleans names in ${q(st.column)}${st.instruction ? `: ${st.instruction.slice(0, 100)}` : ''}`;
    case 'replace': return `Standardize ${q(st.column)}: ${st.pairs.slice(0, 4).map(([a, b]) => `${a} → ${b}`).join('; ')}${st.pairs.length > 4 ? ` (+${st.pairs.length - 4} more)` : ''}`;
    case 'derive': return `New column ${q(st.column)} = ${st.fn.replace('_', ' ')} of ${q(st.from)}${st.fn === 'bucket' ? ` (groups at ${st.bins.join(', ')})` : ''}`;
    case 'sort': return `Sort by ${q(st.column)} (${st.dir === 'desc' ? 'high → low' : 'low → high'})`;
    case 'ai_tag': return `AI labels ${q(st.column)} from ${list(st.from)}${st.labels.length ? `: ${st.labels.slice(0, 8).join(' / ')}${st.labels.length > 8 ? ` (+${st.labels.length - 8})` : ''}` : st.seed === 'client' ? ` (client issue list${st.allow_new ? ' + new issues' : ''})` : ` (AI builds up to ${st.max_labels} categories)`}${st.only_empty ? ', only where empty' : ''}${st.consistent_by ? `, consistent per ${q(st.consistent_by)}` : ''}`;
    case 'summary': return `Summary “${st.name}”: ${st.measures.map(m => m.fn === 'count' || m.fn === 'percent' ? m.fn : `${m.fn} of ${m.column}`).join(', ')}${st.group_by.length ? ` per ${list(st.group_by)}` : ''}${st.top ? `, top ${st.top}${st.top_per_group ? ` per ${q(st.group_by[0])}` : ''}` : ''}${st.explode ? ' (multi-value cells counted per value)' : ''}`;
    case 'pivot': return `Pivot “${st.name}”: ${q(st.rows)} × ${q(st.columns)} (${st.fn}${st.fn !== 'count' ? ' of ' + q(st.value) : ''})`;
  }
  return st.op;
}

/* ================= news helpers ================= */
const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
export const stripHtml = v => s(v).replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, ' ').replace(/<br\s*\/?>|<\/p>/gi, '\n').replace(/<[^>]+>/g, ' ')
  .replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e) => e[0] === '#' ? String.fromCodePoint(e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : +e.slice(1)) : ENT[e.toLowerCase()] ?? m).replace(/[ \t ]+/g, ' ').replace(/\s*\n\s*/g, '\n').trim();
const slugToName = v => { const t = s(v).trim(); return /^[a-z0-9]+([+_-][a-z0-9]+)+$/i.test(t) ? titleCase(t.replace(/[+_-]+/g, ' ')) : t; };
export function normUrl(v) {
  const t = s(v).trim(); if (!t) return '';
  try { const u = new URL(/^https?:\/\//i.test(t) ? t : 'http://' + t); const host = u.hostname.toLowerCase().replace(/^(www|m|mobile|amp)\./, '');
    const path = u.pathname.replace(/\/amp\/?$|\/amp\//, '/').replace(/\/+$/, '').toLowerCase();
    const keep = [...u.searchParams].filter(([k]) => !/^(utm_|fbclid|gclid|ref|amp|s|page|source|from)/i.test(k)).sort().map(([k, x]) => `${k}=${x}`).join('&');
    return host + path + (keep ? '?' + keep : ''); } catch { return t.toLowerCase(); }
}
const normText = v => stripHtml(v).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
function shingles(text, n = 3) { const w = text.split(' ').slice(0, 400); const out = new Set(); for (let i = 0; i + n <= w.length; i++) out.add(w.slice(i, i + n).join(' ')); return out; }
function jaccard(a, b) { if (!a.size || !b.size) return 0; let inter = 0; const [x, y] = a.size < b.size ? [a, b] : [b, a]; for (const v of x) if (y.has(v)) inter++; return inter / (a.size + b.size - inter); }
// "Label=alias1|alias2" → { label, re } (case-insensitive, flexible spaces, whole words)
export function termMatcher(term) {
  const [label, rest] = term.includes('=') ? [term.split('=')[0].trim(), term.split('=').slice(1).join('=')] : [term.split('|')[0].trim(), term];
  const alts = rest.split('|').map(a => a.trim()).filter(Boolean).map(a => a.replace(/[.*+?^${}()[\]\\]/g, '\\$&').replace(/\s+/g, '\\s*'));
  return { label, re: new RegExp(`(?<![\\p{L}\\p{N}])(?:${alts.join('|')})(?![\\p{L}\\p{N}])`, 'iu') };
}
// Column guesses used for logging and for news-style steps.
export function guessCol(columns, kind) {
  const P = { title: [/^(judul|judul berita|title|headline)$/i, /judul|title|headline/i], media: [/^(media|nama media|media name|outlet|source|sumber|publisher|portal)$/i, /media|outlet|publisher|portal/i],
    url: [/^(url|link|tautan|permalink)$/i, /url|link/i], date: [/^(tanggal|date|published|published date|waktu)$/i, /tanggal|date|publish/i],
    content: [/^(content|konten|isi|isi berita|body|text|teks|full text|snippet)$/i, /content|konten|isi berita|body/i], sentiment: [/^sentim/i, /sentim/i] }[kind];
  const not = /type|tipe|jenis|kategori|category/i; // "MEDIA TYPE" is not the outlet name
  for (const re of P) { const i = columns.findIndex(c => re.test(String(c).trim()) && !(kind !== 'sentiment' && not.test(c))); if (i >= 0) return i; }
  return -1;
}

/* ================= running a plan ================= */
function colIdx(t, name) {
  if (!name) return -1; const n = cmpText(name);
  let i = t.columns.findIndex(c => c === name); if (i < 0) i = t.columns.findIndex(c => cmpText(c) === n);
  return i;
}
function need(t, name) { const i = colIdx(t, name); if (i < 0) throw new Error(`Column “${name}” not found`); return i; }
function compareValues(a, b, type) {
  if (type === 'number') { const x = toNumber(a), y = toNumber(b); if (x == null && y == null) return 0; if (x == null) return 1; if (y == null) return -1; return x - y; }
  if (type === 'date') { const x = toDate(a), y = toDate(b); if (!x && !y) return 0; if (!x) return 1; if (!y) return -1; return x < y ? -1 : x > y ? 1 : 0; }
  const x = s(a), y = s(b); if (!x && y) return 1; if (x && !y) return -1; return x.localeCompare(y, 'id', { numeric: true, sensitivity: 'base' });
}
function cleanValue(v, a) {
  switch (a) {
    case 'trim': return s(v).replace(/[ \s]+/g, ' ').trim();
    case 'upper': return s(v).toUpperCase(); case 'lower': return s(v).toLowerCase(); case 'title': return titleCase(s(v));
    case 'number': { const n = toNumber(v); return n == null ? v : String(n); }
    case 'date': return toDate(v) || v;
    case 'empty_words': return EMPTY_WORDS.has(cmpText(v)) ? '' : v;
    case 'domain': return hostOf(v) || v;
    case 'strip_html': return stripHtml(v);
    case 'slug_to_name': return slugToName(v);
  }
  return v;
}
function deriveValue(v, st) {
  const d = () => toDate(v);
  switch (st.fn) {
    case 'date': return d() || '';
    case 'year': return d()?.slice(0, 4) || '';
    case 'quarter': { const x = d(); return x ? `${x.slice(0, 4)}-Q${Math.ceil(+x.slice(5, 7) / 3)}` : ''; }
    case 'year_month': return d()?.slice(0, 7) || '';
    case 'week': { const x = d(); return x ? isoWeek(x) : ''; }
    case 'weekday': { const x = d(); return x ? DAYS_ID[new Date(x + 'T00:00:00Z').getUTCDay()] : ''; }
    case 'domain': return hostOf(v);
    case 'length_words': return String(s(v).trim() ? s(v).trim().split(/\s+/).length : 0);
    case 'bucket': { const n = toNumber(v); if (n == null) return ''; const b = st.bins; if (!b.length) return String(n);
      if (n < b[0]) return `< ${b[0]}`; for (let i = 0; i < b.length - 1; i++) if (n >= b[i] && n < b[i + 1]) return `${b[i]}–${b[i + 1] - 1}`; return `${b.at(-1)}+`; }
    default: return s(v);
  }
}
function matches(v, st, type) {
  const vals = st.values?.length ? st.values : [st.value];
  switch (st.cmp) {
    case 'empty': return !s(v).trim(); case 'not_empty': return !!s(v).trim();
    case 'eq': case 'in': return vals.some(x => (type === 'number' && toNumber(v) != null && toNumber(x) != null) ? toNumber(v) === toNumber(x) : (type === 'date' && toDate(v) && toDate(x)) ? toDate(v) === toDate(x) : cmpText(v) === cmpText(x));
    case 'ne': case 'not_in': return !matches(v, { ...st, cmp: 'eq' }, type);
    case 'contains': return vals.some(x => cmpText(v).includes(cmpText(x)));
    case 'not_contains': return !vals.some(x => cmpText(v).includes(cmpText(x)));
    case 'starts_with': return vals.some(x => cmpText(v).startsWith(cmpText(x)));
    case 'gt': case 'gte': case 'lt': case 'lte': case 'between': {
      const t = type === 'date' || (toDate(st.value) && !toNumber(st.value)) ? 'date' : 'number';
      const c = x => compareValues(v, x, t); if ((t === 'number' ? toNumber(v) : toDate(v)) == null) return false;
      if (st.cmp === 'gt') return c(st.value) > 0; if (st.cmp === 'gte') return c(st.value) >= 0; if (st.cmp === 'lt') return c(st.value) < 0; if (st.cmp === 'lte') return c(st.value) <= 0;
      return c(st.value) >= 0 && c(st.value2 ?? st.value) <= 0; }
  }
  return true;
}
const round = (n, d = 2) => Math.round(n * 10 ** d) / 10 ** d;
function summarize(t, st) {
  const g = st.group_by.map(c => need(t, c));
  const ms = st.measures.map(m => ({ ...m, i: m.fn === 'count' || m.fn === 'percent' ? -1 : need(t, m.column) }));
  const groups = new Map();
  const vals = (r, i) => (st.explode ? s(r[i]).split(/\s*[,;]\s*/).map(x => x.trim()).filter(x => x && x !== '-') : [r[i] || '(empty)']);
  const combos = r => g.reduce((acc, i) => acc.flatMap(a => (vals(r, i).length ? vals(r, i) : ['(empty)']).map(v => [...a, v])), [[]]);
  for (const r of t.rows) for (const key of combos(r)) { const k = JSON.stringify(key); if (!groups.has(k)) groups.set(k, { key, rows: [] }); groups.get(k).rows.push(r); }
  if (!g.length && !groups.size) groups.set('[]', { key: [], rows: [] });
  const total = t.rows.length;
  const label = m => m.as || (m.fn === 'count' ? 'Jumlah' : m.fn === 'percent' ? '%' : `${{ count_distinct: 'Jumlah unik', sum: 'Total', avg: 'Rata-rata', min: 'Min', max: 'Maks' }[m.fn]} ${t.columns[m.i]}`);
  const calc = (m, rows) => {
    if (m.fn === 'count') return rows.length; if (m.fn === 'percent') return total ? round(rows.length / total * 100, 1) : 0;
    if (m.fn === 'count_distinct') return new Set(rows.map(r => cmpText(r[m.i])).filter(Boolean)).size;
    const ns = rows.map(r => toNumber(r[m.i])).filter(x => x != null); if (!ns.length) return '';
    if (m.fn === 'sum') return round(ns.reduce((a, b) => a + b, 0)); if (m.fn === 'avg') return round(ns.reduce((a, b) => a + b, 0) / ns.length);
    if (m.fn === 'min') return Math.min(...ns); return Math.max(...ns);
  };
  const columns = [...st.group_by.map((c, j) => t.columns[g[j]]), ...ms.map(label)];
  let rows = [...groups.values()].map(x => [...x.key, ...ms.map(m => calc(m, x.rows))]);
  const sortIdx = st.sort_by ? columns.findIndex(c => cmpText(c) === cmpText(st.sort_by)) : -1;
  const si = sortIdx >= 0 ? sortIdx : g.length && ms.length ? g.length : 0;
  const dir = sortIdx >= 0 ? st.dir : (g.length && st.group_by.some(c => /tanggal|date|bulan|month|minggu|week|tahun|year|periode|quarter|kuartal/i.test(c)) && !st.sort_by ? 'asc' : st.dir);
  const sortCol = sortIdx >= 0 || !(dir === 'asc' && g.length) ? si : 0;
  rows.sort((a, b) => { const x = a[sortCol], y = b[sortCol]; const c = typeof x === 'number' && typeof y === 'number' ? x - y : compareValues(x, y, columnType([x, y])); return dir === 'desc' ? -c : c; });
  if (st.top && st.top_per_group && g.length > 1) { const seen = new Map(); rows = rows.filter(r => { const n = (seen.get(r[0]) || 0) + 1; seen.set(r[0], n); return n <= st.top; }).sort((a, b) => compareValues(a[0], b[0], 'text')); }
  else if (st.top) rows = rows.slice(0, st.top);
  if (st.total && g.length) rows.push([...g.map((_, j) => (j === 0 ? 'Total' : '')), ...ms.map(m => calc(m, t.rows))]);
  return { name: st.name, columns, rows, kind: 'summary' };
}
function pivotTable(t, st) {
  const ri = need(t, st.rows), ci = need(t, st.columns), vi = st.fn === 'count' ? -1 : need(t, st.value);
  const colVals = new Map(); for (const r of t.rows) { const k = r[ci] || '(empty)'; colVals.set(k, (colVals.get(k) || 0) + 1); }
  let cols = [...colVals.keys()]; const dateish = columnType(cols) !== 'text';
  cols = dateish ? cols.sort((a, b) => compareValues(a, b, columnType(cols))) : cols.sort((a, b) => colVals.get(b) - colVals.get(a));
  const extra = cols.length > 24; if (extra) cols = cols.slice(0, 23);
  const cell = rows => { if (st.fn === 'count') return rows.length; const ns = rows.map(r => toNumber(r[vi])).filter(x => x != null); if (!ns.length) return 0; const sum = ns.reduce((a, b) => a + b, 0); return round(st.fn === 'sum' ? sum : sum / ns.length); };
  const byRow = new Map(); for (const r of t.rows) { const k = r[ri] || '(empty)'; if (!byRow.has(k)) byRow.set(k, []); byRow.get(k).push(r); }
  const colOf = r => { const k = r[ci] || '(empty)'; return cols.includes(k) ? k : 'Lainnya'; };
  const allCols = extra ? [...cols, 'Lainnya'] : cols;
  let rows = [...byRow].map(([k, rs]) => [k, ...allCols.map(c => cell(rs.filter(r => colOf(r) === c))), ...(st.total ? [cell(rs)] : [])]);
  const rType = columnType([...byRow.keys()]);
  rows.sort((a, b) => rType !== 'text' ? compareValues(a[0], b[0], rType) : (b.at(-1) - a.at(-1)));
  if (st.total) rows.push(['Total', ...allCols.map(c => cell(t.rows.filter(r => colOf(r) === c))), cell(t.rows)]);
  return { name: st.name, columns: [t.columns[ri], ...allCols, ...(st.total ? ['Total'] : [])], rows, kind: 'pivot' };
}

// Runs the steps on a copy of the table. Returns the curated table, the summary tables and a per-step log.
// `tagger(texts, labels, instruction)` → Promise<{labels: string[], values: string[]}> is used by ai_tag steps.
export async function runPlan(table, plan, { tagger, normalizer, maxAiRows = 100000, onStep = () => {} } = {}) {
  let t = { name: table.name, columns: [...table.columns], rows: table.rows.map(r => [...r]) };
  const summaries = []; const log = []; const removed = [];
  // Every row a step removes is logged with the reason (and, for duplicates, the URL that was kept).
  const keyFields = r => { const pick = k => { const i = guessCol(t.columns, k); return i >= 0 ? s(r[i]) : ''; }; return { title: pick('title').slice(0, 300), media: pick('media'), url: pick('url'), date: pick('date') }; };
  for (const [si, st] of plan.steps.entries()) {
    onStep(si, st); await new Promise(r => setImmediate(r)); // keep the server responsive on very large files
    const before = t.rows.length; const entry = { op: st.op, text: describe(st), before };
    try {
      switch (st.op) {
        case 'select': { const idx = st.columns.map(c => need(t, c)); t = { ...t, columns: idx.map(i => t.columns[i]), rows: t.rows.map(r => idx.map(i => r[i])) }; break; }
        case 'drop': { const drop = new Set(st.columns.map(c => need(t, c))); const keep = t.columns.map((_, i) => i).filter(i => !drop.has(i)); t = { ...t, columns: keep.map(i => t.columns[i]), rows: t.rows.map(r => keep.map(i => r[i])) }; break; }
        case 'rename': { const i = need(t, st.from); if (!st.to) throw new Error('New name is empty'); t.columns[i] = st.to; break; }
        case 'filter': { const i = need(t, st.column); const type = columnType(t.rows.map(r => r[i])); t.rows = t.rows.filter(r => { const ok = matches(r[i], st, type); if (!ok) removed.push({ step: log.length + 1, reason: `Filter: ${describe(st).replace(/^Keep rows where /, '')}`, ...keyFields(r) }); return ok; }); break; }
        case 'dedupe_news': {
          const ui = st.url ? need(t, st.url) : guessCol(t.columns, 'url'), ti = st.title ? need(t, st.title) : guessCol(t.columns, 'title'), mi = st.media ? need(t, st.media) : guessCol(t.columns, 'media'), ci = st.content ? need(t, st.content) : guessCol(t.columns, 'content');
          const keep = []; const byUrl = new Map(), byTitle = new Map(), byContent = new Map(), buckets = new Map(); const counts = { url: 0, title: 0, content: 0, near: 0 };
          const di = guessCol(t.columns, 'date');
          for (const r of t.rows) {
            const media = mi >= 0 ? cmpText(r[mi]) : ''; let hit = null, why = '';
            const u = ui >= 0 ? normUrl(r[ui]) : ''; if (u && byUrl.has(u)) { hit = byUrl.get(u); why = 'url'; }
            const tk = ti >= 0 && normText(r[ti]) ? media + '|' + normText(r[ti]) : ''; if (!hit && tk && byTitle.has(tk)) { hit = byTitle.get(tk); why = 'title'; }
            const body = ci >= 0 ? normText(r[ci]) : ''; const ck = body.length > 80 ? media + '|' + body.slice(0, 3000) : ''; if (!hit && ck && byContent.has(ck)) { hit = byContent.get(ck); why = 'content'; }
            let sh = null; const bk = media + '|' + (di >= 0 ? (toDate(r[di]) || s(r[di]).slice(0, 10)) : '');
            if (!hit && body.length > 200) { sh = shingles(body); for (const o of buckets.get(bk) || []) if (jaccard(sh, o.sh) >= st.near) { hit = o.row; why = 'near'; break; } }
            if (hit) { counts[why]++; removed.push({ step: log.length + 1, reason: { url: 'Duplikat: URL sama', title: 'Duplikat: judul sama di media yang sama', content: 'Duplikat: isi identik di media yang sama', near: 'Duplikat: isi nyaris identik di media yang sama' }[why], ...keyFields(r), ref: ui >= 0 ? s(hit[ui]) : '' }); continue; }
            keep.push(r); if (u) byUrl.set(u, r); if (tk) byTitle.set(tk, r); if (ck) byContent.set(ck, r); if (sh) { if (!buckets.has(bk)) buckets.set(bk, []); buckets.get(bk).push({ sh, row: r }); }
          }
          t.rows = keep; entry.detail = counts; break; }
        case 'ai_filter': {
          if (!tagger) throw new Error('AI is not available');
          const src = st.from.map(c => need(t, c)); const texts = t.rows.map(r => src.map(i => stripHtml(r[i])).filter(Boolean).join(' — ').slice(0, 1500));
          if (t.rows.length > maxAiRows) throw new Error(`Too many rows for AI (${t.rows.length}; the limit is ${maxAiRows}).`);
          const out = await tagger(texts, st.labels, st.instruction || 'Decide whether each text belongs in this client\'s monitoring data.', { purpose: 'filter' });
          const keepLabel = cmpText(st.keep); const kept = [];
          t.rows.forEach((r, k) => { const lab = out.values[k] || ''; if (!lab || cmpText(lab) === keepLabel) kept.push(r); else removed.push({ step: log.length + 1, reason: lab, ...keyFields(r) }); });
          entry.aiRows = t.rows.length; t.rows = kept; break; }
        case 'keywords': {
          const src = st.from.map(c => need(t, c)); if (!st.column) throw new Error('New column name is empty'); const ms = st.terms.map(termMatcher);
          let j = colIdx(t, st.column); if (j < 0) { t.columns.push(st.column); j = t.columns.length - 1; for (const r of t.rows) r.push(''); }
          let n = 0; for (const r of t.rows) { const text = src.map(i => stripHtml(r[i])).join(' \n '); const found = ms.filter(m => m.re.test(text)).map(m => m.label); r[j] = found.length ? found.join(', ') : st.none; if (found.length) n++; }
          entry.changed = n; break; }
        case 'ai_normalize': {
          if (!normalizer) throw new Error('AI is not available'); const i = need(t, st.column);
          const parts = v => (st.split ? s(v).split(st.split) : [s(v)]).map(x => x.trim()).filter(Boolean);
          const uniq = [...new Set(t.rows.flatMap(r => parts(r[i])))];
          const map = await normalizer(uniq, st.instruction); let n = 0;
          for (const r of t.rows) { const before = s(r[i]); const after = [...new Set(parts(before).map(x => map.get(x) ?? x).filter(x => x && x !== '-'))].join(st.split ? st.split + ' ' : ''); if (after !== before) { r[i] = after || '-'; n++; } }
          entry.changed = n; entry.values = uniq.length; break; }
        case 'dedupe': { const idx = st.columns.length ? st.columns.map(c => need(t, c)) : t.columns.map((_, i) => i); const seen = new Set();
          t.rows = t.rows.filter(r => { const k = idx.map(i => cmpText(r[i])).join('\u0001'); if (seen.has(k)) return false; seen.add(k); return true; }); break; }
        case 'clean': { const idx = st.columns.length ? st.columns.map(c => need(t, c)) : t.columns.map((_, i) => i); let changed = 0;
          for (const r of t.rows) for (const i of idx) { let v = r[i]; for (const a of st.actions) v = cleanValue(v, a); if (v !== r[i]) { r[i] = v; changed++; } }
          entry.changed = changed; break; }
        case 'fill': { const idx = st.column ? [need(t, st.column)] : st.columns?.length ? st.columns.map(c => need(t, c)) : t.columns.map((_, i) => i); let n = 0;
          for (const i of idx) { let prev = ''; for (const r of t.rows) { if (!s(r[i]).trim()) { const v = st.method === 'previous' ? prev : st.value; if (v) { r[i] = v; n++; } } else prev = r[i]; } }
          entry.changed = n; break; }
        case 'replace': { const i = need(t, st.column); let n = 0;
          for (const r of t.rows) { const v = cmpText(r[i]); for (const [a, b] of st.pairs) { if (st.match === 'contains' ? v.includes(cmpText(a)) : v === cmpText(a)) { if (r[i] !== b) { r[i] = b; n++; } break; } } }
          entry.changed = n; break; }
        case 'derive': { const i = need(t, st.from); if (!st.column) throw new Error('New column name is empty'); let j = colIdx(t, st.column);
          if (j < 0) { t.columns.push(st.column); j = t.columns.length - 1; for (const r of t.rows) r.push(''); }
          for (const r of t.rows) r[j] = deriveValue(r[i], st); break; }
        case 'sort': { const i = need(t, st.column); const type = columnType(t.rows.map(r => r[i])); t.rows.sort((a, b) => { const c = compareValues(a[i], b[i], type); return st.dir === 'desc' ? -c : c; }); break; }
        case 'ai_tag': {
          if (!tagger) throw new Error('AI labelling is not available');
          const src = st.from.map(c => need(t, c)); if (!st.column) throw new Error('Label column name is empty');
          let j = colIdx(t, st.column); if (j < 0) { t.columns.push(st.column); j = t.columns.length - 1; for (const r of t.rows) r.push(''); }
          const todo = t.rows.filter(r => !st.only_empty || !s(r[j]).trim());
          if (todo.length > maxAiRows) throw new Error(`Too many rows for AI labelling (${todo.length}; the limit is ${maxAiRows}). Filter the data first.`);
          const texts = todo.map(r => src.map(i => stripHtml(r[i])).filter(Boolean).join(' — ').slice(0, 1500));
          const out = await tagger(texts, st.labels, st.instruction, { maxLabels: st.max_labels, seed: st.seed, allowNew: st.allow_new });
          todo.forEach((r, k) => { r[j] = out.values[k] || ''; });
          if (st.consistent_by) { // syndicated stories (same normalized title) get the majority label
            const ci = need(t, st.consistent_by); const groups = new Map(); for (const r of t.rows) { const k = normText(r[ci]); if (!k) continue; if (!groups.has(k)) groups.set(k, []); groups.get(k).push(r); }
            let fixed = 0; for (const rs of groups.values()) { if (rs.length < 2) continue; const c = new Map(); for (const r of rs) if (r[j]) c.set(r[j], (c.get(r[j]) || 0) + 1); const top = [...c].sort((a, b) => b[1] - a[1])[0]?.[0]; if (top) for (const r of rs) if (r[j] !== top) { r[j] = top; fixed++; } }
            entry.consistency = fixed; }
          entry.labels = out.labels; entry.aiRows = todo.length; break; }
        case 'summary': summaries.push({ ...summarize(t, st), step: si }); break;
        case 'pivot': summaries.push({ ...pivotTable(t, st), step: si }); break;
      }
      entry.ok = true;
    } catch (e) { entry.ok = false; entry.error = e.message; }
    entry.after = t.rows.length; log.push(entry);
  }
  return { table: t, summaries, log, removed };
}

/* ================= writing .xlsx ================= */
const xmlEsc = v => s(v).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f￾￿]/g, '').replace(/[<>&"]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c]));
const colLetter = i => { let s2 = ''; i++; while (i) { const m = (i - 1) % 26; s2 = String.fromCharCode(65 + m) + s2; i = Math.floor((i - 1) / 26); } return s2; };
const sheetName = (n, used) => { let b = s(n).replace(/[\[\]:*?/\\]/g, ' ').trim().slice(0, 31) || 'Sheet'; let x = b, k = 2; while (used.has(x.toLowerCase())) x = b.slice(0, 27) + ' (' + k++ + ')'; used.add(x.toLowerCase()); return x; };
const PLAIN_NUM = /^-?(0|[1-9]\d{0,14})(\.\d+)?$/;
const excelSerial = iso => (Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10)) / 864e5) + 25569;
// sheets: [{name, columns, rows}] → Buffer. Header row styled, frozen and filterable; numbers and dates typed.
export async function writeXlsx(sheets, { accent = '1F3A5F' } = {}) {
  const JSZip = (await import('jszip')).default; const zip = new JSZip(); const used = new Set();
  const names = sheets.map(sh => sheetName(sh.name, used));
  const sentStyle = v => ({ positif: 5, positive: 5, netral: 6, neutral: 6, negatif: 7, negative: 7 })[cmpText(v)];
  const cell = (ref, v, header, sentiment) => {
    if (v && typeof v === 'object' && v.f) return `<c r="${ref}"${Number.isInteger(v.v) ? ' s="3"' : ''}><f>${xmlEsc(v.f)}</f>${v.v != null ? `<v>${v.v}</v>` : ''}</c>`;
    if (sentiment && sentStyle(v)) return `<c r="${ref}" t="inlineStr" s="${sentStyle(v)}"><is><t xml:space="preserve">${xmlEsc(v)}</t></is></c>`;
    if (header) return `<c r="${ref}" t="inlineStr" s="1"><is><t xml:space="preserve">${xmlEsc(v)}</t></is></c>`;
    if (typeof v === 'number' && Number.isFinite(v)) return `<c r="${ref}" s="${Number.isInteger(v) ? 3 : 4}"><v>${v}</v></c>`;
    const t = s(v); if (!t) return '';
    if (PLAIN_NUM.test(t)) return `<c r="${ref}" s="${t.includes('.') ? 4 : 3}"><v>${t}</v></c>`;
    if (/^\d{4}-\d{2}-\d{2}$/.test(t) && toDate(t)) return `<c r="${ref}" s="2"><v>${excelSerial(t)}</v></c>`;
    return `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${xmlEsc(t.slice(0, 32000))}</t></is></c>`;
  };
  sheets.forEach((sh, k) => {
    const cols = sh.columns; const last = colLetter(Math.max(0, cols.length - 1)); const n = sh.rows.length + 1;
    const widths = cols.map((c, i) => Math.min(60, Math.max(8, s(c).length + 2, ...sh.rows.slice(0, 300).map(r => s(r[i] && typeof r[i] === 'object' ? r[i].v : r[i]).length + 1))));
    const sentCols = new Set(cols.map((c, i) => (/sentim/i.test(c) ? i : -1)).filter(i => i >= 0));
    const rowsXml = [`<row r="1">${cols.map((c, i) => cell(colLetter(i) + 1, c, true)).join('')}</row>`,
      ...sh.rows.map((r, ri) => `<row r="${ri + 2}">${cols.map((_, i) => cell(colLetter(i) + (ri + 2), r[i], false, sentCols.has(i))).join('')}</row>`)].join('');
    zip.file(`xl/worksheets/sheet${k + 1}.xml`, `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><dimension ref="A1:${last}${n}"/><sheetViews><sheetView workbookViewId="0"${k === 0 ? ' tabSelected="1"' : ''}><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews><sheetFormatPr defaultRowHeight="15"/><cols>${widths.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join('')}</cols><sheetData>${rowsXml}</sheetData>${sh.noFilter ? '' : `<autoFilter ref="A1:${last}${n}"/>`}</worksheet>`);
  });
  zip.file('[Content_Types].xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>${sheets.map((_, k) => `<Override PartName="/xl/worksheets/sheet${k + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('')}</Types>`);
  zip.file('_rels/.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`);
  zip.file('xl/workbook.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><bookViews><workbookView/></bookViews><sheets>${names.map((nm, k) => `<sheet name="${xmlEsc(nm)}" sheetId="${k + 1}" r:id="rId${k + 1}"/>`).join('')}</sheets><definedNames>${sheets.map((sh, k) => sh.noFilter ? '' : `<definedName name="_xlnm._FilterDatabase" localSheetId="${k}" hidden="1">'${xmlEsc(names[k]).replace(/'/g, "''")}'!$A$1:$${colLetter(Math.max(0, sh.columns.length - 1))}$${sh.rows.length + 1}</definedName>`).join('')}</definedNames><calcPr calcId="191029" fullCalcOnLoad="1"/></workbook>`);
  zip.file('xl/_rels/workbook.xml.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheets.map((_, k) => `<Relationship Id="rId${k + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${k + 1}.xml"/>`).join('')}<Relationship Id="rId${sheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`);
  zip.file('xl/styles.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><numFmts count="1"><numFmt numFmtId="164" formatCode="yyyy-mm-dd"/></numFmts><fonts count="2"><font><sz val="11"/><name val="Calibri"/><family val="2"/></font><font><b/><sz val="11"/><color rgb="FFFFFFFF"/><name val="Calibri"/><family val="2"/></font></fonts><fills count="6"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FF${accent}"/><bgColor indexed="64"/></patternFill></fill><fill><patternFill patternType="solid"><fgColor rgb="FFD7F2E3"/><bgColor indexed="64"/></patternFill></fill><fill><patternFill patternType="solid"><fgColor rgb="FFECEFF3"/><bgColor indexed="64"/></patternFill></fill><fill><patternFill patternType="solid"><fgColor rgb="FFFADADA"/><bgColor indexed="64"/></patternFill></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="8"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1"><alignment vertical="center"/></xf><xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/><xf numFmtId="3" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/><xf numFmtId="4" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/><xf numFmtId="0" fontId="0" fillId="3" borderId="0" xfId="0" applyFill="1"/><xf numFmtId="0" fontId="0" fillId="4" borderId="0" xfId="0" applyFill="1"/><xf numFmtId="0" fontId="0" fillId="5" borderId="0" xfId="0" applyFill="1"/></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`);
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}
