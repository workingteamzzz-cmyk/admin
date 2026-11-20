// Canopus Reports: curate spreadsheets and build presentations on the organization's templates.
// The AI writes plans and slide text; the data work and the files are produced on the server.
let C; // helpers from app.js
const S = { tab: 'data', templates: [], datasets: [], decks: [], meta: {}, ds: null, dsResultTab: 0, plan: null, explanation: '', deck: null, sources: [], busy: '', loaded: false };
const $ = s => document.querySelector(s);
const esc = s => C.esc(s), ic = (n, c) => C.ic(n, c);
const KIND_LABEL = { title: 'Cover', section: 'Section', bullets: 'Points', two: 'Two columns', kpi: 'Key numbers', quote: 'Quote', table: 'Table', chart: 'Chart', closing: 'Closing' };
const DATA_CHIPS = ['Bersihkan data, buang berita duplikat, seragamkan nama media, lalu rekap per media, sentimen, dan tren harian',
  'Beri label sentimen (Positif/Netral/Negatif) untuk berita yang belum berlabel', 'Kelompokkan berita ke dalam isu utama secara otomatis lalu rekap per isu',
  'Hanya berita bersentimen negatif; rekap per media dan narasumber'];
const DECK_CHIPS = ['Laporan monitoring media mingguan untuk pimpinan', 'Analisis isu negatif dan rekomendasi strategi komunikasi', 'Ringkasan eksekutif 5 slide', 'Bahan rapat koordinasi humas: temuan, risiko, dan rencana aksi'];

export function initReports(ctx) {
  C = ctx;
  document.addEventListener('click', onClick);
  document.addEventListener('change', e => { if (e.target.id === 'rpDsFile') uploadDataset(e.target.files); if (e.target.id === 'rpTplFile') uploadTemplate(e.target.files); });
}
async function load() { const r = await C.api('/api/reports'); Object.assign(S, { templates: r.templates, datasets: r.datasets, decks: r.decks, meta: r.meta, loaded: true }); }
export async function renderReports() {
  const page = $('#repPage'); if (!page) return;
  if (!S.loaded) { page.innerHTML = '<div class="help" style="padding:40px">Loading…</div>'; try { await load(); } catch (e) { page.innerHTML = `<div class="help" style="color:var(--red)">${esc(e.message)}</div>`; return; } }
  page.innerHTML = `<div class="page-head"><div><h1><span class="h-ic c-orange">${ic('chart')}</span>Reports</h1><p class="sub">Curate spreadsheets (media monitoring, coverage logs, survey results) and turn them into presentations on your organization's template. The AI plans the work and writes the slide text; the data is processed and the files are built on this server.</p></div></div>
    <div class="tabs">${[['data', 'table', 'Data curation'], ['decks', 'layers', 'Presentations'], ['templates', 'grid', 'Templates']].map(([k, i, l]) => `<button class="tab ${S.tab === k ? 'on' : ''}" data-r="tab" data-x="${k}">${ic(i)}${l}</button>`).join('')}</div>
    <div id="rpBody" style="padding-top:14px"></div>`;
  ({ data: S.ds ? dsView : dataHome, decks: S.deck ? deckView : deckHome, templates: tplView }[S.tab])();
  C.hydrateIcons(page);
}
const body = html => { $('#rpBody').innerHTML = html; C.hydrateIcons($('#rpBody')); };
const modelSelect = (sel, id) => { const ms = C.me().config.models; return `<select id="${id}" class="vsel" title="AI model">${ms.length > 1 ? `<option value="auto">Auto (recommended)</option>` : ''}${ms.map(m => `<option value="${m.id}" ${sel === m.id ? 'selected' : ''}>${esc(m.label)}</option>`).join('')}</select>`; };
const spin = label => `<span class="shimmer">${esc(label)}</span>`;
const fmtCell = v => (typeof v === 'number' ? v.toLocaleString('id-ID') : esc(String(v ?? '').slice(0, 140)));
function tableHTML(columns, rows, personal = []) {
  return `<div class="tblwrap rp-tbl"><table class="tbl"><thead><tr>${columns.map(c => `<th title="${esc(c)}">${personal.includes(c) ? ic('lock') + ' ' : ''}${esc(c)}</th>`).join('')}</tr></thead><tbody>${rows.map(r => `<tr>${columns.map((_, i) => `<td class="${typeof r[i] === 'number' ? 'r' : ''}">${fmtCell(r[i])}</td>`).join('')}</tr>`).join('') || `<tr><td colspan="${columns.length}" class="muted">No rows</td></tr>`}</tbody></table></div>`;
}
async function download(url) {
  try {
    const r = await fetch(url); if (!r.ok) { const j = await r.json().catch(() => ({})); throw new Error(j.error || 'HTTP ' + r.status); }
    const name = decodeURIComponent((r.headers.get('content-disposition') || '').match(/filename\*=UTF-8''([^;]+)/)?.[1] || 'download');
    const warn = r.headers.get('x-canopus-warnings'); const blob = await r.blob();
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 3000);
    const w = warn ? JSON.parse(decodeURIComponent(warn)) : []; C.toast(w.length ? `Downloaded with notes: ${w.join(' · ')}` : `Downloaded ${name}`, w.length ? 7000 : 2400);
  } catch (e) { C.toast(e.message, 5000); }
}

