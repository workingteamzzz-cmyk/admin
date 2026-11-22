// Canopus Reports: curate spreadsheets and build presentations on the organization's templates.
// The AI writes plans and slide text; the data work and the files are produced on the server.
let C; // helpers from app.js
const S = { tab: 'clients', client: '', clients: [], clientDocs: null, templates: [], datasets: [], decks: [], meta: {}, ds: null, dsResultTab: 0, plan: null, explanation: '', deck: null, sources: [], busy: '', loaded: false };
const $ = s => document.querySelector(s);
const esc = s => C.esc(s), ic = (n, c) => C.ic(n, c);
const KIND_LABEL = { title: 'Cover', section: 'Section', summary: 'Executive summary', news: 'News samples', image: 'Screenshot', bullets: 'Points', two: 'Two columns', kpi: 'Key numbers', quote: 'Quote', matrix: '2×2 matrix', actions: 'Action plan', table: 'Table', chart: 'Chart', closing: 'Closing' };
const DATA_CHIPS = ['Per sentimen: bersihkan data, buang duplikat, beri label sentimen (Positif/Netral/Negatif) yang kosong, lalu rekap sebaran sentimen, sentimen per media, dan tren harian',
  'Per topik: bersihkan data, buang duplikat, kelompokkan berita ke dalam topik/isu utama secara otomatis, lalu rekap per topik, topik per media, dan tren harian',
  'Sentimen dan topik: bersihkan, buang duplikat, beri label sentimen dan topik, lalu rekap topik × sentimen, per media, dan tren harian',
  'Hanya berita bersentimen negatif; rekap per topik, media dan narasumber'];
const CHIP_LABELS = ['By sentiment', 'By topic', 'Sentiment + topic', 'Negative coverage only', 'Weekly media massa (full)', 'Weekly media sosial (full)'];
DATA_CHIPS.push(
  'Weekly media massa: gunakan tabel gabungan (kolom MEDIA TYPE). Bersihkan tag HTML di konten. Cek duplikat berlapis: URL sama termasuk varian amp/mobile/utm, judul sama di media yang sama, isi identik atau nyaris identik di media yang sama; berita sama di media berbeda bukan duplikat. Hapus noise yang tidak berkaitan dengan klien dan turunannya (pejabat, unit, program), termasuk yang hanya disebut di "Baca juga" dan kementerian negara lain. Beri SENTIMENT dari sudut pandang klien sesuai aturan sentimen di persona, konsisten untuk berita sindikasi. Beri SEKTOR sesuai persona. Beri ISU yang representatif dari isi konten: pakai daftar isu acuan klien, isu serupa digabung, boleh isu baru bila tidak ada yang cocok. Beri PROGRAM dari daftar program klien (lebih dari satu dipisah koma, tidak ada "-"). Rapikan kolom entitas (person, organization, influencer) dan isi sel kosong dengan "-". Rekap: sentimen per media type, sektor × sentimen, program × sentimen, isu × sentimen, top 10 media per media type, tren harian per sentimen, top 10 spokesperson.',
  'Weekly media sosial: gabungkan semua file (kolom PLATFORM). Bersihkan HTML dan spasi berlebih. Hapus duplikat: URL/ID post sama termasuk varian URL, akun sama dengan teks identik di hari yang sama; repost dari akun berbeda bukan duplikat. Hapus noise: tidak berkaitan dengan klien, hanya hashtag tempelan, spam loker/giveaway/jualan, kementerian negara lain. SENTIMENT dari sudut pandang klien sesuai persona (keluhan layanan = negatif; keluhan umum yang tidak menyalahkan klien = netral), konsisten untuk post yang sama. SEKTOR dan ISU memakai daftar isu acuan klien supaya sama dengan laporan media massa. PROGRAM dari daftar program klien. Rapikan kolom akun/entitas, isi sel kosong dengan "-". Rekap: sentimen per platform, sektor × sentimen, program × sentimen, isu × sentimen, top akun.');
// Example structure (one analyst's weekly media-monitoring flow). Clients can use any structure.
const STRUCTURE_PRESET = `Cover — logo klien, periode, sumber data
Executive Summary — sintesis seluruh slide, tidak mengulang angka slide lain
Tren Ekspos — tren harian per sentimen, puncak diberi anotasi peristiwa pemicunya
Media Distribution — Top 10 media per platform (online, cetak, TV; TV tetap tampil meski 0)
Top 10 Spokesperson — dengan jabatan
Sentimen — proporsi sentimen, top 5 isu positif dan top 5 isu negatif
Isu Sektor — 5 isu teratas per sektor/program prioritas klien
Program & Platform — pemberitaan per program/platform klien
Sorotan Pimpinan — pemberitaan tentang pimpinan klien
Wordcloud — screenshot dashboard dipertahankan, dengan analisa
Sebaran Lokasi — screenshot/peta dengan analisa yang dikaitkan ke kegiatan klien di daerah
Sampel Berita Positif — 4 berita dengan tautan
Sampel Berita Negatif — 4 berita dengan tautan
Risk Mapping — potensi krisis, pemicu, tingkat risiko, langkah
Potensi Positif & Rekomendasi — isu positif yang bisa diangkat, rekomendasi komunikasi, poin pantauan pekan depan
Maks 15 slide`;
const DECK_CHIPS = ['Laporan monitoring media mingguan untuk pimpinan', 'Analisis isu negatif dan rekomendasi strategi komunikasi', 'Ringkasan eksekutif 5 slide', 'Bahan rapat koordinasi humas: temuan, risiko, dan rencana aksi'];

export function initReports(ctx) {
  C = ctx;
  document.addEventListener('click', onClick);
  document.addEventListener('change', async e => { if (e.target.id === 'rpDsFile') uploadDataset(e.target.files); if (e.target.id === 'rpDsMore') addDatasetFile(e.target.files);
    if (e.target.id === 'rpLogoFile' && e.target.files.length) { let n = 0; for (const f of e.target.files) { try { await C.api(`/api/reports/clients/${S.client}/logos`, { method: 'POST', raw: f, headers: { 'content-type': f.type, 'x-filename': encodeURIComponent(f.name) } }); n++; } catch (err) { C.toast(`${f.name}: ${err.message}`, 5000); } }
      delete S.styleCache[S.client]; await load(); renderReports(); if (n) C.toast(`${n} logo${n > 1 ? 's' : ''} added — style recommendation updated`); }
    if (e.target.id === 'rpCoverFile' && e.target.files.length) { captureForm(); for (const f of e.target.files) { try { const im = await C.api('/api/reports/images', { method: 'POST', raw: f, headers: { 'content-type': f.type, 'x-filename': encodeURIComponent(f.name) } }); (S.covers ||= []).push({ id: im.id, label: f.name }); } catch (err) { C.toast(`${f.name}: ${err.message}`, 5000); } } renderReports(); }
    if (e.target.name === 'rpCov' || e.target.id === 'rpRef') { captureForm(); renderReports(); }
    if (e.target.id === 'rpDCovLayout' && S.deck) { const c = S.deck.outline.cover || {}; S.deck = await C.api('/api/reports/decks/' + S.deck.id, { method: 'PUT', body: { outline: S.deck.outline, cover: { candidates: c.candidates || [], mode: c.mode || 'auto', image: c.image, layout: e.target.value } } }); renderReports(); }
    if ((e.target.id === 'rpShotFile' || e.target.id === 'rpDeckShot') && e.target.files.length) { if (e.target.id === 'rpShotFile') captureForm(); for (const f of e.target.files) { try { const im = await C.api('/api/reports/images', { method: 'POST', raw: f, headers: { 'content-type': f.type, 'x-filename': encodeURIComponent(f.name) } }); const rec = { id: im.id, label: f.name.replace(/\.(png|jpe?g)$/i, '') };
        if (e.target.id === 'rpShotFile') (S.shots ||= []).push(rec); else { S.deck.images = [...(S.deck.images || []), rec]; await C.api('/api/reports/decks/' + S.deck.id, { method: 'PUT', body: { images: S.deck.images, outline: S.deck.outline } }); } } catch (err) { C.toast(`${f.name}: ${err.message}`, 5000); } } renderReports(); }
    if (e.target.classList?.contains('rp-flabel')) { try { S.ds = await C.api(`/api/reports/datasets/${S.ds.id}/files/${e.target.dataset.fi}`, { method: 'PATCH', body: { label: e.target.value } }); renderReports(); C.toast('Label saved'); } catch (err) { C.toast(err.message, 4000); } } if (e.target.id === 'rpTplFile') uploadTemplate(e.target.files); if (e.target.id === 'rpDocFile') uploadClientDocs(e.target.files);
    if (e.target.dataset?.tplmove) { try { await C.api('/api/reports/templates/' + e.target.dataset.tplmove, { method: 'PATCH', body: { clientId: e.target.value || null } }); await load(); renderReports(); C.toast('Template moved'); } catch (err) { C.toast(err.message, 4000); } } });
}
async function load() { const r = await C.api('/api/reports'); Object.assign(S, { references: r.references || [], clients: r.clients, templates: r.templates, datasets: r.datasets, decks: r.decks, meta: r.meta });
  if (!S.loaded) { S.client = prefs().client || ''; if (r.clients.length && !S.client) S.tab = 'clients'; } if (S.client && !S.clients.some(c => c.id === S.client)) S.client = ''; S.loaded = true; }