/* ================= data curation ================= */
function dataHome() {
  body(`<div class="set-sec rp-drop"><div style="display:flex;gap:16px;align-items:center;flex-wrap:wrap"><div style="flex:1;min-width:240px"><h3>${ic('upload')}Upload a spreadsheet</h3><p>Excel (.xlsx) or CSV, e.g. a media monitoring log. Canopus finds the header row, then you describe what you need: cleaning, labels, filters, summaries.</p></div>
    <button class="cta" data-r="pickds">${ic('upload')}Upload Excel / CSV</button><input type="file" id="rpDsFile" accept=".xlsx,.csv,.tsv" hidden></div>
    <p class="help" style="margin-top:12px">${ic('lock')} Privacy: for planning, the AI sees column names, types and common values — not your rows. Labelling sends only the text columns you choose. Columns with ID numbers, phone numbers, e-mail or addresses are never sent.</p></div>
    ${S.datasets.length ? `<div class="tblwrap"><table class="tbl"><thead><tr><th>Dataset</th><th class="r">Rows</th><th>Status</th><th>Updated</th><th></th></tr></thead><tbody>${S.datasets.map(d => `<tr><td><a href="#" data-r="opends" data-x="${d.id}"><b>${esc(d.name)}</b></a><div class="muted">${esc(d.filename)} · ${C.fmtSize(d.size)}</div></td><td class="r">${(d.result_rows ?? d.rows ?? 0).toLocaleString('id-ID')}</td><td>${d.curated ? '<span class="cls biasa">Curated</span>' : d.planned ? '<span class="cls processing">Plan ready</span>' : '<span class="cls">New</span>'}</td><td class="muted">${C.ago(d.updated)}</td><td class="r"><button class="btn sm" data-r="opends" data-x="${d.id}">Open</button></td></tr>`).join('')}</tbody></table></div>`
      : `<div class="empty-box"><div class="e-ic">${ic('table')}</div><b>No datasets yet</b><p>Upload a monitoring spreadsheet to start.</p></div>`}`);
}
async function uploadDataset(files) {
  const f = files?.[0]; if (!f) return; C.toast('Reading ' + f.name + '…');
  try { const d = await C.api('/api/reports/datasets', { method: 'POST', raw: f, headers: { 'content-type': f.type || 'application/octet-stream', 'x-filename': encodeURIComponent(f.name) } }); S.ds = d; S.plan = null; S.explanation = ''; S.dsResultTab = 0; await load(); renderReports(); }
  catch (e) { C.toast(e.message, 5000); }
}
async function openDataset(did) { try { S.ds = await C.api('/api/reports/datasets/' + did); S.plan = S.ds.plan; S.explanation = ''; S.dsResultTab = 0; renderReports(); } catch (e) { C.toast(e.message, 4000); } }
function dsView() {
  const d = S.ds; const sh = d.sheets.find(s => s.name === d.sheet) || d.sheets[0];
  const steps = S.plan?.steps || [];
  body(`<div class="bar" style="align-items:center"><button class="btn sm" data-r="back">← All datasets</button><h2 style="flex:1;margin:0;font-size:20px">${esc(d.name)}</h2>
      <button class="btn sm" data-r="renameds">${ic('edit')}Rename</button>${d.result ? `<button class="btn sm" data-r="askds">${ic('chat')}Ask in chat</button><button class="btn sm primary" data-r="xlsx">${ic('download')}Download Excel</button>` : ''}<button class="icon-btn" data-r="delds" title="Delete">${ic('trash')}</button></div>
    <div class="set-sec"><h3>${ic('table')}Source: ${esc(d.filename)}</h3>
      ${d.sheets.length > 1 ? `<div class="seg" style="margin-bottom:10px">${d.sheets.map(s => `<button class="${s.name === sh.name ? 'on' : ''}" data-r="sheet" data-x="${esc(s.name)}">${esc(s.name)} (${s.rows})</button>`).join('')}</div>` : ''}
      <p class="help">${sh.rows.toLocaleString('id-ID')} rows · ${sh.columns.length} columns${sh.skipped ? ` · ${sh.skipped} title row${sh.skipped > 1 ? 's' : ''} above the header skipped` : ''}${sh.personal.length ? ` · ${ic('lock')} personal-data columns never sent to the AI: ${sh.personal.map(esc).join(', ')}` : ''}</p>
      ${tableHTML(sh.columns, sh.preview, sh.personal)}</div>
    <div class="set-sec"><h3>${ic('sparkle')}What should Canopus do with this data?</h3>
      <textarea id="rpInstr" rows="3" placeholder="e.g. Buang duplikat, seragamkan nama media, beri label sentimen yang kosong, lalu buat rekap per media, per sentimen dan tren harian.">${esc(d.instruction || '')}</textarea>
      <div class="chips" style="margin:8px 0 12px">${DATA_CHIPS.map((c, i) => `<button class="chip" data-r="dchip" data-x="${i}">${esc(c)}</button>`).join('')}</div>
      <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap">${modelSelect('auto', 'rpModel')}<button class="btn primary" data-r="plan" ${S.busy ? 'disabled' : ''}>${S.busy === 'plan' ? spin('Planning…') : ic('sparkle') + 'Draft a plan'}</button><span class="help" style="margin:0">Uses a little AI; nothing is changed until you run the plan.</span></div></div>
    <div class="set-sec"><div style="display:flex;align-items:center;gap:10px"><h3 style="flex:1;margin:0">${ic('memo')}Plan${steps.length ? ` · ${steps.length} steps` : ''}</h3><button class="btn sm" data-r="addstep">${ic('plus')}Add step</button>${steps.length ? `<button class="btn primary" data-r="run" ${S.busy ? 'disabled' : ''}>${S.busy === 'run' ? spin('Running…') : ic('bolt') + 'Run plan'}</button>` : ''}</div>
      ${S.explanation ? `<div class="notice" style="margin-top:10px">${esc(S.explanation)}</div>` : ''}
      ${steps.length ? `<ol class="rp-steps">${steps.map((s, i) => { const l = d.log?.[i]; return `<li class="rp-step ${s.op === 'ai_tag' ? 'ai' : ''}"><span class="badge">${esc(S.meta.ops?.[s.op] || s.op)}</span><span class="t">${esc(s.text || s.op)}</span>${l && JSON.stringify(stepKey(l)) === JSON.stringify(stepKey(s)) ? (l.ok ? `<small class="ok">${l.before !== l.after ? `${l.before} → ${l.after} rows` : l.changed != null ? `${l.changed} changed` : l.aiRows ? `${l.aiRows} labelled` : '✓'}</small>` : `<small class="bad" title="${esc(l.error)}">skipped</small>`) : ''}<span class="acts"><button class="icon-btn" data-r="upstep" data-x="${i}" title="Move up">↑</button><button class="icon-btn" data-r="editstep" data-x="${i}" title="Edit">${ic('edit')}</button><button class="icon-btn" data-r="rmstep" data-x="${i}" title="Remove">${ic('trash')}</button></span></li>`; }).join('')}</ol>`
        : `<p class="help">Describe what you need above and press <b>Draft a plan</b>, or add steps yourself — this works entirely without AI.</p>`}</div>
    ${d.result ? resultHTML(d) : ''}`);
}
const stepKey = x => x.text;
function resultHTML(d) {
  const tabs = [{ name: `Data (${d.result.table.rows.toLocaleString('id-ID')} rows)`, columns: d.result.table.columns, rows: d.result.table.preview }, ...d.result.summaries.map(s => ({ name: s.name, columns: s.columns, rows: s.rows }))];
  const cur = tabs[Math.min(S.dsResultTab, tabs.length - 1)]; const failed = (d.log || []).filter(l => !l.ok);
  return `<div class="set-sec"><div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap"><h3 style="flex:1;margin:0">${ic('check')}Result</h3><button class="btn sm" data-r="todeck">${ic('layers')}Make a presentation</button><button class="btn sm primary" data-r="xlsx">${ic('download')}Download Excel</button></div>
    ${failed.length ? `<div class="notice" style="margin-top:10px">${failed.length} step${failed.length > 1 ? 's were' : ' was'} skipped: ${failed.map(l => `${esc(l.text)} — ${esc(l.error)}`).join('; ')}</div>` : ''}
    <div class="seg" style="margin:12px 0;flex-wrap:wrap">${tabs.map((t, i) => `<button class="${t === cur ? 'on' : ''}" data-r="rtab" data-x="${i}">${esc(t.name)}</button>`).join('')}</div>
    ${tableHTML(cur.columns, cur.rows)}${cur === tabs[0] && d.result.table.rows > cur.rows.length ? `<p class="help">Showing the first ${cur.rows.length} rows. The Excel file has all of them, plus the summaries and a sheet listing each curation step.</p>` : ''}</div>`;
}
const STEP_TEMPLATES = {
  clean: { op: 'clean', columns: [], actions: ['trim', 'empty_words'] }, replace: { op: 'replace', column: '', pairs: [['', '']], match: 'exact' }, dedupe: { op: 'dedupe', columns: [] },
  filter: { op: 'filter', column: '', cmp: 'eq', value: '' }, fill: { op: 'fill', column: '', method: 'value', value: '' }, derive: { op: 'derive', column: '', from: '', fn: 'year_month' },
  select: { op: 'select', columns: [] }, drop: { op: 'drop', columns: [] }, rename: { op: 'rename', from: '', to: '' }, sort: { op: 'sort', column: '', dir: 'asc' },
  ai_tag: { op: 'ai_tag', column: 'Sentimen', from: [], labels: ['Positif', 'Netral', 'Negatif'], instruction: 'Sentimen pemberitaan terhadap organisasi', only_empty: true },
  summary: { op: 'summary', name: 'Rekap', group_by: [], measures: [{ fn: 'count', column: '', as: 'Jumlah' }], sort_by: '', dir: 'desc', top: 0, total: true },
  pivot: { op: 'pivot', name: 'Pivot', rows: '', columns: '', fn: 'count', value: '', total: true },
};
function stepModal(i) {
  const s = i >= 0 ? S.plan.steps[i] : STEP_TEMPLATES.clean; const { text, note, ...clean } = s;
  const cols = (S.ds.sheets.find(x => x.name === S.ds.sheet) || S.ds.sheets[0]).columns;
  C.openModal(`<h3>${i >= 0 ? 'Edit step' : 'Add a step'}</h3><p class="s">Steps are JSON. Pick a type to start from its template. Columns: ${cols.map(c => `<code>${esc(c)}</code>`).join(' ')}</p>
    <label for="rpOp">Type</label><select id="rpOp" class="vsel" style="width:100%">${Object.entries(S.meta.ops || {}).map(([k, v]) => `<option value="${k}" ${k === s.op ? 'selected' : ''}>${esc(v)} (${k})</option>`).join('')}</select>
    <label for="rpStep">Step</label><textarea id="rpStep" class="mono" style="min-height:190px;font-size:13px">${esc(JSON.stringify(clean, null, 2))}</textarea>
    <div class="dlg-actions"><button class="btn" data-dlg="cancel">Cancel</button><button class="btn primary" data-r="savestep" data-x="${i}">Save step</button></div>`, 'wide');
  $('#rpOp').onchange = e => { $('#rpStep').value = JSON.stringify(STEP_TEMPLATES[e.target.value], null, 2); };
}

/* ================= presentations ================= */
function deckHome() {
  const curated = S.datasets.filter(d => d.curated);
  body(`<div class="set-sec"><h3>${ic('sparkle')}New presentation</h3>
    <div class="row2"><div><label for="rpTitle">Title</label><input type="text" id="rpTitle" placeholder="e.g. Laporan Monitoring Media 1–14 November 2026"></div>
      <div><label for="rpTpl">Template</label><select id="rpTpl" class="vsel" style="width:100%">${S.templates.map(t => `<option value="${t.id}">${esc(t.name)}${t.scope === 'personal' ? ' (mine)' : ''}</option>`).join('')}</select></div></div>
    <label>Data to use</label>${curated.length ? `<div class="checks" id="rpDs">${curated.map(d => `<label><input type="checkbox" value="${d.id}" ${S.prefDs === d.id ? 'checked' : ''}>${esc(d.name)} <span class="muted">(${(d.result_rows || 0).toLocaleString('id-ID')} rows)</span></label>`).join('')}</div>` : `<p class="help">No curated datasets yet — curate one in <a href="#" data-r="tab" data-x="data">Data curation</a>, or write the presentation from your brief alone.</p>`}
    <label for="rpBrief">Brief</label><textarea id="rpBrief" rows="4" placeholder="Who is it for, what period, what should it emphasize? e.g. Laporan mingguan untuk Kepala Biro: sorot isu keterlambatan distribusi dan beri 3 rekomendasi strategi komunikasi."></textarea>
    <div class="chips" style="margin:8px 0 12px">${DECK_CHIPS.map((c, i) => `<button class="chip" data-r="kchip" data-x="${i}">${esc(c)}</button>`).join('')}</div>
    <div style="display:flex;gap:12px;align-items:center;flex-wrap:wrap">${modelSelect('auto', 'rpDModel')}<label class="help" style="margin:0;display:flex;gap:6px;align-items:center"><input type="checkbox" id="rpKnow"> Also use internal knowledge</label><button class="btn primary" data-r="draftdeck" ${S.busy ? 'disabled' : ''}>${S.busy === 'deck' ? spin('Writing slides… (up to a minute)') : ic('sparkle') + 'Draft slides'}</button></div>
    <p class="help">The AI receives the summary tables and a sample of the data's text columns (personal-data columns left out), then writes the slide text. Charts and tables are filled from the real data on this server.</p></div>
    ${S.decks.length ? `<div class="tblwrap"><table class="tbl"><thead><tr><th>Presentation</th><th class="r">Slides</th><th>Updated</th><th></th></tr></thead><tbody>${S.decks.map(k => `<tr><td><a href="#" data-r="opendeck" data-x="${k.id}"><b>${esc(k.title)}</b></a><div class="muted">${esc(k.brief)}</div></td><td class="r">${k.slides}</td><td class="muted">${C.ago(k.updated)}</td><td class="r"><button class="btn sm" data-r="opendeck" data-x="${k.id}">Open</button> <button class="btn sm" data-r="pptx" data-x="${k.id}">${ic('download')}PPTX</button></td></tr>`).join('')}</tbody></table></div>` : ''}`);
}
async function openDeck(kid) { try { S.deck = await C.api('/api/reports/decks/' + kid); S.sources = await C.api('/api/reports/sources', { method: 'POST', body: { datasets: S.deck.datasets } }); S.tab = 'decks'; renderReports(); } catch (e) { C.toast(e.message, 4000); } }
const tplColors = tid => (S.templates.find(t => t.id === tid) || S.templates[0])?.info?.colors || {};
function slideThumb(s, colors) {
  const navy = '#' + (colors.dk2 || '1F3A5F'), acc = '#' + (colors.accent1 || '1E5AA8'), acc2 = '#' + (colors.accent2 || 'E8772E');
  const dark = ['title', 'section', 'closing'].includes(s.kind);
  const inner = s.kind === 'bullets' ? `<ul>${s.bullets.slice(0, 5).map(b => `<li>${esc(b.replace(/\*\*/g, '').replace(/^-\s*/, '› '))}</li>`).join('')}</ul>`
    : s.kind === 'two' ? `<div class="two"><div><b>${esc(s.left_title)}</b>${s.left.slice(0, 3).map(x => `<div>${esc(x)}</div>`).join('')}</div><div><b>${esc(s.right_title)}</b>${s.right.slice(0, 3).map(x => `<div>${esc(x)}</div>`).join('')}</div></div>`
    : s.kind === 'kpi' ? `<div class="kpis">${s.items.map(i => `<div><b style="color:${acc}">${esc(i.value)}</b><span>${esc(i.label)}</span></div>`).join('')}</div>`
    : s.kind === 'chart' ? `<div class="viz">${ic('chart')}<span>${esc(s.chart)} · ${esc(s.source)}</span></div>`
    : s.kind === 'table' ? `<div class="viz">${ic('table')}<span>${esc(s.source)}</span></div>`
    : s.kind === 'quote' ? `<div class="qt" style="border-color:${acc2}">“${esc(s.quote)}”<small>${esc(s.source)}</small></div>` : `<div class="sub">${esc(s.subtitle || '')}</div>`;
  return `<div class="thumb169 ${dark ? 'dark' : ''}" style="${dark ? `background:${navy}` : ''}"><i style="background:${acc2}"></i><h4 style="color:${dark ? '#fff' : navy}">${esc(s.title)}</h4>${inner}</div>`;
}
function slideFields(s, i) {
  const f = (k, label, v, rows = 0) => `<label>${label}</label>${rows ? `<textarea data-f="${k}" data-i="${i}" rows="${rows}">${esc(v)}</textarea>` : `<input type="text" data-f="${k}" data-i="${i}" value="${esc(v)}">`}`;
  const srcSel = v => `<label>Data</label><select data-f="source" data-i="${i}" class="vsel" style="width:100%">${S.sources.map(x => `<option ${x.ref === v ? 'selected' : ''}>${esc(x.ref)}</option>`).join('')}${S.sources.some(x => x.ref === v) ? '' : `<option selected>${esc(v)}</option>`}</select>`;
  const cols = s.source ? (S.sources.find(x => x.ref === s.source)?.columns || []) : [];
  let h = f('title', 'Title', s.title);
  if (['title', 'section', 'closing'].includes(s.kind)) h += f('subtitle', 'Subtitle', s.subtitle || '', 2);
  if (s.kind === 'bullets') h += f('bullets', 'Points (one per line; start with “- ” for a sub-point, **bold**)', s.bullets.join('\n'), 5);
  if (s.kind === 'two') h += `<div class="row2"><div>${f('left_title', 'Left heading', s.left_title)}${f('left', 'Left points', s.left.join('\n'), 4)}</div><div>${f('right_title', 'Right heading', s.right_title)}${f('right', 'Right points', s.right.join('\n'), 4)}</div></div>`;
  if (s.kind === 'kpi') h += f('items', 'Numbers (one per line: value | label | note)', s.items.map(x => [x.value, x.label, x.note].filter(Boolean).join(' | ')).join('\n'), 4);
  if (s.kind === 'quote') h += f('quote', 'Quote', s.quote, 3) + f('source', 'Who said it, where', s.source);
  if (s.kind === 'chart') h += `<div class="row2"><div>${srcSel(s.source)}</div><div><label>Chart type</label><select data-f="chart" data-i="${i}" class="vsel" style="width:100%">${['column', 'bar', 'line', 'pie', 'doughnut'].map(c => `<option ${c === s.chart ? 'selected' : ''}>${c}</option>`).join('')}</select></div></div>${f('category', `Category column${cols.length ? ' — ' + cols.join(', ') : ''}`, s.category)}${f('series', 'Value columns (comma-separated)', s.series.join(', '))}<label class="help" style="display:flex;gap:6px;align-items:center"><input type="checkbox" data-f="stacked" data-i="${i}" ${s.stacked ? 'checked' : ''}> Stacked</label>`;
  if (s.kind === 'table') h += `${srcSel(s.source)}${f('columns', `Columns (comma-separated, empty = all)${cols.length ? ' — ' + cols.join(', ') : ''}`, s.columns.join(', '))}${f('top', 'Show only the first N rows (0 = all)', s.top || 0)}`;
  if (['kpi', 'table', 'chart'].includes(s.kind)) h += f('caption', 'Insight (shown under the visual)', s.caption || '', 2);
  return h;
}
function deckView() {
  const k = S.deck; const colors = tplColors(k.template);
  body(`<div class="bar" style="align-items:center"><button class="btn sm" data-r="backdeck">← All presentations</button><input type="text" id="rpDTitle" value="${esc(k.title)}" style="flex:1;font-size:18px;font-weight:600">
      <select id="rpDTpl" class="vsel">${S.templates.map(t => `<option value="${t.id}" ${t.id === k.template ? 'selected' : ''}>${esc(t.name)}</option>`).join('')}</select>
      <button class="btn sm" data-r="savedeck">${ic('check')}Save</button><button class="btn sm primary" data-r="pptx" data-x="${k.id}">${ic('download')}Download PowerPoint</button><button class="icon-btn" data-r="deldeck" title="Delete">${ic('trash')}</button></div>
    ${k.notes ? `<div class="notice">${esc(k.notes)}</div>` : ''}
    <div class="rp-slides">${k.outline.slides.map((s, i) => `<div class="rp-slide"><div class="rp-slide-l">${slideThumb(s, colors)}<div class="rp-slide-tools"><span class="badge">${i + 1} · ${KIND_LABEL[s.kind]}</span><button class="icon-btn" data-r="sup" data-x="${i}" title="Move up">↑</button><button class="icon-btn" data-r="sdown" data-x="${i}" title="Move down">↓</button><button class="icon-btn" data-r="sdel" data-x="${i}" title="Delete slide">${ic('trash')}</button></div></div><div class="rp-slide-r">${slideFields(s, i)}</div></div>`).join('')}</div>
    <div class="set-sec" style="display:flex;gap:10px;align-items:center;flex-wrap:wrap"><b style="flex:1">Add a slide</b>${Object.entries(KIND_LABEL).map(([kk, l]) => `<button class="btn sm" data-r="sadd" data-x="${kk}">${ic('plus')}${l}</button>`).join('')}</div>`);
  $('#rpBody').oninput = $('#rpBody').onchange = e => { const el = e.target; if (el.dataset.f == null || el.dataset.i == null) return; const s = k.outline.slides[+el.dataset.i]; const v = el.type === 'checkbox' ? el.checked : el.value;
    const list = x => x.split('\n').map(y => y.trimEnd()).filter(y => y.trim());
    switch (el.dataset.f) {
      case 'bullets': case 'left': case 'right': s[el.dataset.f] = list(v); break;
      case 'series': case 'columns': s[el.dataset.f] = v.split(',').map(y => y.trim()).filter(Boolean); break;
      case 'items': s.items = list(v).map(l => { const [value, label, note] = l.split('|').map(y => y.trim()); return { value: value || '', label: label || '', note: note || '' }; }); break;
      case 'top': s.top = +v || 0; break;
      default: s[el.dataset.f] = v;
    }
    k.dirty = true; if (e.type === 'change') { const th = el.closest('.rp-slide')?.querySelector('.thumb169'); if (th) th.outerHTML = slideThumb(s, tplColors($('#rpDTpl').value)); }
  };
}
async function saveDeck(quiet) {
  const k = S.deck; const r = await C.api('/api/reports/decks/' + k.id, { method: 'PUT', body: { title: $('#rpDTitle')?.value ?? k.title, template: $('#rpDTpl')?.value ?? k.template, outline: k.outline } });
  S.deck = r; S.decks = (await C.api('/api/reports')).decks; if (!quiet) C.toast('Saved');
}
const NEW_SLIDE = { title: { kind: 'title', title: 'Judul', subtitle: '' }, section: { kind: 'section', title: 'Bagian baru' }, bullets: { kind: 'bullets', title: 'Judul', bullets: ['Poin pertama'] },
  two: { kind: 'two', title: 'Perbandingan', left_title: 'Kiri', left: ['Poin'], right_title: 'Kanan', right: ['Poin'] }, kpi: { kind: 'kpi', title: 'Angka kunci', items: [{ value: '0', label: 'Label', note: '' }], caption: '' },
  quote: { kind: 'quote', title: 'Kutipan', quote: 'Teks kutipan', source: '' }, table: { kind: 'table', title: 'Tabel', source: '', columns: [], top: 10, caption: '' },
  chart: { kind: 'chart', title: 'Grafik', source: '', chart: 'column', category: '', series: [], stacked: false, caption: '' }, closing: { kind: 'closing', title: 'Terima kasih', subtitle: '' } };