const skey = t => ((S.cchan || 'medmas') === 'medmas' ? t : `${t}:${S.cchan}`);
const curClient = () => S.clients.find(c => c.id === S.client) || null;
const inClient = x => !S.client || x.clientId === S.client;
const clientName = cid => S.clients.find(c => c.id === cid)?.name || '';
// Template choices grouped by client: the current client's first, then every other client's (any template can be reused).
function templateOptions(selected) {
  if (String(selected || '').startsWith('doc:')) { const r = (S.references || []).find(x => 'doc:' + x.id === selected); return `<option value="${esc(selected)}" selected>Design of ${esc(r?.title || 'the reference report')}</option>` + templateOptions(null).replace(/ selected/g, ''); }
  const groups = new Map(); for (const t of S.templates) { const k = t.clientId || ''; if (!groups.has(k)) groups.set(k, []); groups.get(k).push(t); }
  const keys = [...groups.keys()].sort((a, b) => (a === S.client ? -1 : b === S.client ? 1 : !a ? 1 : !b ? -1 : clientName(a).localeCompare(clientName(b))));
  const sel = selected || (S.client && groups.get(S.client)?.[0]?.id) || S.templates[0]?.id || 'plain';
  return keys.map(k => `<optgroup label="${esc(k ? clientName(k) : 'No client')}">${groups.get(k).map(t => `<option value="${t.id}" ${t.id === sel ? 'selected' : ''}>${esc(t.name)}</option>`).join('')}</optgroup>`).join('') + `<option value="plain" ${sel === 'plain' ? 'selected' : ''}>Plain layout (no template)</option>`;
}
export async function renderReports(fresh) {
  const page = $('#repPage'); if (!page) return;
  if (fresh === true && S.loaded) { try { await load(); } catch {} } // opening the page picks up what teammates added
  if (!S.loaded) { page.innerHTML = '<div class="help" style="padding:40px">Loading…</div>'; try { await load(); } catch (e) { page.innerHTML = `<div class="help" style="color:var(--red)">${esc(e.message)}</div>`; return; } }
  page.innerHTML = `<div class="page-head"><div><h1><span class="h-ic c-orange">${ic('chart')}</span>Reports</h1><p class="sub">Your clients' data and templates in one place. Upload a client's spreadsheet and PowerPoint, describe what you need, and Canopus curates the data and builds the deck on that client's template. Data is processed and files are built on this server.</p></div>
      <div class="rp-clientbar"><label for="rpClient">Client</label><select id="rpClient" class="vsel"><option value="">All clients</option>${S.clients.map(c => `<option value="${c.id}" ${c.id === S.client ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}</select><button class="btn sm" data-r="newclient">${ic('plus')}New client</button></div></div>
    <div class="tabs">${[['clients', 'users', 'Clients'], ['data', 'table', 'Data curation'], ['decks', 'layers', 'Presentations'], ['finals', 'archive', 'Final reports'], ['templates', 'grid', 'Templates']].map(([k, i, l]) => `<button class="tab ${S.tab === k ? 'on' : ''}" data-r="tab" data-x="${k}">${ic(i)}${l}</button>`).join('')}</div>
    <div id="rpBody" style="padding-top:14px"></div>`;
  $('#rpClient').onchange = e => { S.form = null; S.client = e.target.value; savePrefs({ client: S.client }); S.ds = null; S.deck = null; S.clientDocs = null; S.finals = null; S.finQ = ''; renderReports(); };
  ({ clients: clientsView, data: S.ds ? dsView : dataHome, decks: S.deck ? deckView : deckHome, finals: finalsView, templates: tplView }[S.tab])();
  C.hydrateIcons(page);
}
// The report flow: Excel → curate (topic / sentiment) → Claude builds the deck & analysis → GPT finalizes → download.
function stepper() {
  if (!['data', 'decks'].includes(S.tab)) return '';
  const d = S.ds, k = S.deck; const final = k && /finali[sz]ed by/i.test(k.notes || '');
  const at = S.tab === 'data' ? (!d ? 1 : d.result ? 3 : 2) : !k ? 3 : final ? 5 : 4;
  const steps = ['Upload Excel', 'Curate: topic / sentiment', 'Claude: deck & analysis', 'GPT: finalize language & analysis', 'Download PowerPoint'];
  return `<ol class="rp-flow">${steps.map((t, i) => `<li class="${i + 1 < at ? 'done' : i + 1 === at ? 'now' : ''}"><span>${i + 1 < at ? '✓' : i + 1}</span>${t}</li>`).join('')}</ol>`;
}
const body = html => { $('#rpBody').innerHTML = stepper() + html; C.hydrateIcons($('#rpBody')); };
const modelSelect = (sel, id) => { const ms = C.me().config.models; return `<select id="${id}" class="vsel" title="AI model">${ms.length > 1 ? `<option value="auto">Auto (recommended)</option>` : ''}${ms.map(m => `<option value="${m.id}" ${sel === m.id ? 'selected' : ''}>${esc(m.label)}</option>`).join('')}</select>`; };
// Two-stage decks: one model analyzes (default: a Claude model), another finalizes the wording (default: a GPT model).
const PREF_KEY = 'canopus.reports.models';
const prefs = () => { try { return JSON.parse(localStorage.getItem(PREF_KEY) || '{}'); } catch { return {}; } };
const savePrefs = p => { try { localStorage.setItem(PREF_KEY, JSON.stringify({ ...prefs(), ...p })); } catch {} };
function stageSelects() {
  const ms = C.me().config.models; const p = prefs();
  const claude = ms.filter(m => m.provider === 'anthropic'); const gpt = ms.filter(m => m.provider === 'openai');
  const aDef = ms.some(m => m.id === p.analysis) ? p.analysis : (claude.find(m => m.tier === 'standard') || claude[0] || ms[0])?.id;
  const fDef = p.finalize === 'none' || ms.some(m => m.id === p.finalize) ? p.finalize : (gpt.find(m => m.tier === 'standard') || gpt[0])?.id || 'none';
  const opts = sel => ms.map(m => `<option value="${m.id}" ${sel === m.id ? 'selected' : ''}>${esc(m.label)}</option>`).join('');
  return `<div class="row2 rp-stages"><div><label for="rpDModel">1 · Analysis — charts, insights, recommendations</label><select id="rpDModel" class="vsel" style="width:100%">${opts(aDef)}</select></div>
    <div><label for="rpFModel">2 · Finalization — wording, titles, consistency</label><select id="rpFModel" class="vsel" style="width:100%"><option value="none" ${fDef === 'none' ? 'selected' : ''}>None (use the analysis as is)</option>${opts(fDef)}</select></div></div>`;
}
const finalizeSelect = () => { const ms = C.me().config.models; const p = prefs(); const gpt = ms.filter(m => m.provider === 'openai'); const def = ms.some(m => m.id === p.finalize) ? p.finalize : (gpt[0] || ms[0])?.id;
  return `<select id="rpReFModel" class="vsel" title="Model for finalization">${ms.map(m => `<option value="${m.id}" ${def === m.id ? 'selected' : ''}>${esc(m.label)}</option>`).join('')}</select>`; };
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
  body(`<div class="set-sec rp-drop"><div style="display:flex;gap:16px;align-items:center;flex-wrap:wrap"><div style="flex:1;min-width:240px"><h3>${ic('upload')}Upload a spreadsheet${curClient() ? ` for ${esc(curClient().name)}` : ''}</h3><p>Excel (.xlsx) or CSV in whatever format the client uses, e.g. a media monitoring log. Canopus finds the header row, then you describe what you need: cleaning, labels, filters, summaries.</p></div>
    <button class="cta" data-r="pickds">${ic('upload')}Upload Excel / CSV</button><input type="file" id="rpDsFile" accept=".xlsx,.csv,.tsv" hidden></div>
    <p class="help" style="margin-top:12px">${ic('lock')} Privacy: for planning, the AI sees column names, types and common values — not your rows. Labelling sends only the text columns you choose. Columns with ID numbers, phone numbers, e-mail or addresses are never sent.</p></div>
    ${S.datasets.filter(inClient).length ? `<div class="tblwrap"><table class="tbl"><thead><tr><th>Dataset</th><th class="r">Rows</th><th>Status</th><th>Updated</th><th></th></tr></thead><tbody>${S.datasets.filter(inClient).map(d => `<tr><td><a href="#" data-r="opends" data-x="${d.id}"><b>${esc(d.name)}</b></a><div class="muted">${d.clientId ? esc(clientName(d.clientId)) + ' · ' : ''}${esc(d.filename)} · ${C.fmtSize(d.size)}</div></td><td class="r">${(d.result_rows ?? d.rows ?? 0).toLocaleString('id-ID')}</td><td>${d.curated ? '<span class="cls biasa">Curated</span>' : d.planned ? '<span class="cls processing">Plan ready</span>' : '<span class="cls">New</span>'}</td><td class="muted">${C.ago(d.updated)}</td><td class="r"><button class="btn sm" data-r="opends" data-x="${d.id}">Open</button></td></tr>`).join('')}</tbody></table></div>`
      : `<div class="empty-box"><div class="e-ic">${ic('table')}</div><b>No datasets yet</b><p>Upload a monitoring spreadsheet to start.</p></div>`}`);
}
async function addDatasetFile(files) {
  const f = files?.[0]; if (!f || !S.ds) return; C.toast('Adding ' + f.name + '…');
  try { S.ds = await C.api(`/api/reports/datasets/${S.ds.id}/files`, { method: 'POST', raw: f, headers: { 'content-type': f.type || 'application/octet-stream', 'x-filename': encodeURIComponent(f.name) } }); S.plan = S.ds.plan; renderReports(); C.toast('File merged'); }
  catch (e) { C.toast(e.message, 5000); }
}
async function uploadDataset(files) {
  const f = files?.[0]; if (!f) return; C.toast('Reading ' + f.name + '…');
  try { const d = await C.api('/api/reports/datasets', { method: 'POST', raw: f, headers: { 'content-type': f.type || 'application/octet-stream', 'x-filename': encodeURIComponent(f.name), 'x-client': S.client } }); S.ds = d; S.plan = null; S.explanation = ''; S.dsResultTab = 0; await load(); renderReports(); }
  catch (e) { C.toast(e.message, 5000); }
}
// Polls a background run and keeps the progress visible; reopening the dataset resumes the display.
async function pollJob(did) {
  for (;;) {
    await new Promise(r => setTimeout(r, 1200)); let j;
    try { j = await C.api(`/api/reports/datasets/${did}/job`, { quiet: true }); } catch { continue; }
    if (S.ds?.id !== did) return; S.job = j;
    if (j.status === 'running') { const el = $('#rpJob'); if (el) el.outerHTML = jobHTML(j); else if (S.tab === 'data') renderReports(); continue; }
    S.busy = ''; S.job = null;
    if (j.status === 'error') C.toast('Run stopped: ' + j.error, 7000);
    S.ds = await C.api('/api/reports/datasets/' + did); S.plan = S.ds.plan; S.dsResultTab = 0; C.refreshMe?.(); renderReports(); return;
  }
}
function jobHTML(j) {
  const pct = j.total ? Math.round(j.done / j.total * 100) : Math.round((j.step - 1) / Math.max(1, j.steps) * 100);
  return `<div id="rpJob" class="rp-job"><div class="rp-job-top"><span class="shimmer">Step ${j.step || 1} of ${j.steps}: ${esc(j.text || '')}</span><b>${pct}%</b></div><div class="rp-bar"><i style="width:${pct}%"></i></div>${j.total ? `<small>${j.done.toLocaleString('id-ID')} of ${j.total.toLocaleString('id-ID')} texts labelled${j.cached ? ` · ${j.cached.toLocaleString('id-ID')} reused from earlier runs` : ''}</small>` : ''}</div>`;
}
async function openDataset(did) { try { S.ds = await C.api('/api/reports/datasets/' + did); S.tab = 'data'; S.plan = S.ds.plan; S.explanation = ''; S.dsResultTab = 0; const j = await C.api(`/api/reports/datasets/${did}/job`); if (j.status === 'running') { S.busy = 'run'; S.job = j; pollJob(did); } renderReports(); } catch (e) { C.toast(e.message, 4000); } }
function dsView() {
  const d = S.ds; const sh = d.sheets.find(s => s.name === d.sheet) || d.sheets[0];
  const steps = S.plan?.steps || [];
  body(`<div class="bar" style="align-items:center"><button class="btn sm" data-r="back">← All datasets</button><h2 style="flex:1;margin:0;font-size:20px">${esc(d.name)}</h2>
      <button class="btn sm" data-r="renameds">${ic('edit')}Rename</button>${d.result ? `<button class="btn sm" data-r="askds">${ic('chat')}Ask in chat</button><button class="btn sm primary" data-r="xlsx">${ic('download')}Download Excel</button>` : ''}<button class="icon-btn" data-r="delds" title="Delete">${ic('trash')}</button></div>
    <div class="set-sec"><div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap"><h3 style="flex:1;margin:0">${ic('table')}Source${d.files?.length > 1 ? `: ${d.files.length} files merged` : `: ${esc(d.filename)}`}</h3><button class="btn sm" data-r="addfile">${ic('plus')}Add another file</button><input type="file" id="rpDsMore" accept=".xlsx,.csv,.tsv" hidden></div>
      ${d.files?.length > 1 ? `<div class="rp-files">${d.files.map((f, i) => `<div class="doc-row">${ic('file')}<span class="t">${esc(f.name)}</span><label class="help" style="margin:0">MEDIA TYPE</label><input type="text" class="rp-flabel" data-fi="${i}" value="${esc(f.label)}"></div>`).join('')}<p class="help">Files are merged into one table by column name; the label of each file goes into the MEDIA TYPE column.</p></div>` : '<p class="help" style="margin-top:6px">Monitoring exported in several files (e.g. ONLINE and PRINTED)? Add the other files: they are merged into one table with a MEDIA TYPE column.</p>'}
      ${d.sheets.length > 1 ? `<div class="seg" style="margin-bottom:10px">${d.sheets.map(s => `<button class="${s.name === sh.name ? 'on' : ''}" data-r="sheet" data-x="${esc(s.name)}">${esc(s.name)} (${s.rows})</button>`).join('')}</div>` : ''}
      <p class="help">${sh.rows.toLocaleString('id-ID')} rows · ${sh.columns.length} columns${sh.skipped ? ` · ${sh.skipped} title row${sh.skipped > 1 ? 's' : ''} above the header skipped` : ''}${sh.personal.length ? ` · ${ic('lock')} personal-data columns never sent to the AI: ${sh.personal.map(esc).join(', ')}` : ''}</p>
      ${tableHTML(sh.columns, sh.preview, sh.personal)}</div>
    <div class="set-sec"><h3>${ic('sparkle')}What should Canopus do with this data?</h3>
      <textarea id="rpInstr" rows="3" placeholder="e.g. Buang duplikat, seragamkan nama media, beri label sentimen yang kosong, lalu buat rekap per media, per sentimen dan tren harian.">${esc(d.instruction || '')}</textarea>
      <div class="chips" style="margin:8px 0 12px">${DATA_CHIPS.map((c, i) => `<button class="chip" data-r="dchip" data-x="${i}" title="${esc(c)}"><b>${CHIP_LABELS[i]}</b></button>`).join('')}</div>
      <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap"><select id="rpCurChan" class="vsel" title="Channel">${(S.meta.channels || []).map(ch => `<option value="${ch.id}" ${ch.id === (S.curChan || 'medmas') ? 'selected' : ''}>${esc(ch.label)}</option>`).join('')}</select><select id="rpCurType" class="vsel" title="Report type — sets how trends are summarized (per day, week, month…)">${(S.meta.types || []).map(tp => `<option value="${tp.id}" ${tp.id === (S.curType || 'weekly') ? 'selected' : ''}>${esc(tp.label)}</option>`).join('')}</select>${modelSelect('auto', 'rpModel')}<button class="btn primary" data-r="plan" ${S.busy ? 'disabled' : ''}>${S.busy === 'plan' ? spin('Planning…') : ic('sparkle') + 'Draft a plan'}</button><span class="help" style="margin:0">Uses a little AI; nothing is changed until you run the plan.</span></div></div>
    <div class="set-sec"><div style="display:flex;align-items:center;gap:10px"><h3 style="flex:1;margin:0">${ic('memo')}Plan${steps.length ? ` · ${steps.length} steps` : ''}</h3><button class="btn sm" data-r="addstep">${ic('plus')}Add step</button>${steps.length ? `<button class="btn primary" data-r="run" ${S.busy ? 'disabled' : ''}>${S.busy === 'run' ? spin('Running…') : ic('bolt') + 'Run plan'}</button>` : ''}</div>
      ${S.explanation ? `<div class="notice" style="margin-top:10px">${esc(S.explanation)}</div>` : ''}
      ${steps.length ? `<ol class="rp-steps">${steps.map((s, i) => { const l = d.log?.[i]; return `<li class="rp-step ${s.op === 'ai_tag' ? 'ai' : ''}"><span class="badge">${esc(S.meta.ops?.[s.op] || s.op)}</span><span class="t">${esc(s.text || s.op)}</span>${l && JSON.stringify(stepKey(l)) === JSON.stringify(stepKey(s)) ? (l.ok ? `<small class="ok">${l.before !== l.after ? `${l.before} → ${l.after} rows` : l.changed != null ? `${l.changed} changed` : l.aiRows ? `${l.aiRows} labelled` : '✓'}</small>` : `<small class="bad" title="${esc(l.error)}">skipped</small>`) : ''}<span class="acts"><button class="icon-btn" data-r="upstep" data-x="${i}" title="Move up">↑</button><button class="icon-btn" data-r="editstep" data-x="${i}" title="Edit">${ic('edit')}</button><button class="icon-btn" data-r="rmstep" data-x="${i}" title="Remove">${ic('trash')}</button></span></li>`; }).join('')}</ol>`
        : `<p class="help">Describe what you need above and press <b>Draft a plan</b>, load a saved recipe, or add steps yourself — recipes and manual steps use no AI planning.</p>`}
      ${S.busy === 'run' && S.job ? jobHTML(S.job) : ''}
      ${recipeBar(d)}</div>
    ${d.result ? resultHTML(d) : ''}`);
}
const stepKey = x => x.text;
// Saved recipes: a client's curation plan, reused on next month's file without asking the AI again.
function recipeBar(d) {
  const cid = d.clientId || S.client; const mine = S.clients.find(c => c.id === cid)?.recipeList || [];
  const others = S.clients.filter(c => c.id !== cid).flatMap(c => c.recipeList.map(r => ({ ...r, client: c.name })));
  const opts = [...mine.map(r => `<option value="${r.id}">${esc(r.name)}</option>`), ...(others.length ? [`<optgroup label="Other clients">${others.map(r => `<option value="${r.id}">${esc(r.client)} · ${esc(r.name)}</option>`).join('')}</optgroup>`] : [])].join('');
  return `<div class="rp-recipes">${opts ? `<select id="rpRecipe" class="vsel">${opts}</select><button class="btn sm" data-r="loadrecipe">${ic('refresh')}Load recipe</button>` : '<span class="help" style="margin:0">No saved recipes yet.</span>'}
    ${S.plan?.steps?.length ? `<button class="btn sm" data-r="saverecipe">${ic('archive')}Save plan as recipe${cid ? ` for ${esc(clientName(cid))}` : ''}</button>` : ''}</div>`;
}
function resultHTML(d) {
  const tabs = [{ name: `Data (${d.result.table.rows.toLocaleString('id-ID')} rows)`, columns: d.result.table.columns, rows: d.result.table.preview }, ...d.result.summaries.map(s => ({ name: s.name, columns: s.columns, rows: s.rows }))];
  const cur = tabs[Math.min(S.dsResultTab, tabs.length - 1)]; const failed = (d.log || []).filter(l => !l.ok);
  return `<div class="set-sec"><div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap"><h3 style="flex:1;margin:0">${ic('check')}Result</h3><button class="btn sm primary" data-r="todeck">${ic('layers')}Next: Claude builds the deck →</button><button class="btn sm" data-r="xlsx">${ic('download')}Download Excel</button></div>
    ${d.result.removed ? `<p class="help" style="margin-top:10px">${ic('check')} Data awal ${(d.result.initial ?? 0).toLocaleString('id-ID')} = final ${d.result.table.rows.toLocaleString('id-ID')} + duplikat ${(d.result.removedBy?.Duplikat || 0).toLocaleString('id-ID')} + noise ${(d.result.removedBy?.Noise || 0).toLocaleString('id-ID')}${d.result.removedBy?.Lainnya ? ` + difilter ${d.result.removedBy.Lainnya.toLocaleString('id-ID')}` : ''}. Every removed row is listed in the “Log Pembersihan” sheet.</p>` : ''}
    ${(d.log || []).filter(l => l.ok && l.op === 'ai_tag' && l.labels?.length > 6).map(l => `<div class="notice" style="margin-top:8px">${esc(l.text)} — ${l.labels.length} labels${l.consistency ? ` · ${l.consistency} made consistent across outlets` : ''}. <button class="btn sm" data-r="saveissues" data-labels="${esc(JSON.stringify(l.labels))}">${ic('archive')}Save as the client's issue list</button></div>`).join('')}
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
  const curated = S.datasets.filter(d => d.curated && inClient(d)); const F = S.form || {};
  const sty = stylesOf(S.client); const selStyle = F.style ?? (curClient()?.style?.id || sty.styles.find(x => x.recommended)?.id || 'template');
  body(`<div class="set-sec"><h3>${ic('sparkle')}New presentation${curClient() ? ` for ${esc(curClient().name)}` : ''}</h3>${curClient() && (Object.keys(curClient().persona || {}).length || curClient().instructions) ? `<p class="help">${ic('check')} ${esc(curClient().name)}'s persona and your analyst persona are applied automatically.</p>` : ''}
    <label>Channel</label><div class="seg">${(S.meta.channels || []).map(ch => `<button type="button" data-r="rchan" data-x="${ch.id}" class="${(F.channel || 'medmas') === ch.id ? 'on' : ''}">${esc(ch.label)}</button>`).join('')}</div>
    <label>Report type</label><div class="seg rp-types">${(S.meta.types || []).map(tp => `<button type="button" data-r="rtype" data-x="${tp.id}" class="${(F.type || 'weekly') === tp.id ? 'on' : ''}" title="${esc(tp.focus)}">${esc(tp.short)}</button>`).join('')}</div>
    ${typeInfo(F.type || 'weekly', F.channel || 'medmas', F.reference)}
    <label for="rpRef">URS — Ultimate Reference Style (optional)</label><select id="rpRef" class="vsel" style="width:100%"><option value="">— No reference: use the structure above —</option>${groupRefs().map(([by, list]) => `<optgroup label="${esc(by)}">${list.map(r => `<option value="${r.id}" ${F.reference === r.id ? 'selected' : ''}>${esc(r.title)} · ${r.style ? 'language & style only' : r.design ? 'PPTX: design, structure & style' : 'structure & writing style'}</option>`).join('')}</optgroup>`).join('')}</select>
    ${F.reference && S.references.find(r => r.id === F.reference)?.design ? `<label class="help" style="margin:6px 0 0;display:flex;gap:6px;align-items:center"><input type="checkbox" id="rpRefDesign" ${F.refDesign !== false ? 'checked' : ''}> Also use its design (slide masters, colours, fonts) instead of the template below</label>` : ''}
    ${S.references.length ? '' : '<p class="help">No URS yet: an administrator adds them in Knowledge → URS, and seniors upload their best reports there.</p>'}
    <div class="row2"><div><label for="rpTitle">Title</label><input type="text" id="rpTitle" value="${esc(F.title || '')}" placeholder="e.g. Weekly Report Media Massa — Kemnaker"></div><div><label for="rpPeriod">Period</label><input type="text" id="rpPeriod" value="${esc(F.period || '')}" placeholder="e.g. 23–29 Oktober 2026"></div></div>
    <div class="row2"><div><label>Client</label><div class="help" style="margin:8px 0 0">${curClient() ? `${esc(curClient().name)} — persona, structure and style applied` : 'No client selected (choose one at the top to apply its persona and structure)'}</div></div>
      <div><label for="rpTpl">Template — any client's template can be used</label><select id="rpTpl" class="vsel" style="width:100%">${templateOptions(F.tpl)}</select></div></div>
    <label>Data to use</label>${curated.length ? `<div class="checks" id="rpDs">${curated.map(d => `<label><input type="checkbox" value="${d.id}" ${(F.ds ? F.ds.includes(d.id) : S.prefDs === d.id) ? 'checked' : ''}>${esc(d.name)} <span class="muted">(${(d.result_rows || 0).toLocaleString('id-ID')} rows)</span></label>`).join('')}</div>` : `<p class="help">No curated datasets yet — curate one in <a href="#" data-r="tab" data-x="data">Data curation</a>, or write the presentation from your brief alone.</p>`}
    <label for="rpBrief">Brief</label><textarea id="rpBrief" rows="4" placeholder="Who is it for, what period, what should it emphasize? e.g. Laporan mingguan untuk Kepala Biro: sorot isu keterlambatan distribusi dan beri 3 rekomendasi strategi komunikasi.">${esc(F.brief || '')}</textarea>
    <div class="chips" style="margin:8px 0 12px">${DECK_CHIPS.map((c, i) => `<button class="chip" data-r="kchip" data-x="${i}">${esc(c)}</button>`).join('')}</div>
    <label>Cover photo (optional)</label><div class="rp-shots">${(S.covers || []).map(x => `<label class="rp-shot rp-cover ${F.coverPick === x.id ? 'on' : ''}"><input type="radio" name="rpCov" value="${x.id}" ${F.coverPick === x.id ? 'checked' : ''} ${F.coverMode === 'pick' ? '' : 'disabled'}><img src="/api/reports/images/${x.id}" alt=""><button class="icon-btn" data-r="rmcover" data-x="${x.id}" title="Remove">${ic('trash')}</button></label>`).join('')}<button class="btn sm" data-r="pickcovers">${ic('upload')}Upload cover photos</button><input type="file" id="rpCoverFile" accept="image/png,image/jpeg" multiple hidden></div>
    ${(S.covers || []).length ? `<div class="rp-covopts"><div class="seg"><button type="button" data-r="covmode" data-x="auto" class="${F.coverMode !== 'pick' ? 'on' : ''}">Choose for me</button><button type="button" data-r="covmode" data-x="pick" class="${F.coverMode === 'pick' ? 'on' : ''}">I'll pick one</button></div>
      <select id="rpCovLayout" class="vsel">${[['auto', 'Layout: automatic'], ['full', 'Full photo with dark overlay'], ['split', 'Photo on the right'], ['none', 'No photo']].map(([v, l]) => `<option value="${v}" ${(F.coverLayout || 'auto') === v ? 'selected' : ''}>${l}</option>`).join('')}</select>
      <span class="help" style="margin:0">${F.coverMode === 'pick' ? 'Click the photo to use.' : 'Canopus picks the photo that best fits a landscape cover.'}</span></div>` : ''}
    <label>Screenshots (optional) — dashboard word cloud, map…</label><div class="rp-shots">${(S.shots || []).map(x => `<div class="rp-shot"><img src="/api/reports/images/${x.id}" alt=""><input type="text" data-shot="${x.id}" value="${esc(x.label)}" placeholder="What is it? e.g. Wordcloud dashboard"><button class="icon-btn" data-r="rmshot" data-x="${x.id}" title="Remove">${ic('trash')}</button></div>`).join('')}<button class="btn sm" data-r="pickshots">${ic('upload')}Add screenshots</button><input type="file" id="rpShotFile" accept="image/png,image/jpeg" multiple hidden></div>
    ${C.me().config.imageUploads ? '' : '<p class="help">Image reading by AI is off (Admin → Settings), so screenshots are placed in the deck but the AI does not read them — describe them in the brief or label.</p>'}
    <label>Style — colours and fonts applied to the template</label>${styleCards([{ id: 'template', name: 'Template as is', description: "Keep the template's own colours", colors: { dk2: '3A4250', accent1: '8892A0', accent2: 'B8C0CC', accent3: '1FA971', accent4: 'E04A4A', lt2: 'EEF1F5' } }, ...sty.styles], selStyle, 'pickstyle')}
    ${stageSelects()}
    <div style="display:flex;gap:12px;align-items:center;flex-wrap:wrap;margin-top:14px"><label class="help" style="margin:0;display:flex;gap:6px;align-items:center"><input type="checkbox" id="rpKnow" ${(F.know ?? !!curClient()?.docs) ? 'checked' : ''}> ${curClient() ? `Use ${esc(curClient().name)}'s documents` : 'Also use internal knowledge'}</label><button class="btn primary" data-r="draftdeck" ${S.busy ? 'disabled' : ''}>${S.busy === 'deck' ? spin('Writing slides… (up to a minute)') : ic('sparkle') + 'Draft slides'}</button></div>
    <p class="help">The analysis model receives the summary tables and a sample of the data's text columns (personal-data columns left out), chooses the charts and writes the insights; the finalization model polishes the wording and checks the numbers but cannot change which data a chart or table shows. Charts and tables are filled from the real data on this server.</p></div>
    ${S.decks.filter(inClient).length ? `<div class="tblwrap"><table class="tbl"><thead><tr><th>Presentation</th><th class="r">Slides</th><th>Updated</th><th></th></tr></thead><tbody>${S.decks.filter(inClient).map(k => `<tr><td><a href="#" data-r="opendeck" data-x="${k.id}"><b>${esc(k.title)}</b></a>${k.reportType ? ` <span class="badge">${k.channel === 'medsos' ? 'Medsos · ' : k.channel === 'both' ? 'Medmas+Medsos · ' : ''}${esc((S.meta.types || []).find(tp => tp.id === k.reportType)?.short || k.reportType)}${k.period ? ' · ' + esc(k.period) : ''}</span>` : ''}<div class="muted">${k.clientId ? esc(clientName(k.clientId)) + ' · ' : ''}${esc(k.brief)}</div></td><td class="r">${k.slides}</td><td class="muted">${C.ago(k.updated)}</td><td class="r"><button class="btn sm" data-r="opendeck" data-x="${k.id}">Open</button> <button class="btn sm" data-r="pptx" data-x="${k.id}">${ic('download')}PPTX</button></td></tr>`).join('')}</tbody></table></div>` : ''}`);
}
/* ---------- styles: presets + a palette recommended from the client's logos ---------- */
S.styleCache = {};
async function ensureStyles(cid) { const k = cid || ''; if (S.styleCache[k]) return S.styleCache[k]; S.styleCache[k] = { styles: [], current: null, loading: true }; const r = await C.api('/api/reports/styles' + (cid ? `?client=${cid}` : '')).catch(() => ({ styles: [], current: null })); S.styleCache[k] = r; renderReports(); return r; }
const stylesOf = cid => S.styleCache[cid || ''] || (ensureStyles(cid), { styles: [], current: null });
const swatches = st => ['dk2', 'accent1', 'accent2', 'accent3', 'accent4', 'lt2'].map(k => `<span style="background:#${st.colors[k]}"></span>`).join('');
function styleCards(list, selectedId, action) {
  if (!list.length) return '<p class="help">Loading styles…</p>';
  return `<div class="rp-styles">${list.map(st => `<button type="button" class="rp-style ${st.id === selectedId ? 'on' : ''}" data-r="${action}" data-x="${esc(st.id)}"><div class="rp-style-top" style="background:#${st.colors.dk2}"><i style="background:#${st.colors.accent2}"></i><b style="color:#fff">Aa</b><em style="background:#${st.colors.accent1}"></em></div>
    <div class="rp-style-b"><b>${esc(st.name)}${st.recommended ? ' <span class="badge gold">Recommended</span>' : ''}</b><div class="sw">${swatches(st)}</div><small>${esc(st.description || '')}${st.font ? ` · ${esc(st.font)}` : ''}</small></div></button>`).join('')}</div>`;
}
async function openDeck(kid) { try { S.deck = await C.api('/api/reports/decks/' + kid); S.sources = await C.api('/api/reports/sources', { method: 'POST', body: { datasets: S.deck.datasets } }); S.tab = 'decks'; renderReports(); } catch (e) { C.toast(e.message, 4000); } }
const tplColors = tid => ({ ...(S.templates.find(t => t.id === tid)?.info?.colors || {}), ...(S.deck?.style?.colors || {}) });
function slideThumb(s, colors) {
  const navy = '#' + (colors.dk2 || '1F3A5F'), acc = '#' + (colors.accent1 || '1E5AA8'), acc2 = '#' + (colors.accent2 || 'E8772E');
  const dark = ['title', 'section', 'closing'].includes(s.kind);
  const inner = s.kind === 'bullets' ? `<ul>${s.bullets.slice(0, 5).map(b => `<li>${esc(b.replace(/\*\*/g, '').replace(/^-\s*/, '› '))}</li>`).join('')}</ul>`
    : s.kind === 'two' ? `<div class="two"><div><b>${esc(s.left_title)}</b>${s.left.slice(0, 3).map(x => `<div>${esc(x)}</div>`).join('')}</div><div><b>${esc(s.right_title)}</b>${s.right.slice(0, 3).map(x => `<div>${esc(x)}</div>`).join('')}</div></div>`
    : s.kind === 'kpi' ? `<div class="kpis">${s.items.map(i => `<div><b style="color:${acc}">${esc(i.value)}</b><span>${esc(i.label)}</span></div>`).join('')}</div>`
    : s.kind === 'chart' ? `<div class="viz">${ic('chart')}<span>${esc(s.chart)} · ${esc(s.source)}</span></div>`
    : s.kind === 'table' ? `<div class="viz">${ic('table')}<span>${esc(s.source)}</span></div>`
    : s.kind === 'matrix' ? `<div class="mx">${s.quadrants.map(q => `<div><b style="color:${acc}">${esc(q.title)}</b>${q.points.slice(0, 2).map(p => `<span>${esc(p)}</span>`).join('')}</div>`).join('')}</div>`
    : s.kind === 'actions' ? `<div class="act"><div style="background:${acc}"><span>Aksi</span><span>PIC</span><span>Waktu</span></div>${s.rows.slice(0, 4).map(r => `<div><span>${esc(r.action)}</span><span>${esc(r.owner)}</span><span>${esc(r.when)}</span></div>`).join('')}</div>`
    : s.kind === 'summary' ? `<div class="sm-head" style="background:${navy}">${esc((s.headline || '').replace(/\*\*/g, ''))}</div><div class="two">${(s.findings || []).slice(0, 3).map(f => `<div><b style="color:${acc}">${esc(f.label)}</b> ${esc(f.text.replace(/\*\*/g, '')).slice(0, 70)}</div>`).join('')}</div>`
    : s.kind === 'news' ? `<div class="mx">${(s.items || []).slice(0, 4).map(it => `<div><b>${esc(it.headline).slice(0, 60)}</b><span>${esc(it.why).slice(0, 50)}</span></div>`).join('')}</div>`
    : s.kind === 'image' ? `<div class="two"><div class="viz" style="height:auto;min-height:60px">${s.image ? `<img src="/api/reports/images/${esc(s.image)}" style="max-width:100%;max-height:70px" alt="">` : ic('image')}</div><div>${(s.points || []).slice(0, 3).map(p => `<div>• ${esc(p).slice(0, 60)}</div>`).join('')}</div></div>`
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
  if (s.kind === 'summary') h += f('headline', 'Synthesis (one sentence; **bold** = highlighted phrase)', s.headline, 2) + f('findings', 'Findings (one per line: LABEL | sentence)', (s.findings || []).map(x => `${x.label} | ${x.text}`).join('\n'), 4) + f('focus', 'Focus for next period', s.focus || '', 2);
  if (s.kind === 'news') h += `<div class="row2"><div>${srcSel(s.source)}</div><div><label>Sentiment</label><select data-f="sentiment" data-i="${i}" class="vsel" style="width:100%">${['positif', 'negatif', 'netral'].map(v => `<option ${v === s.sentiment ? 'selected' : ''}>${v}</option>`).join('')}</select></div></div>${f('items', 'News (one per line: exact headline from the data | why it matters)', (s.items || []).map(x => `${x.headline} | ${x.why}`).join('\n'), 5)}`;
  if (s.kind === 'image') h += `<label>Screenshot</label><select data-f="image" data-i="${i}" class="vsel" style="width:100%"><option value="">—</option>${(S.deck.images || []).map(x => `<option value="${x.id}" ${x.id === s.image ? 'selected' : ''}>${esc(x.label || x.id)}</option>`).join('')}</select>${f('points', 'Analysis (one sentence per line)', (s.points || []).join('\n'), 4)}`;
  if (s.kind === 'chart') h += `<div class="row2"><div>${f('note', 'On-chart note (e.g. the peak)', s.note || '')}</div><div>${f('highlight', 'Highlight category', s.highlight || '')}</div></div>`;
  if (s.kind === 'table' || s.kind === 'chart') h += `<div class="row2"><div>${f('filter_col', 'Only rows where column…', s.filter?.column || '')}</div><div>${f('filter_val', '…equals', s.filter?.value || '')}</div></div>`;
  if (s.kind === 'matrix') h += `<div class="row2">${s.quadrants.map((q, k) => `<div>${f('q' + k + 't', ['Top left', 'Top right', 'Bottom left', 'Bottom right'][k] + ' — heading', q.title)}${f('q' + k + 'p', 'Points (one per line)', q.points.join('\n'), 3)}</div>`).join('')}</div>`;
  if (s.kind === 'actions') h += f('rows', 'Actions (one per line: action | owner | when | success indicator)', s.rows.map(r => [r.action, r.owner, r.when, r.kpi].join(' | ')).join('\n'), 6);
  if (s.kind === 'chart') h += `<div class="row2"><div>${srcSel(s.source)}</div><div><label>Chart type</label><select data-f="chart" data-i="${i}" class="vsel" style="width:100%">${['column', 'bar', 'line', 'pie', 'doughnut'].map(c => `<option ${c === s.chart ? 'selected' : ''}>${c}</option>`).join('')}</select></div></div>${f('category', `Category column${cols.length ? ' — ' + cols.join(', ') : ''}`, s.category)}${f('series', 'Value columns (comma-separated)', s.series.join(', '))}<label class="help" style="display:flex;gap:6px;align-items:center"><input type="checkbox" data-f="stacked" data-i="${i}" ${s.stacked ? 'checked' : ''}> Stacked</label>`;
  if (s.kind === 'table') h += `${srcSel(s.source)}${f('columns', `Columns (comma-separated, empty = all)${cols.length ? ' — ' + cols.join(', ') : ''}`, s.columns.join(', '))}${f('top', 'Show only the first N rows (0 = all)', s.top || 0)}`;
  if (['kpi', 'table', 'chart', 'matrix', 'actions'].includes(s.kind)) h += f('caption', 'Insight (shown under the visual)', s.caption || '', 2);
  return h;
}
// Remember the new-presentation form while uploads or choices re-render the page.
// What the chosen report type changes, and which structure will be used (the client's own or the type's default).
function groupRefs() { const m = new Map(); for (const r of S.references || []) { const k = r.by || 'Team'; if (!m.has(k)) m.set(k, []); m.get(k).push(r); } return [...m]; }
S.structCache = {};
function structPreview(typeId, channel) { const key = `${S.client}|${typeId}|${channel}`; if (!S.structCache[key]) { S.structCache[key] = { loading: true }; C.api(`/api/reports/structure?client=${S.client || ''}&type=${typeId}&channel=${channel}`).then(r => { S.structCache[key] = r; const a = document.activeElement, fid = a?.id, sel = [a?.selectionStart, a?.selectionEnd]; captureForm(); renderReports(); const f = fid && document.getElementById(fid); if (f) { f.focus(); try { f.setSelectionRange(...sel); } catch {} } }).catch(() => {}); } return S.structCache[key]; }
function finalsLine(sp) {
  const u = sp?.finals?.using || []; if (!curClient()) return '';
  if (!u.length) return `<div class="help" style="margin:6px 0 0">${ic('archive')} No final report of this type yet for ${esc(curClient().name)}. File edited finals in <a href="#" data-r="tab" data-x="finals">Final reports</a> so the next ones learn from them.</div>`;
  const on = S.form?.learn !== false;
  return `<label class="help" style="margin:6px 0 0;display:flex;gap:6px;align-items:flex-start"><input type="checkbox" id="rpLearn" ${on ? 'checked' : ''}> <span>${ic('archive')} Learn from ${esc(curClient().name)}'s edited final report${u.length > 1 ? 's' : ''}: ${u.map(f => `<b>${esc(f.title)}</b>${f.period ? ` (${esc(f.period)})` : ''}${f.match === 'type' ? ` · ${esc(chanLabel(f.channel))}` : ''}`).join(', ')} — structure, slide titles, phrasing and the editor's corrections.</span></label>`;
}
const chanLabel = id_ => (S.meta.channels || []).find(c => c.id === id_)?.label || id_;
const typeLabel = id_ => (S.meta.types || []).find(t => t.id === id_)?.short || id_;
function typeInfo(typeId, channel = 'medmas', reference) {
  const tp = (S.meta.types || []).find(x => x.id === typeId); if (!tp) return ''; const ch = (S.meta.channels || []).find(x => x.id === channel);
  if (reference && !String(reference).startsWith('senior:')) { const r = S.references.find(x => x.id === reference); return `<div class="rp-typeinfo"><b>${esc(tp.label)}</b> · ${esc(ch?.label || '')}<div>${esc(tp.focus)}</div><div>Structure and writing style follow <b>${esc(r?.title || 'the reference report')}</b>${r?.by ? ` by ${esc(r.by)}` : ''}.</div></div>`; }
  const focus = channel === 'medsos' ? tp.focus.replace(/media and spokespersons/g, 'platforms and accounts').replace(/reputation of leaders/g, 'conversation about leaders') : tp.focus;
  const sp = structPreview(typeId, channel); const text = sp.text || ''; const n = text ? text.split('\n').filter(l => l.trim() && !/^maks|^max/i.test(l)).length : 0;
  return `<div class="rp-typeinfo"><b>${esc(tp.label)}</b> · ${esc(ch?.label || '')} · ${esc(tp.period)}${tp.maxSlides ? ` · up to ${tp.maxSlides} slides` : ''}<div>${esc(focus)}</div>${sp.loading ? '' : text ? `<details><summary>Structure: ${sp.source === 'final' ? `from ${esc(curClient()?.name || 'the client')}'s latest final report` : sp.source === 'client' ? `${esc(curClient()?.name || 'client')}'s own` : 'default'} (${n} slides)${sp.source === 'final' ? ' — file a newer final to update it, or write your own in the client page' : curClient() ? ' — edit it in the client page' : ''}</summary><pre>${esc(text)}</pre></details>` : '<div class="help" style="margin:4px 0 0">No fixed structure: the brief decides.</div>'}${finalsLine(sp)}</div>`;
}
function captureForm() { if (!$('#rpBrief')) return; S.form = { ...(S.form || {}), learn: $('#rpLearn') ? $('#rpLearn').checked : S.form?.learn, reference: $('#rpRef')?.value || '', refDesign: $('#rpRefDesign') ? $('#rpRefDesign').checked : S.form?.refDesign, period: $('#rpPeriod')?.value, coverLayout: $('#rpCovLayout')?.value || S.form?.coverLayout, coverPick: document.querySelector('[name=rpCov]:checked')?.value || S.form?.coverPick, title: $('#rpTitle')?.value, brief: $('#rpBrief')?.value, tpl: $('#rpTpl')?.value, know: $('#rpKnow')?.checked, ds: [...document.querySelectorAll('#rpDs input:checked')].map(i => i.value) };
  document.querySelectorAll('[data-shot]').forEach(el => { const sh = (S.shots || []).find(x => x.id === el.dataset.shot); if (sh) sh.label = el.value.trim(); }); }
function deckView() {
  const k = S.deck; const colors = tplColors(k.template);
  body(`<div class="bar" style="align-items:center;flex-wrap:wrap;gap:8px"><button class="btn sm" data-r="backdeck">← All presentations</button><input type="text" id="rpDTitle" value="${esc(k.title)}" style="flex:1 1 320px;min-width:260px;font-size:18px;font-weight:600">
      <select id="rpDTpl" class="vsel" title="Template">${templateOptions(k.template)}</select>
      ${finalizeSelect()}<button class="btn sm" data-r="refinal" ${S.busy ? 'disabled' : ''}>${S.busy === 'final' ? spin('Finalizing…') : ic('sparkle') + 'Finalize again'}</button><button class="btn sm" data-r="savedeck">${ic('check')}Save</button><button class="btn sm primary" data-r="pptx" data-x="${k.id}">${ic('download')}Download PowerPoint</button><button class="btn sm" data-r="filefinal" title="After the editor has finished: upload the edited version so Canopus learns from it">${ic('archive')}File the edited final</button><button class="icon-btn" data-r="deldeck" title="Delete">${ic('trash')}</button></div>
    ${k.notes ? `<div class="notice">${esc(k.notes)}</div>` : ''}
    <details class="rp-deckstyle"><summary>${ic('sparkle')}Style: <b>${esc(k.style?.name || 'Template as is')}</b> — change colours and fonts</summary>${styleCards([{ id: 'template', name: 'Template as is', description: "Keep the template's own colours", colors: { dk2: '3A4250', accent1: '8892A0', accent2: 'B8C0CC', accent3: '1FA971', accent4: 'E04A4A', lt2: 'EEF1F5' } }, ...stylesOf(k.clientId).styles], k.style?.id || 'template', 'deckstyle')}</details>
    ${k.outline.cover?.candidates?.length ? `<details class="rp-deckstyle"><summary>${ic('image')}Cover: <b>${k.outline.cover.mode === 'pick' ? 'your choice' : 'chosen by Canopus'} · ${({ full: 'full photo with overlay', split: 'photo on the right', none: 'no photo' })[k.outline.cover.layout] || ''}</b></summary>
      <div class="rp-shots" style="margin-top:8px">${k.outline.cover.candidates.map(id_ => `<button type="button" class="rp-shot rp-cover ${k.outline.cover.image === id_ ? 'on' : ''}" data-r="deckcover" data-x="${id_}"><img src="/api/reports/images/${id_}" alt=""></button>`).join('')}<button type="button" class="btn sm" data-r="deckcover" data-x="auto">Choose for me</button>
      <select id="rpDCovLayout" class="vsel">${[['full', 'Full photo with dark overlay'], ['split', 'Photo on the right'], ['none', 'No photo']].map(([v, l]) => `<option value="${v}" ${k.outline.cover.layout === v ? 'selected' : ''}>${l}</option>`).join('')}</select></div></details>` : ''}
    <div id="rpChecks"></div>
    <div class="rp-shots" style="margin:8px 0 4px">${(k.images || []).map(x => `<div class="rp-shot sm" title="${esc(x.label)}"><img src="/api/reports/images/${x.id}" alt=""><small>${esc(x.id)} · ${esc(x.label)}</small></div>`).join('')}<button class="btn sm" data-r="deckshot">${ic('upload')}Add screenshot</button><input type="file" id="rpDeckShot" accept="image/png,image/jpeg" multiple hidden></div>
    <div class="rp-slides">${k.outline.slides.map((s, i) => `<div class="rp-slide"><div class="rp-slide-l">${slideThumb(s, colors)}<div class="rp-slide-tools"><span class="badge">${i + 1} · ${KIND_LABEL[s.kind]}</span><button class="icon-btn" data-r="sup" data-x="${i}" title="Move up">↑</button><button class="icon-btn" data-r="sdown" data-x="${i}" title="Move down">↓</button><button class="icon-btn" data-r="sdel" data-x="${i}" title="Delete slide">${ic('trash')}</button></div></div><div class="rp-slide-r">${slideFields(s, i)}</div></div>`).join('')}</div>
    <div class="set-sec" style="display:flex;gap:10px;align-items:center;flex-wrap:wrap"><b style="flex:1">Add a slide</b>${Object.entries(KIND_LABEL).map(([kk, l]) => `<button class="btn sm" data-r="sadd" data-x="${kk}">${ic('plus')}${l}</button>`).join('')}</div>`);
  loadChecks();
  $('#rpBody').oninput = $('#rpBody').onchange = e => { const el = e.target; if (el.dataset.f == null || el.dataset.i == null) return; const s = k.outline.slides[+el.dataset.i]; const v = el.type === 'checkbox' ? el.checked : el.value;
    const list = x => x.split('\n').map(y => y.trimEnd()).filter(y => y.trim());
    switch (el.dataset.f) {
      case 'bullets': case 'left': case 'right': s[el.dataset.f] = list(v); break;
      case 'series': case 'columns': s[el.dataset.f] = v.split(',').map(y => y.trim()).filter(Boolean); break;
      case 'items': if (s.kind === 'news') { s.items = list(v).map(l => { const [headline, ...why] = l.split('|'); return { headline: headline.trim(), why: why.join('|').trim() }; }); break; } s.items = list(v).map(l => { const [value, label, note] = l.split('|').map(y => y.trim()); return { value: value || '', label: label || '', note: note || '' }; }); break;
      case 'top': s.top = +v || 0; break;
      case 'findings': s.findings = list(v).map(l => { const [label, ...rest] = l.split('|'); return rest.length ? { label: label.trim(), text: rest.join('|').trim() } : { label: '', text: label.trim() }; }); break;
      case 'points': s.points = list(v); break;
      case 'filter_col': case 'filter_val': { s.filter = { ...(s.filter || {}), [el.dataset.f === 'filter_col' ? 'column' : 'value']: v }; if (!s.filter.column) delete s.filter; break; }
      case 'rows': s.rows = list(l => { const [action, owner, when, kpi] = l.split('|').map(y => y.trim()); return { action: action || '', owner: owner || '', when: when || '', kpi: kpi || '' }; }); break;
      default: { const q = el.dataset.f.match(/^q(\d)([tp])$/); if (q) { const quad = s.quadrants[+q[1]]; if (q[2] === 't') quad.title = v; else quad.points = list(v); } else s[el.dataset.f] = v; }
    }
    k.dirty = true; if (e.type === 'change') { const th = el.closest('.rp-slide')?.querySelector('.thumb169'); if (th) th.outerHTML = slideThumb(s, tplColors($('#rpDTpl').value)); }
  };
}
// Quality checks before delivery (slide limit, structure, labels, fragments, avoided terms, numbers not in the data).
async function loadChecks() {
  const box = $('#rpChecks'); if (!box || !S.deck) return; const cs = await C.api(`/api/reports/decks/${S.deck.id}/checks`).catch(() => []);
  box.innerHTML = cs.length ? `<div class="rp-checks"><b>${C.ic('check')}Quality checks · ${cs.length} to review</b>${cs.slice(0, 30).map(c => `<div class="${c.level}">${esc(c.text)}</div>`).join('')}</div>` : `<div class="rp-checks ok"><b>${C.ic('check')}Quality checks passed</b></div>`;
}
async function saveDeck(quiet) {
  const k = S.deck; const r = await C.api('/api/reports/decks/' + k.id, { method: 'PUT', body: { title: $('#rpDTitle')?.value ?? k.title, template: $('#rpDTpl')?.value ?? k.template, outline: k.outline } });
  S.deck = r; S.decks = (await C.api('/api/reports')).decks; if (!quiet) C.toast('Saved'); loadChecks();
}
const NEW_SLIDE = { title: { kind: 'title', title: 'Judul', subtitle: '' }, section: { kind: 'section', title: 'Bagian baru' }, bullets: { kind: 'bullets', title: 'Judul', bullets: ['Poin pertama'] },
  two: { kind: 'two', title: 'Perbandingan', left_title: 'Kiri', left: ['Poin'], right_title: 'Kanan', right: ['Poin'] }, kpi: { kind: 'kpi', title: 'Angka kunci', items: [{ value: '0', label: 'Label', note: '' }], caption: '' },
  quote: { kind: 'quote', title: 'Kutipan', quote: 'Teks kutipan', source: '' },
  matrix: { kind: 'matrix', title: 'Analisis SWOT', quadrants: [{ title: 'Kekuatan', points: [] }, { title: 'Kelemahan', points: [] }, { title: 'Peluang', points: [] }, { title: 'Ancaman', points: [] }], caption: '' },
  summary: { kind: 'summary', title: 'Executive Summary', headline: 'Kesimpulan utama dengan **frasa kunci**.', findings: [{ label: 'DORONGAN', text: 'Temuan pertama.' }], focus: '' },
  news: { kind: 'news', title: 'Sampel Berita Positif', source: '', sentiment: 'positif', items: [] }, image: { kind: 'image', title: 'Wordcloud', image: '', points: [], caption: '' },
  actions: { kind: 'actions', title: 'Rencana Aksi', rows: [{ action: 'Aksi', owner: 'PIC', when: 'Minggu ini', kpi: 'Indikator' }], caption: '' }, table: { kind: 'table', title: 'Tabel', source: '', columns: [], top: 10, caption: '' },
  chart: { kind: 'chart', title: 'Grafik', source: '', chart: 'column', category: '', series: [], stacked: false, caption: '' }, closing: { kind: 'closing', title: 'Terima kasih', subtitle: '' } };

/* ================= templates ================= */
function tplCard(t) {
  const c = t.info.colors || {}; const st = t.info.structure || [];
  return `<div class="card"><div class="rp-tplprev" style="background:#${c.dk2 || '1F3A5F'}"><i style="background:#${c.accent2 || 'E8772E'}"></i><b>${esc(t.name)}</b><div class="swatches">${['accent1', 'accent2', 'accent3', 'accent4', 'accent5', 'accent6'].map(k => c[k] ? `<span style="background:#${c[k]}"></span>` : '').join('')}</div></div>
    <div class="card-body"><div class="card-top"><h3>${esc(t.name)}</h3></div><div class="date">${t.scope === 'personal' ? 'Only me · ' : ''}${C.ago(t.created)}</div>
    <div class="badges"><span class="badge">${t.info.ratio}</span><span class="badge">${t.info.layouts.length} layouts</span>${t.info.font ? `<span class="badge">${esc(t.info.font)}</span>` : ''}${st.length ? `<span class="badge gold" title="${esc(st.map((s, i) => `${i + 1}. ${s.title}`).join('\n'))}">${st.length} reference slides</span>` : ''}</div>
    <label class="help" style="margin:10px 0 4px">Client</label><select class="vsel" data-tplmove="${t.id}" style="width:100%"><option value="">No client</option>${S.clients.map(k => `<option value="${k.id}" ${k.id === t.clientId ? 'selected' : ''}>${esc(k.name)}</option>`).join('')}</select>
    <div style="display:flex;gap:6px;margin-top:10px"><button class="btn sm" data-r="tpldl" data-x="${t.id}">${ic('download')}Download</button><button class="btn sm" data-r="tpldel" data-x="${t.id}">${ic('trash')}Delete</button></div></div></div>`;
}
function tplUploadBox() {
  return `<div class="set-sec"><div style="display:flex;gap:16px;align-items:center;flex-wrap:wrap"><div style="flex:1;min-width:240px"><h3>${ic('upload')}Add a template${curClient() ? ` for ${esc(curClient().name)}` : ''}</h3><p>Upload the client's PowerPoint (.pptx or .potx): their official template or an earlier report. Canopus uses its masters, layouts, colors and fonts; if the file has slides, their order and titles become the structure the AI follows. Every client can use any template.</p></div>
    <div style="display:flex;gap:8px;align-items:center"><button class="cta" data-r="picktpl">${ic('upload')}Upload template</button><input type="file" id="rpTplFile" accept=".pptx,.potx" hidden></div></div></div>`;
}
function tplView() {
  const list = S.templates.filter(inClient);
  const groups = [...new Set(list.map(t => t.clientId || ''))].sort((a, b) => (!a ? 1 : !b ? -1 : clientName(a).localeCompare(clientName(b))));
  body(tplUploadBox() + (list.length ? groups.map(g => `<h3 class="rp-group">${esc(g ? clientName(g) : 'No client')}</h3><div class="cards rp-tpls">${list.filter(t => (t.clientId || '') === g).map(tplCard).join('')}</div>`).join('')
    : `<div class="empty-box"><div class="e-ic">${ic('grid')}</div><b>No templates yet</b><p>Templates come from your clients: upload their PowerPoint here or in the client's page.</p></div>`));
}
/* ================= clients ================= */
function clientModal(c) {
  C.openModal(`<h3>${c ? 'Edit client' : 'New client'}</h3><p class="s">A client keeps its templates, saved data recipes, guidelines and documents together. The whole team can use them.</p>
    <label for="clName">Name</label><input type="text" id="clName" value="${esc(c?.name || '')}" autofocus placeholder="e.g. Kementerian X">
    <label for="clDesc">Short description</label><input type="text" id="clDesc" value="${esc(c?.description || '')}" placeholder="e.g. Ministry, monthly media monitoring + quarterly strategy">
    <div class="persona-box"><b>${ic('star')}Client persona</b><p>The client's voice and boundaries. Applied to every deck for this client and to chats aimed at this client's space, on top of each analyst's own persona.</p>${C.personaFields('cp', C.me().personaFields.client, c?.persona || {})}</div>
    <div style="margin:6px 0 0"><button type="button" class="btn sm" data-r="structpreset">${ic('memo')}Insert example structure (weekly media monitoring)</button></div>
    <label for="clInstr">Other guidelines</label><textarea id="clInstr" rows="3" placeholder="Report structure they expect, who signs off, deadlines…">${esc(c?.instructions || '')}</textarea>
    <div class="dlg-actions"><button class="btn" data-dlg="cancel">Cancel</button><button class="btn primary" data-r="saveclient" data-x="${c?.id || ''}">Save</button></div>`, 'wide');
}
function personaView(c) {
  const f = C.me().personaFields.client; const p = c.persona || {};
  const rows = [...f.filter(([k]) => p[k]).map(([k, label]) => [label, p[k]]), ...(c.instructions ? [['Other guidelines', c.instructions]] : [])];
  return rows.length ? `<dl class="persona-view">${rows.map(([l, v]) => `<dt>${esc(l)}</dt><dd>${esc(v)}</dd>`).join('')}</dl>` : '';
}
async function loadClientDocs() { const c = curClient(); if (!c) return; const k = await C.api('/api/knowledge').catch(() => []); S.clientDocs = k.find(x => x.id === c.collection_id)?.docs || []; }
function clientsView() {
  const c = curClient();
  if (!c) {
    body(S.clients.length ? `<div class="cards rp-clients">${S.clients.map(k => `<div class="card" data-r="openclient" data-x="${k.id}" role="button"><div class="card-body"><div class="card-top"><h3>${esc(k.name)}</h3></div><div class="date">${esc(k.description || 'Client')}</div>
        <div class="badges"><span class="badge">${k.templates} template${k.templates === 1 ? '' : 's'}</span><span class="badge">${k.recipes} recipe${k.recipes === 1 ? '' : 's'}</span><span class="badge">${k.docs} document${k.docs === 1 ? '' : 's'}</span>${Object.keys(k.persona || {}).length || k.instructions ? '<span class="badge gold">Persona</span>' : ''}</div></div></div>`).join('')}</div>`
      : `<div class="empty-box"><div class="e-ic">${ic('users')}</div><b>No clients yet</b><p>Create a client for each customer. Their templates, data recipes, guidelines and documents stay together, ready for the next report.</p><button class="cta" data-r="newclient">${ic('plus')}New client</button></div>`);
    return;
  }
  if (S.clientDocs === null) { S.clientDocs = []; loadClientDocs().then(() => S.tab === 'clients' && curClient()?.id === c.id && renderReports()); }
  const tpls = S.templates.filter(t => t.clientId === c.id), ds = S.datasets.filter(d => d.clientId === c.id), decks = S.decks.filter(k => k.clientId === c.id);
  body(`<div class="bar" style="align-items:center;flex-wrap:wrap"><h2 style="flex:1;margin:0;font-size:22px">${esc(c.name)}</h2><button class="btn sm" data-r="editclient">${ic('edit')}Edit</button><button class="btn sm" data-r="tab" data-x="data">${ic('table')}Curate data</button><button class="btn sm primary" data-r="tab" data-x="decks">${ic('layers')}New presentation</button><button class="icon-btn" data-r="delclient" title="Delete client">${ic('trash')}</button></div>
    <div class="set-sec"><h3>${ic('star')}Client persona</h3>${personaView(c) || `<p>No persona yet. Describe the client's voice, audiences, key messages, terms to use or avoid and sensitive issues — applied to every deck and to chats aimed at this client. <a href="#" data-r="editclient">Add persona</a></p>`}</div>
    <div class="set-sec"><div style="display:flex;gap:14px;align-items:center;flex-wrap:wrap"><div style="flex:1;min-width:220px"><h3>${ic('image')}Logos</h3><p>Upload every version you have (colour, white, partner logos). Canopus places the darkest on light slides and the footer, the brightest on dark covers, and reads their colours to recommend a style.</p></div>
      <button class="btn sm" data-r="picklogo">${ic('upload')}Upload logos</button><input type="file" id="rpLogoFile" accept="image/png,image/jpeg" multiple hidden></div>
      <div class="rp-logos">${(c.logos || []).map(l => `<div class="rp-logo-card ${l.lum > 0.75 ? 'light' : ''}"><img src="/api/reports/clients/${c.id}/logos/${l.id}" alt=""><small>${esc(l.label)}${l.colors?.length ? `<span class="sw">${l.colors.map(x => `<span style="background:#${x}"></span>`).join('')}</span>` : ''}</small><button class="icon-btn" data-r="dellogo" data-x="${l.id}" title="Remove">${ic('trash')}</button></div>`).join('') || '<p class="help">No logos yet.</p>'}</div></div>
    <div class="set-sec"><h3>${ic('memo')}Report structures</h3><p>The slides each report type should have for this client. Leave a type empty to use the default structure.</p>
      <div class="seg" style="margin:6px 0 4px">${(S.meta.channels || []).map(ch => `<button type="button" data-r="cchan" data-x="${ch.id}" class="${(S.cchan || 'medmas') === ch.id ? 'on' : ''}">${esc(ch.label)}</button>`).join('')}</div>
      <div class="seg rp-types" style="margin:6px 0 8px">${(S.meta.types || []).filter(tp => tp.id !== 'adhoc').map(tp => `<button type="button" data-r="ctype" data-x="${tp.id}" class="${(S.ctype || 'weekly') === tp.id ? 'on' : ''}">${esc(tp.short)}${c.structures?.[skey(tp.id)] ? ' •' : ''}</button>`).join('')}</div>
      <textarea id="rpStruct" rows="8" placeholder="${esc(structPreview(S.ctype || 'weekly', S.cchan || 'medmas').source === 'default' ? structPreview(S.ctype || 'weekly', S.cchan || 'medmas').text || '' : '')}">${esc(c.structures?.[skey(S.ctype || 'weekly')] || '')}</textarea>
      <div style="display:flex;gap:8px;margin-top:8px"><button class="btn sm primary" data-r="savestruct">${ic('check')}Save structure</button><button class="btn sm" data-r="usedefstruct">Start from the default</button><span class="help" style="margin:0">One slide per line: Title — what it shows. Add “Maks N slide” to cap it.</span></div></div>
    <div class="set-sec"><h3>${ic('sparkle')}Default style</h3><p>Colours and fonts applied to this client's decks on top of any template. “Recommended” is built from the logo colours. You can still change it per presentation.</p>
      ${styleCards([{ id: 'template', name: 'Template as is', description: "Keep the template's own colours", colors: { dk2: '3A4250', accent1: '8892A0', accent2: 'B8C0CC', accent3: '1FA971', accent4: 'E04A4A', lt2: 'EEF1F5' } }, ...stylesOf(c.id).styles], c.style?.id || 'template', 'clientstyle')}</div>
    ${tplUploadBox()}${tpls.length ? `<div class="cards rp-tpls">${tpls.map(tplCard).join('')}</div>` : ''}
    <div class="set-sec"><h3>${ic('refresh')}Data recipes</h3><p>Curation plans saved from earlier work for this client. Load one on next month's file: no AI planning needed.</p>
      ${c.recipeList.length ? c.recipeList.map(r => `<div class="doc-row">${ic('bolt')}<span class="t">${esc(r.name)}</span><small>${r.columns.length} columns · ${C.ago(r.created)}</small><button class="icon-btn" data-r="delrecipe" data-x="${r.id}" title="Delete">${ic('trash')}</button></div>`).join('') : '<p class="help">Run a plan in Data curation, then “Save plan as recipe”.</p>'}</div>
    <div class="set-sec"><div style="display:flex;gap:12px;align-items:center;flex-wrap:wrap"><div style="flex:1;min-width:240px"><h3>${ic('book')}Client documents</h3><p>Earlier reports, briefs and guidelines (PDF, DOCX, TXT, CSV). Searchable in chat and used for this client's decks; indexed on this server.</p></div>
      <select id="rpDocCls" class="vsel"><option value="biasa">General (Biasa)</option><option value="terbatas">Restricted (Terbatas)</option></select><button class="btn sm" data-r="pickdoc">${ic('upload')}Upload documents</button><input type="file" id="rpDocFile" multiple hidden></div>
      ${(S.clientDocs || []).map(d => `<div class="doc-row">${ic('file')}<span class="t">${esc(d.title)}</span><small>${d.status === 'ready' ? `${d.chunks} passages` : esc(d.status)} · ${C.ago(d.created)}</small></div>`).join('') || '<p class="help">No documents yet.</p>'}</div>
    <div class="row2"><div class="set-sec"><h3>${ic('table')}Datasets</h3>${ds.map(d => `<div class="doc-row"><a href="#" data-r="opends" data-x="${d.id}" class="t">${esc(d.name)}</a><small>${C.ago(d.updated)}</small></div>`).join('') || '<p class="help">None yet.</p>'}</div>
      <div class="set-sec"><h3>${ic('layers')}Presentations</h3>${decks.map(k => `<div class="doc-row"><a href="#" data-r="opendeck" data-x="${k.id}" class="t">${esc(k.title)}</a><small>${C.ago(k.updated)}</small></div>`).join('') || '<p class="help">None yet.</p>'}</div></div>`);
}
async function uploadClientDocs(files) {
  const c = curClient(); if (!c || !files?.length) return; let n = 0;
  for (const f of files) { try { C.toast('Indexing ' + f.name + '…', 6000); await C.api(`/api/reports/clients/${c.id}/docs`, { method: 'POST', raw: f, headers: { 'content-type': f.type || 'application/octet-stream', 'x-filename': encodeURIComponent(f.name), 'x-classification': $('#rpDocCls')?.value || 'biasa' } }); n++; } catch (e) { C.toast(`${f.name}: ${e.message}`, 5000); } }
  await load(); await loadClientDocs(); renderReports(); if (n) C.toast(`${n} document${n > 1 ? 's' : ''} added`);
}
async function uploadTemplate(files) {
  const f = files?.[0]; if (!f) return; C.toast('Reading template…');
  try { await C.api('/api/reports/templates', { method: 'POST', raw: f, headers: { 'content-type': 'application/octet-stream', 'x-filename': encodeURIComponent(f.name), 'x-client': S.client } }); await load(); renderReports(); C.toast('Template added'); }
  catch (e) { C.toast(e.message, 5000); }
}

/* ---------- final reports: edited by the editor, filed per client · channel · report type, kept on this server ---------- */
async function loadFinals() { const cid = S.client || ''; S.finalsFor = cid; try { S.finals = await C.api(`/api/reports/finals?client=${cid}`); } catch (e) { S.finals = []; C.toast(e.message, 5000); } if (S.tab === 'finals') renderReports(); }
function finalsView() {
  if (S.finals == null || S.finalsFor !== (S.client || '')) { S.finals = S.finals || []; loadFinals(); }
  const c = curClient(); const fch = S.finCh || '', ft = S.finT || '';
  const src = S.finQ ? (S.finHits || []) : (S.finals || []); const list = src.filter(f => (!fch || f.channel === fch) && (!ft || f.reportType === ft));
  const count = t => (S.finals || []).filter(f => (!fch || f.channel === fch) && f.reportType === t).length;
  const row = f => `<div class="rp-final"><div style="flex:1;min-width:220px"><b>${esc(f.title)}</b> <span class="badge">${esc(chanLabel(f.channel))} · ${esc(typeLabel(f.reportType))}${f.period ? ' · ' + esc(f.period) : ''}</span> ${f.learn ? `<span class="badge gold" title="Canopus learns from it when making this client's next ${esc(typeLabel(f.reportType))} report">${ic('sparkle')}Learning</span>` : `<span class="badge" title="Never sent to AI; searchable and downloadable on this server only">${ic('lock')}Server only</span>`}
      <div class="muted">${c ? '' : esc(clientName(f.clientId) || 'No client') + ' · '}${esc(f.filename)}${f.slides ? ` · ${f.slides} slides` : ''} · filed by ${esc(f.by || '—')} ${C.ago(f.created)}${f.deckId ? ' · from a Canopus draft (the editor’s changes are learned)' : ''}</div>${f.note ? `<div class="muted">Editor's note: ${esc(f.note)}</div>` : ''}${f.snippet ? `<div class="muted" style="font-style:italic">…${esc(f.snippet)}…</div>` : ''}</div>
    <div style="display:flex;gap:6px;align-items:center"><a class="btn sm" href="/api/reports/finals/${f.id}/file">${ic('download')}Download</a>${f.canManage ? `<button class="icon-btn" data-r="editfinal" data-x="${f.id}" title="Edit">${ic('edit')}</button><button class="icon-btn" data-r="delfinal" data-x="${f.id}" title="Delete">${ic('trash')}</button>` : ''}</div></div>`;
  const groups = (S.meta.types || []).map(t => [t, list.filter(f => f.reportType === t.id)]).filter(([, l]) => l.length);
  body(`<div class="set-sec"><div style="display:flex;gap:16px;align-items:center;flex-wrap:wrap"><div style="flex:1;min-width:260px"><h3>${ic('archive')}Final reports${c ? ` — ${esc(c.name)}` : ''}</h3>
      <p class="help" style="margin:0">Reports as the editor approved and sent them, filed by client, channel and report type. Files stay on this server and are not part of chat answers. When someone makes this client's next report of the same type and channel, Canopus learns from the latest finals: structure, slide titles, phrasing and what the editor corrected — only titles and short masked excerpts go into that request. Mark a final <b>Server only</b> to keep it out of AI requests entirely.</p></div>
      ${c ? `<button class="cta" data-r="uploadfinal">${ic('upload')}Upload final report</button>` : '<div class="help">Choose a client at the top to file a final report.</div>'}</div></div>
    <div class="set-sec"><div class="seg" style="margin-bottom:8px"><button type="button" data-r="finch" data-x="" class="${!fch ? 'on' : ''}">All channels</button>${(S.meta.channels || []).map(ch => `<button type="button" data-r="finch" data-x="${ch.id}" class="${fch === ch.id ? 'on' : ''}">${esc(ch.label)}</button>`).join('')}</div>
      <div class="seg rp-types" style="margin-bottom:10px"><button type="button" data-r="fint" data-x="" class="${!ft ? 'on' : ''}">All types</button>${(S.meta.types || []).map(t => `<button type="button" data-r="fint" data-x="${t.id}" class="${ft === t.id ? 'on' : ''}">${esc(t.short)}${count(t.id) ? ` · ${count(t.id)}` : ''}</button>`).join('')}</div>
      ${c ? `<div style="display:flex;gap:8px;margin-bottom:12px"><input type="text" id="rpFinQ" value="${esc(S.finQ || '')}" placeholder="Search the text of ${esc(c.name)}'s finals (on this server, no AI)" style="flex:1"><button class="btn sm" data-r="finsearch">${ic('search')}Search</button>${S.finQ ? '<button class="btn sm" data-r="finclear">Clear</button>' : ''}</div>` : ''}
      ${groups.length ? groups.map(([t, l]) => `<h4 style="margin:14px 0 6px">${esc(t.label)} <span class="muted">(${l.length})</span></h4>${l.map(row).join('')}`).join('') : `<p class="help">${S.finQ ? 'Nothing matches.' : 'No final reports here yet.'}</p>`}</div>`);
}
function finalModal(f, preset = {}) {
  const v = f || preset; const types = S.meta.types || [], chans = S.meta.channels || [];
  C.openModal(`<h3>${f ? 'Edit final report' : 'File a final report'}</h3><p class="s">The version the editor approved and sent to the client. It is stored on this server.</p>
    ${f ? '' : `<label for="fnClient">Client</label><select id="fnClient" class="vsel" style="width:100%">${S.clients.map(c => `<option value="${c.id}" ${c.id === (v.clientId || S.client) ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}</select>
    <label for="fnFile">File (PowerPoint, PDF or Word)</label><input type="file" id="fnFile" accept=".pptx,.pdf,.docx">`}
    <label for="fnTitle">Title</label><input type="text" id="fnTitle" value="${esc(v.title || '')}" placeholder="e.g. Weekly Report Media Massa — Minggu 2 November">
    <div class="row2"><div><label for="fnChan">Channel</label><select id="fnChan" class="vsel" style="width:100%">${chans.map(c => `<option value="${c.id}" ${c.id === (v.channel || 'medmas') ? 'selected' : ''}>${esc(c.label)}</option>`).join('')}</select></div>
      <div><label for="fnType">Report type</label><select id="fnType" class="vsel" style="width:100%">${types.map(t => `<option value="${t.id}" ${t.id === (v.reportType || 'weekly') ? 'selected' : ''}>${esc(t.label)}</option>`).join('')}</select></div></div>
    <label for="fnPeriod">Period</label><input type="text" id="fnPeriod" value="${esc(v.period || '')}" placeholder="e.g. 8–14 November 2026">
    <label for="fnNote">Editor's note (optional)</label><textarea id="fnNote" rows="2" placeholder="What the editor changed or wants next time, e.g. “judul slide berupa topik, bukan kesimpulan”">${esc(v.note || '')}</textarea>
    <label style="display:flex;gap:8px;align-items:flex-start;margin-top:10px"><input type="checkbox" id="fnLearn" ${v.learn === false ? '' : 'checked'}> <span>Canopus learns from it for this client's next reports of this type<br><span class="help">Unchecked = <b>Server only</b>: never sent to AI, only searchable and downloadable here.</span></span></label>
    <div class="dlg-actions"><button class="btn" data-dlg="cancel">Cancel</button><button class="btn primary" data-r="savefinal" data-x="${f ? f.id : ''}" data-deck="${preset.deckId || ''}">${f ? 'Save' : ic('upload') + 'File it'}</button></div>`);
}

/* ================= events ================= */
async function onClick(e) {
  const t = e.target.closest('[data-r]'); if (!t) return; e.preventDefault();
  const r = t.dataset.r, x = t.dataset.x, x_ = x;
  try {
    switch (r) {
      case 'tab': S.tab = x; if (x === 'decks') S.deck = null; renderReports(); break;
      case 'uploadfinal': finalModal(null, { clientId: S.client }); break;
      case 'filefinal': { const k = S.deck; if (!S.clients.length) { C.toast('Create a client first.'); break; } finalModal(null, { clientId: k.clientId || S.client, title: k.title, period: k.period, channel: k.channel, reportType: k.reportType || 'adhoc', deckId: k.id }); break; }
      case 'editfinal': finalModal((S.finals || []).find(f => f.id === x) || (S.finHits || []).find(f => f.id === x)); break;
      case 'savefinal': {
        const meta = { title: $('#fnTitle').value.trim(), period: $('#fnPeriod').value.trim(), channel: $('#fnChan').value, reportType: $('#fnType').value, note: $('#fnNote').value.trim(), learn: $('#fnLearn').checked };
        if (x) await C.api('/api/reports/finals/' + x, { method: 'PATCH', body: meta });
        else { const f = $('#fnFile').files?.[0]; if (!f) { C.toast('Choose the file first.'); break; } C.toast('Reading ' + f.name + '…', 6000); const e_ = v => encodeURIComponent(v || '');
          await C.api('/api/reports/finals', { method: 'POST', raw: f, headers: { 'content-type': 'application/octet-stream', 'x-filename': e_(f.name), 'x-client': e_($('#fnClient').value), 'x-type': e_(meta.reportType), 'x-channel': e_(meta.channel), 'x-period': e_(meta.period), 'x-title': e_(meta.title), 'x-note': e_(meta.note), 'x-learn': meta.learn ? '1' : '0', 'x-deck': e_(t.dataset.deck) } }); }
        C.closeModal(); S.finals = null; S.structCache = {}; S.finQ = ''; renderReports(); C.toast(x ? 'Saved' : 'Final report filed'); break; }
      case 'delfinal': if (await C.confirmBox('Delete this final report?', 'The file is removed from this server and Canopus stops learning from it.')) { await C.api('/api/reports/finals/' + x, { method: 'DELETE' }); S.finals = null; S.structCache = {}; renderReports(); } break;
      case 'finch': S.finCh = x; renderReports(); break;
      case 'fint': S.finT = x; renderReports(); break;
      case 'finsearch': { S.finQ = $('#rpFinQ').value.trim(); S.finHits = S.finQ ? await C.api(`/api/reports/finals?client=${S.client}&q=${encodeURIComponent(S.finQ)}`) : []; renderReports(); break; }
      case 'finclear': S.finQ = ''; renderReports(); break;
      case 'pickds': $('#rpDsFile').click(); break;
      case 'pickdoc': $('#rpDocFile').click(); break;
      case 'structpreset': { const el = document.getElementById('cp_structure'); if (el) { el.value = el.value.trim() ? el.value : STRUCTURE_PRESET; el.rows = 10; el.focus(); } break; }
      case 'picklogo': $('#rpLogoFile').click(); break;
      case 'dellogo': await C.api(`/api/reports/clients/${S.client}/logos/${x}`, { method: 'DELETE' }); delete S.styleCache[S.client]; await load(); renderReports(); break;
      case 'pickshots': captureForm(); $('#rpShotFile').click(); break;
      case 'ctype': S.ctype = x; renderReports(); break;
      case 'cchan': S.cchan = x; renderReports(); break;
      case 'savestruct': await C.api(`/api/reports/clients/${S.client}/structures`, { method: 'PUT', body: { type: S.ctype || 'weekly', channel: S.cchan || 'medmas', text: $('#rpStruct').value } }); S.structCache = {}; await load(); renderReports(); C.toast('Structure saved'); break;
      case 'usedefstruct': { const el = $('#rpStruct'); const d = await C.api(`/api/reports/structure?type=${S.ctype || 'weekly'}&channel=${S.cchan || 'medmas'}`); el.value = d.text || ''; el.focus(); break; }
      case 'rtype': captureForm(); S.form.type = x; renderReports(); break;
      case 'rchan': captureForm(); S.form.channel = x; renderReports(); break;
      case 'pickcovers': captureForm(); $('#rpCoverFile').click(); break;
      case 'rmcover': captureForm(); S.covers = (S.covers || []).filter(y => y.id !== x_); renderReports(); break;
      case 'covmode': captureForm(); S.form.coverMode = x; if (x === 'pick' && !S.form.coverPick) S.form.coverPick = S.covers?.[0]?.id; renderReports(); break;
      case 'deckcover': { const c = S.deck.outline.cover || {}; const body = { outline: S.deck.outline, cover: { candidates: c.candidates || [], mode: x === 'auto' ? 'auto' : 'pick', image: x === 'auto' ? null : x, layout: $('#rpDCovLayout')?.value || c.layout || 'auto' } };
        S.deck = await C.api('/api/reports/decks/' + S.deck.id, { method: 'PUT', body }); renderReports(); C.toast('Cover updated'); break; }
      case 'rmshot': captureForm(); S.shots = (S.shots || []).filter(x => x.id !== x_); renderReports(); break;
      case 'pickstyle': captureForm(); S.form.style = x; renderReports(); break;
      case 'clientstyle': { const st = x === 'template' ? null : stylesOf(S.client).styles.find(y => y.id === x); await C.api(`/api/reports/clients/${S.client}/style`, { method: 'PUT', body: { style: st } }); await load(); renderReports(); C.toast(st ? `${st.name} is now ${curClient().name}'s default style` : 'Default style cleared'); break; }
      case 'deckstyle': { const st = x === 'template' ? null : stylesOf(S.deck.clientId).styles.find(y => y.id === x) || null; S.deck.style = st; S.deck.dirty = true; await C.api('/api/reports/decks/' + S.deck.id, { method: 'PUT', body: { style: st, outline: S.deck.outline } }); renderReports(); C.toast(st ? `Style: ${st.name}` : "Using the template's colours"); break; }
      case 'deckshot': $('#rpDeckShot').click(); break;
      case 'addfile': $('#rpDsMore').click(); break;
      case 'saveissues': { const c = S.clients.find(k => k.id === (S.ds.clientId || S.client)); if (!c) { C.toast('Choose a client first'); break; }
        const labels = JSON.parse(t.dataset.labels || '[]'); const cur = (c.persona?.issues || '').split(/[\n;]+/).map(x => x.trim()).filter(Boolean); const merged = [...new Set([...cur, ...labels])];
        await C.api('/api/reports/clients/' + c.id, { method: 'PUT', body: { name: c.name, description: c.description, instructions: c.instructions, persona: { ...(c.persona || {}), issues: merged.join('\n') } } });
        await load(); C.toast(`${merged.length - cur.length} new issue${merged.length - cur.length === 1 ? '' : 's'} saved to ${c.name}'s reference list`); break; }
      case 'newclient': clientModal(null); break;
      case 'editclient': clientModal(curClient()); break;
      case 'openclient': S.client = x; savePrefs({ client: x }); S.clientDocs = null; renderReports(); break;
      case 'saveclient': { const body = { name: $('#clName').value.trim(), description: $('#clDesc').value.trim(), instructions: $('#clInstr').value.trim(), persona: C.readPersona('cp', C.me().personaFields.client) };
        if (x) await C.api('/api/reports/clients/' + x, { method: 'PUT', body }); else { const r = await C.api('/api/reports/clients', { method: 'POST', body }); S.client = r.id; savePrefs({ client: r.id }); S.clientDocs = null; S.tab = 'clients'; }
        C.closeModal(); await load(); renderReports(); C.toast('Saved'); break; }
      case 'delclient': if (await C.confirmBox('Delete client?', 'Its recipes are deleted. Templates, datasets, presentations and documents are kept, without a client.')) { await C.api('/api/reports/clients/' + S.client, { method: 'DELETE' }); S.client = ''; savePrefs({ client: '' }); await load(); renderReports(); } break;
      case 'loadrecipe': { const rc = await C.api('/api/reports/recipes/' + $('#rpRecipe').value); S.plan = rc.plan; S.explanation = `Loaded recipe “${rc.name}”. Check the steps, then run the plan.`; S.ds.log = null; renderReports(); break; }
      case 'saverecipe': { const cid = S.ds.clientId || S.client; if (!cid) { C.toast('Choose a client at the top first'); break; } const n = await C.ask('Save plan as recipe', { value: S.plan.title || S.ds.name, sub: `Saved for ${clientName(cid)}. Load it on next month's file to run the same steps without AI planning.` });
        if (n && n.trim()) { const sh = S.ds.sheets.find(z => z.name === S.ds.sheet) || S.ds.sheets[0]; await C.api(`/api/reports/clients/${cid}/recipes`, { method: 'POST', body: { name: n.trim(), plan: S.plan, columns: sh.columns } }); await load(); renderReports(); C.toast('Recipe saved'); } break; }
      case 'delrecipe': if (await C.confirmBox('Delete recipe?', 'Datasets that used it are not affected.')) { await C.api('/api/reports/recipes/' + x, { method: 'DELETE' }); await load(); renderReports(); } break;
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
        try { const res = await C.api(`/api/reports/datasets/${S.ds.id}/plan`, { method: 'POST', body: { instruction, model: $('#rpModel')?.value, sheet: S.ds.sheet, reportType: (S.curType = $('#rpCurType')?.value), channel: (S.curChan = $('#rpCurChan')?.value) } }); S.plan = res.plan; S.explanation = res.explanation; S.ds.instruction = instruction; S.ds.log = null; }
        finally { S.busy = ''; renderReports(); } break; }
      case 'run': {
        if (S.plan.steps.some(st => st.op === 'ai_tag')) { // large files: show what AI labelling will cost before starting
          const est = await C.api(`/api/reports/datasets/${S.ds.id}/estimate`, { method: 'POST', body: { plan: S.plan, sheet: S.ds.sheet } });
          if (est.aiRows > 1500 && !(await C.confirmBox(`Label ${est.aiRows.toLocaleString('id-ID')} unique texts with AI?`, `Estimated cost about $${est.usd} (≈ Rp${Math.round(est.usd * 16500).toLocaleString('id-ID')}) with ${est.model}, roughly ${est.minutes} minute${est.minutes > 1 ? 's' : ''}. Texts labelled before are reused for free. You can leave this page while it runs.`, 'Start'))) break;
        }
        const did = S.ds.id; S.busy = 'run'; S.job = await C.api(`/api/reports/datasets/${did}/run`, { method: 'POST', body: { plan: S.plan, sheet: S.ds.sheet } }); renderReports(); pollJob(did); break; }
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
        document.querySelectorAll('[data-shot]').forEach(el => { const sh = (S.shots || []).find(x => x.id === el.dataset.shot); if (sh) sh.label = el.value.trim(); });
        captureForm(); const styleSel = S.form?.style ?? (curClient()?.style?.id || stylesOf(S.client).styles.find(x => x.recommended)?.id || 'template'); const styleObj = stylesOf(S.client).styles.find(x => x.id === styleSel) || null;
        const covers = (S.covers || []).map(x => x.id); const payload = { learnFinals: S.form?.learn !== false, channel: S.form?.channel || 'medmas', reference: S.form?.reference || null, useReferenceDesign: S.form?.refDesign !== false, reportType: S.form?.type || 'weekly', period: S.form?.period || '', cover: covers.length ? { candidates: covers, mode: S.form?.coverMode === 'pick' ? 'pick' : 'auto', image: S.form?.coverPick || null, layout: S.form?.coverLayout || 'auto' } : null, style: styleObj, images: (S.shots || []).map(x => ({ id: x.id, label: x.label })), client: S.client || null, title: $('#rpTitle').value.trim(), template: $('#rpTpl').value, datasets, brief, model: $('#rpDModel')?.value, finalizeModel: $('#rpFModel')?.value, knowledge: $('#rpKnow').checked }; savePrefs({ analysis: payload.model, finalize: payload.finalizeModel });
        S.busy = 'deck'; renderReports();
        try { const k = await C.api('/api/reports/decks', { method: 'POST', body: payload }); S.busy = ''; S.shots = []; S.covers = []; S.form = null; await load(); await openDeck(k.id); C.refreshMe?.(); }
        finally { S.busy = ''; if (!S.deck) renderReports(); } break; }
      case 'opendeck': await openDeck(x); break;
      case 'refinal': { const fm = $('#rpReFModel').value; savePrefs({ finalize: fm }); await saveDeck(true); S.busy = 'final'; renderReports();
        try { S.deck = await C.api(`/api/reports/decks/${S.deck.id}/finalize`, { method: 'POST', body: { finalizeModel: fm } }); C.toast('Finalized by ' + (S.deck.finalizer?.label || 'AI')); C.refreshMe?.(); }
        finally { S.busy = ''; renderReports(); } break; }
      case 'backdeck': if (S.deck?.dirty) await saveDeck(true); S.deck = null; await load(); renderReports(); break;
      case 'savedeck': await saveDeck(); renderReports(); break;
      case 'pptx': if (S.deck && S.deck.id === x) await saveDeck(true); await download(`/api/reports/decks/${x}/pptx`); break;
      case 'deldeck': if (await C.confirmBox('Delete presentation?', 'The outline is removed. Files you downloaded are not affected.')) { await C.api('/api/reports/decks/' + S.deck.id, { method: 'DELETE' }); S.deck = null; await load(); renderReports(); } break;
      case 'sup': case 'sdown': { const s = S.deck.outline.slides; const i = +x, j = r === 'sup' ? i - 1 : i + 1; if (j >= 0 && j < s.length) { [s[i], s[j]] = [s[j], s[i]]; S.deck.dirty = true; renderReports(); } break; }
      case 'sdel': S.deck.outline.slides.splice(+x, 1); S.deck.dirty = true; renderReports(); break;
      case 'sadd': { const s = structuredClone(NEW_SLIDE[x]); if (s.source !== undefined) s.source = s.kind === 'news' ? (S.sources.find(v => v.main)?.ref || '') : S.sources.find(v => !v.main)?.ref || S.sources[0]?.ref || ''; S.deck.outline.slides.push(s); S.deck.dirty = true; renderReports(); setTimeout(() => document.querySelector('.rp-slide:last-child')?.scrollIntoView({ behavior: 'smooth' }), 30); break; }
      case 'tpldl': await download(`/api/reports/templates/${x}/file`); break;
      case 'tpldel': if (await C.confirmBox('Delete template?', 'Presentations that use it will fall back to a plain layout until you choose another template.')) { await C.api('/api/reports/templates/' + x, { method: 'DELETE' }); await load(); renderReports(); } break;
    }
  } catch (err) { C.toast(err.message, 5000); }
}
function describeLocal(st) { return `${S.meta.ops?.[st.op] || st.op}${st.column ? `: ${st.column}` : st.columns?.length ? `: ${st.columns.join(', ')}` : st.name ? `: ${st.name}` : ''}`; }