/* ================= templates ================= */
function tplView() {
  body(`<div class="set-sec"><div style="display:flex;gap:16px;align-items:center;flex-wrap:wrap"><div style="flex:1;min-width:240px"><h3>${ic('upload')}Add your template</h3><p>Upload a PowerPoint file (.pptx or .potx) — your official template, or a previous report. Canopus uses its masters, layouts, colors and fonts. If the file has slides, their order and titles become the reference structure the AI follows for new reports.</p></div>
    <div style="display:flex;gap:8px;align-items:center">${C.isAdmin() ? `<select id="rpTplScope" class="vsel"><option value="organization">For everyone</option><option value="personal">Only for me</option></select>` : ''}<button class="cta" data-r="picktpl">${ic('upload')}Upload template</button><input type="file" id="rpTplFile" accept=".pptx,.potx" hidden></div></div></div>
    <div class="cards rp-tpls">${S.templates.map(t => { const c = t.info.colors || {}; const st = t.info.structure || [];
      return `<div class="card"><div class="rp-tplprev" style="background:#${c.dk2 || '1F3A5F'}"><i style="background:#${c.accent2 || 'E8772E'}"></i><b>${esc(t.name)}</b><div class="swatches">${['accent1', 'accent2', 'accent3', 'accent4', 'accent5', 'accent6'].map(k => c[k] ? `<span style="background:#${c[k]}"></span>` : '').join('')}</div></div>
        <div class="card-body"><div class="card-top"><h3>${esc(t.name)}</h3></div><div class="date">${t.builtin ? 'Built in' : (t.scope === 'organization' ? 'Organization template' : 'My template') + ' · ' + C.ago(t.created)}</div>
        <div class="badges"><span class="badge">${t.info.ratio}</span><span class="badge">${t.info.layouts.length} layouts</span>${t.info.font ? `<span class="badge">${esc(t.info.font)}</span>` : ''}${st.length ? `<span class="badge gold" title="${esc(st.map((s, i) => `${i + 1}. ${s.title}`).join('\n'))}">${st.length} reference slides</span>` : ''}</div>
        ${['section', 'two', 'visual'].filter(k => !t.info.supports?.[k]).length ? `<p class="help">No dedicated ${['section', 'two', 'visual'].filter(k => !t.info.supports?.[k]).map(k => ({ section: 'section', two: 'two-column', visual: 'title-only' })[k]).join(', ')} layout — Canopus uses the closest one.</p>` : ''}
        <div style="display:flex;gap:6px;margin-top:10px"><button class="btn sm" data-r="tpldl" data-x="${t.id}">${ic('download')}Download</button>${!t.builtin && (t.mine || C.isAdmin()) ? `<button class="btn sm" data-r="tpldel" data-x="${t.id}">${ic('trash')}Delete</button>` : ''}</div></div></div>`; }).join('')}</div>`);
}
async function uploadTemplate(files) {
  const f = files?.[0]; if (!f) return; C.toast('Reading template…');
  try { await C.api('/api/reports/templates', { method: 'POST', raw: f, headers: { 'content-type': 'application/octet-stream', 'x-filename': encodeURIComponent(f.name), 'x-scope': $('#rpTplScope')?.value || 'personal' } }); await load(); renderReports(); C.toast('Template added'); }
  catch (e) { C.toast(e.message, 5000); }
}

/* ================= events ================= */
async function onClick(e) {
  const t = e.target.closest('[data-r]'); if (!t) return; e.preventDefault();
  const r = t.dataset.r, x = t.dataset.x;
  try {
    switch (r) {
      case 'tab': S.tab = x; if (x === 'decks') S.deck = null; renderReports(); break;
      case 'pickds': $('#rpDsFile').click(); break;
      case 'picktpl': $('#rpTplFile').click(); break;
      case 'opends': await openDataset(x); break;
      case 'back': S.ds = null; await load(); renderReports(); break;
      case 'sheet': S.ds.sheet = x; S.plan = null; renderReports(); break;
      case 'dchip': $('#rpInstr').value = DATA_CHIPS[+x]; break;
      case 'kchip': $('#rpBrief').value = DECK_CHIPS[+x]; break;
      case 'rtab': S.dsResultTab = +x; renderReports(); break;
      case 'renameds': { const n = await C.ask('Rename dataset', { value: S.ds.name }); if (n && n.trim()) { await C.api('/api/reports/datasets/' + S.ds.id, { method: 'PATCH', body: { name: n.trim() } }); S.ds.name = n.trim(); renderReports(); } break; }
      case 'delds': if (await C.confirmBox('Delete dataset?', 'The uploaded file, the plan and the curated result are removed from the server.')) { await C.api('/api/reports/datasets/' + S.ds.id, { method: 'DELETE' }); S.ds = null; await load(); renderReports(); } break;
      case 'plan': { const instruction = $('#rpInstr').value.trim(); S.busy = 'plan'; renderReports();
        try { const res = await C.api(`/api/reports/datasets/${S.ds.id}/plan`, { method: 'POST', body: { instruction, model: $('#rpModel')?.value, sheet: S.ds.sheet } }); S.plan = res.plan; S.explanation = res.explanation; S.ds.instruction = instruction; S.ds.log = null; }
        finally { S.busy = ''; renderReports(); } break; }
      case 'run': { S.busy = 'run'; renderReports();
        try { S.ds = await C.api(`/api/reports/datasets/${S.ds.id}/run`, { method: 'POST', body: { plan: S.plan, sheet: S.ds.sheet } }); S.plan = S.ds.plan; S.dsResultTab = 0; C.refreshMe?.(); }
        finally { S.busy = ''; renderReports(); } break; }
      case 'addstep': S.plan ??= { title: '', steps: [] }; stepModal(-1); break;
      case 'editstep': stepModal(+x); break;
      case 'rmstep': S.plan.steps.splice(+x, 1); renderReports(); break;
      case 'upstep': if (+x > 0) { const s = S.plan.steps; [s[+x - 1], s[+x]] = [s[+x], s[+x - 1]]; renderReports(); } break;
      case 'savestep': { let st; try { st = JSON.parse($('#rpStep').value); } catch { C.toast('That is not valid JSON'); break; } st.op = st.op || $('#rpOp').value; st.text = undefined;
        st.text = describeLocal(st); if (+x >= 0) S.plan.steps[+x] = st; else S.plan.steps.push(st); C.closeModal(); renderReports(); break; }
      case 'xlsx': await download(`/api/reports/datasets/${S.ds.id}/xlsx`); break;
      case 'askds': { const rec = await C.api(`/api/reports/datasets/${S.ds.id}/attach`, { method: 'POST' }); C.chatWith(rec, `Berdasarkan data monitoring terlampir, `); break; }
      case 'todeck': S.prefDs = S.ds.id; S.tab = 'decks'; S.deck = null; await load(); renderReports(); break;
      case 'draftdeck': { const datasets = [...document.querySelectorAll('#rpDs input:checked')].map(i => i.value); const brief = $('#rpBrief').value.trim();
        if (!brief && !datasets.length) { C.toast('Write a brief or choose data first'); break; }
        const payload = { title: $('#rpTitle').value.trim(), template: $('#rpTpl').value, datasets, brief, model: $('#rpDModel')?.value, knowledge: $('#rpKnow').checked };
        S.busy = 'deck'; renderReports();
        try { const k = await C.api('/api/reports/decks', { method: 'POST', body: payload }); S.busy = ''; await load(); await openDeck(k.id); C.refreshMe?.(); }
        finally { S.busy = ''; if (!S.deck) renderReports(); } break; }
      case 'opendeck': await openDeck(x); break;
      case 'backdeck': if (S.deck?.dirty) await saveDeck(true); S.deck = null; await load(); renderReports(); break;
      case 'savedeck': await saveDeck(); renderReports(); break;
      case 'pptx': if (S.deck && S.deck.id === x) await saveDeck(true); await download(`/api/reports/decks/${x}/pptx`); break;
      case 'deldeck': if (await C.confirmBox('Delete presentation?', 'The outline is removed. Files you downloaded are not affected.')) { await C.api('/api/reports/decks/' + S.deck.id, { method: 'DELETE' }); S.deck = null; await load(); renderReports(); } break;
      case 'sup': case 'sdown': { const s = S.deck.outline.slides; const i = +x, j = r === 'sup' ? i - 1 : i + 1; if (j >= 0 && j < s.length) { [s[i], s[j]] = [s[j], s[i]]; S.deck.dirty = true; renderReports(); } break; }
      case 'sdel': S.deck.outline.slides.splice(+x, 1); S.deck.dirty = true; renderReports(); break;
      case 'sadd': { const s = structuredClone(NEW_SLIDE[x]); if (s.source !== undefined) s.source = S.sources.find(v => !v.main)?.ref || S.sources[0]?.ref || ''; S.deck.outline.slides.push(s); S.deck.dirty = true; renderReports(); setTimeout(() => document.querySelector('.rp-slide:last-child')?.scrollIntoView({ behavior: 'smooth' }), 30); break; }
      case 'tpldl': await download(`/api/reports/templates/${x}/file`); break;
      case 'tpldel': if (await C.confirmBox('Delete template?', 'Presentations that use it will fall back to the Canopus default template.')) { await C.api('/api/reports/templates/' + x, { method: 'DELETE' }); await load(); renderReports(); } break;
    }
  } catch (err) { C.toast(err.message, 5000); }
}
function describeLocal(st) { return `${S.meta.ops?.[st.op] || st.op}${st.column ? `: ${st.column}` : st.columns?.length ? `: ${st.columns.join(', ')}` : st.name ? `: ${st.name}` : ''}`; }
