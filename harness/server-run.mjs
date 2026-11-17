// End-to-end harness for the Canopus SERVER edition (../server).
//
//   node server-run.mjs              # simulated Claude API (no key, no cost)
//   ANTHROPIC_API_KEY=... node server-run.mjs --live    # real Claude API
//
// It starts a throwaway Canopus server with its own empty database, drives it in headless Chromium as an
// administrator and as a normal user, and checks security properties along the way. All traffic to the
// Claude API passes through a local recorder, so the harness can prove that sensitive values never leave.

import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVER_DIR = path.resolve(HERE, '..', 'server');
const args = Object.fromEntries(process.argv.slice(2).map(a => { const [k, v] = a.replace(/^--/, '').split('='); return [k, v ?? true]; }));
const LIVE = !!args.live;
const TIMEOUT = LIVE ? 240000 : 30000;

// Values that must never reach the AI service (they are in the test documents).
const SECRETS = { nik: '3174012345678901', email: 'budi.santoso@example.go.id', term: 'Proyek Garuda',
  patient: 'Siti Aminah', rm: 'RM-778899', diagnosis: 'Demam Berdarah Dengue', local: 'LOCAL-SECRET-42' };

/* ---------------- Claude API: simulator (default) or recording forwarder (--live) ---------------- */
const recorded = [];
const sse = evs => evs.map(e => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join('');
function lastUser(body) { return [...body.messages].reverse().find(m => m.role === 'user'); }
function userText(m) { return typeof m.content === 'string' ? m.content : m.content.filter(b => b.type === 'text').map(b => b.text).join('\n'); }
function simulate(body) {
  const lu = lastUser(body); const toolResults = Array.isArray(lu.content) ? lu.content.filter(b => b.type === 'tool_result') : [];
  const q = userText([...body.messages].reverse().find(m => m.role === 'user' && userText(m)) || lu);
  const hasTool = (body.tools || []).some(t => t.name === 'search_knowledge');
  const head = [{ type: 'message_start', message: { id: 'msg_sim', type: 'message', role: 'assistant', model: body.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 800, output_tokens: 1, cache_read_input_tokens: 400 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '', signature: '' } }, { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'Considering the question.' } }, { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'sig' } }, { type: 'content_block_stop', index: 0 }];
  const end = (reason, out = 60) => [{ type: 'message_delta', delta: { stop_reason: reason, stop_sequence: null }, usage: { output_tokens: out } }, { type: 'message_stop' }];
  const text = (t, cites = []) => { const ev = [{ type: 'content_block_start', index: 1, content_block: { type: 'text', text: '', citations: cites.length ? [] : null } }];
    for (const c of t.match(/[\s\S]{1,30}/g)) ev.push({ type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: c } });
    for (const c of cites) ev.push({ type: 'content_block_delta', index: 1, delta: { type: 'citations_delta', citation: c } });
    ev.push({ type: 'content_block_stop', index: 1 }); return ev; };
  // 1) knowledge question and no search yet → call the tool
  if (hasTool && !toolResults.length && /anggaran|koordinator|marker|dokumen|NIK|pasien|kunjungan|rekam/i.test(q)) {
    const query = q.replace(/[?.,]/g, ' ').slice(0, 80);
    return sse([...head, { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'toolu_' + recorded.length, name: 'search_knowledge', input: {} } },
      { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: JSON.stringify({ query }) } }, { type: 'content_block_stop', index: 1 }, ...end('tool_use')]);
  }
  // 2) answer from tool results, quoting the first passage (masked values pass through as placeholders)
  if (toolResults.length) {
    const results = toolResults.flatMap(r => Array.isArray(r.content) ? r.content : []).filter(c => c.type === 'search_result');
    if (!results.length) return sse([...head, ...text('Informasi tersebut tidak ditemukan di dokumen internal yang dapat Anda akses.'), ...end('end_turn')]);
    const r = results[0]; const passage = r.content[0].text;
    const answer = `Menurut dokumen internal: ${passage.split('\n').slice(0, 3).join(' ')}` + (/PELANGI/.test(JSON.stringify(body.system)) ? ' PELANGI' : '');
    return sse([...head, ...text(answer, [{ type: 'search_result_location', source: r.source, title: r.title, cited_text: passage, search_result_index: 0, start_block_index: 0, end_block_index: 1 }]), ...end('end_turn')]);
  }
  if (/HTML page/i.test(q)) return sse([...head, ...text('Here it is.\n\n```html\n<!doctype html><html><head><title>Harness Canvas</title></head><body><h1>Hello Canopus</h1></body></html>\n```\n\nDone.'), ...end('end_turn')]);
  const ex = q.match(/Reply with exactly:\s*(\S+)/i);
  return sse([...head, ...text((ex ? ex[1] : 'Halo! Ada yang bisa saya bantu?') + (/PELANGI/.test(JSON.stringify(body.system)) ? ' PELANGI' : '')), ...end('end_turn')]);
}
function classifyMock(q) {
  if (/anggaran|koordinator|pasien|dokumen|marker|NIK|kunjungan|rekam|⟦/i.test(q)) return 'knowledge';
  if (/ringkas|surat|memo|tulis|draf/i.test(q)) return 'writing';
  if (/analisis|bandingkan|strategi/i.test(q)) return 'analysis';
  return 'light';
}
// OpenAI-compatible simulator, used for both "OpenAI" and the on-premise model.
function handleOA(req, res, raw, kind) {
  if (req.url.endsWith('/models')) { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ data: [{ id: 'gpt-sim' }, { id: 'gpt-sim-mini' }] })); }
  const body = JSON.parse(raw || '{}'); const msgs = body.messages || [];
  const sys = msgs.find(m => m.role === 'system')?.content || '';
  const lu = [...msgs].reverse().find(m => m.role === 'user'); const q = typeof lu?.content === 'string' ? lu.content : (lu?.content || []).filter(p => p.type === 'text').map(p => p.text).join('\n');
  if (!body.stream) { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: /Classify the user/.test(sys) ? classifyMock(q) : 'Harness Chat' } }], usage: { prompt_tokens: 40, completion_tokens: 3 } })); }
  const tools = msgs.filter(m => m.role === 'tool'); const lastIsTool = msgs.at(-1)?.role === 'tool';
  const chunks = []; const say = t => { for (const c of t.match(/[\s\S]{1,25}/g)) chunks.push({ choices: [{ index: 0, delta: { content: c }, finish_reason: null }] }); };
  if (body.tools && !lastIsTool && /anggaran|koordinator|marker|dokumen|NIK|pasien|kunjungan|rekam|catatan/i.test(q)) {
    chunks.push({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_' + recorded.length, type: 'function', function: { name: 'search_knowledge', arguments: '' } }] }, finish_reason: null }] });
    chunks.push({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: JSON.stringify({ query: q.replace(/[?.,]/g, ' ').slice(0, 80) }) } }] }, finish_reason: null }] });
    chunks.push({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] });
  } else if (lastIsTool) {
    const res1 = tools.at(-1).content; const m = res1.match(/^\[1\][^\n]*\n([^\n]+(?:\n[^\n\[]+){0,2})/);
    say(m ? `Menurut dokumen internal: ${m[1].replace(/\n/g, ' ')} [1]` : 'Informasi tersebut tidak ditemukan di dokumen internal.');
    chunks.push({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
  } else { const ex = q.match(/Reply with exactly:\s*(\S+)/i); say((ex ? ex[1] : `Halo dari ${kind === 'local' ? 'model lokal' : 'GPT'}!`) + (/PELANGI/.test(sys) ? ' PELANGI' : '')); chunks.push({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }); }
  chunks.push({ choices: [], usage: { prompt_tokens: 700, completion_tokens: 60, prompt_tokens_details: { cached_tokens: 200 } } });
  res.writeHead(200, { 'content-type': 'text/event-stream' }); res.end(chunks.map(c => `data: ${JSON.stringify(c)}\n\n`).join('') + 'data: [DONE]\n\n');
}
async function startClaudeEndpoint() {
  const srv = http.createServer(async (req, res) => {
    const chunks = []; for await (const c of req) chunks.push(c); const raw = Buffer.concat(chunks).toString('utf8');
    const kind = req.url.startsWith('/local/') ? 'local' : req.url.startsWith('/oa/') ? 'openai' : 'anthropic';
    recorded.push({ path: req.url, raw, kind });
    if (kind !== 'anthropic') return handleOA(req, res, raw, kind);
    if (LIVE) { // forward to the real API, unchanged
      const headers = Object.fromEntries(Object.entries(req.headers).filter(([k]) => !['host', 'content-length', 'connection'].includes(k)));
      const r = await fetch('https://api.anthropic.com' + req.url, { method: req.method, headers, body: raw || undefined });
      res.writeHead(r.status, Object.fromEntries([...r.headers].filter(([k]) => !['content-encoding', 'content-length', 'transfer-encoding'].includes(k))));
      for await (const c of r.body) res.write(c); return res.end();
    }
    const body = JSON.parse(raw || '{}');
    const sys = JSON.stringify(body.system || '');
    if (!body.stream) { const reply = /Classify the user/.test(sys) ? classifyMock(userText(lastUser(body))) : 'Harness Chat';
      res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ id: 'm', type: 'message', role: 'assistant', model: body.model, content: [{ type: 'text', text: reply }], stop_reason: 'end_turn', usage: { input_tokens: 50, output_tokens: 5 } })); }
    if (/SIMULATE-OUTAGE/.test(JSON.stringify(body.messages))) { res.writeHead(529, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } })); }
    res.writeHead(200, { 'content-type': 'text/event-stream' }); res.end(simulate(body));
  });
  await new Promise(r => srv.listen(0, '127.0.0.1', r)); return srv;
}

/* ---------------- fixtures ---------------- */
function pdf(lines) {
  const content = 'BT /F1 18 Tf 72 720 Td 24 TL ' + lines.map(l => `(${l.replace(/[()\\]/g, '\\$&')}) Tj T*`).join(' ') + ' ET';
  const objs = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>', '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>', `<< /Length ${content.length} >>\nstream\n${content}\nendstream`, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'];
  let out = '%PDF-1.4\n'; const offs = []; objs.forEach((o, i) => { offs.push(out.length); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const x = out.length; out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n` + offs.map(o => String(o).padStart(10, '0') + ' 00000 n \n').join('');
  return Buffer.from(out + `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${x}\n%%EOF\n`, 'latin1');
}
const FIX = fs.mkdtempSync(path.join(os.tmpdir(), 'canopus-fix-'));
const F = { mbg: path.join(FIX, 'program-mbg-2026.txt'), polhukam: path.join(FIX, 'catatan-polhukam.pdf'), secret: path.join(FIX, 'nota-rahasia.txt'),
  patients: path.join(FIX, 'data-pasien-poli.csv'), local: path.join(FIX, 'catatan-klinis.txt') };
fs.writeFileSync(F.patients, `No RM,Nama Pasien,NIK,Alamat,Poli,Kunjungan Terakhir,Diagnosa\n${SECRETS.rm},${SECRETS.patient},3171015505800002,Jl. Melati 5 Jakarta,Penyakit Dalam,2026-11-10,${SECRETS.diagnosis}\nRM-778900,Joko Prasetyo,3171011203750001,Jl. Kenanga 9 Bogor,Anak,2026-11-12,Bronkitis Akut\n`);
fs.writeFileSync(F.local, `Catatan klinis rekam medis (hanya on-premise).\n\nMarker verifikasi rekam medis: ${SECRETS.local}. Pasien kontrol ulang setiap dua minggu.\n`);
fs.writeFileSync(F.mbg, `Program Makan Bergizi Gratis (MBG) 2026\n\nAnggaran program tahun 2026 adalah Rp71 triliun dan menjangkau 82,9 juta penerima manfaat di seluruh provinsi.\n\nKoordinator pelaksana: Budi Santoso, NIK ${SECRETS.nik}, email ${SECRETS.email}. Kegiatan ini terkait ${SECRETS.term} tahap kedua.\n`);
fs.writeFileSync(F.polhukam, pdf(['Catatan Polhukam (terbatas)', 'Verification marker dokumen ini adalah ORION-77.', 'Hanya untuk kelompok Polhukam.']));
fs.writeFileSync(F.secret, 'Isi dokumen rahasia. Tidak boleh disimpan.');

/* ---------------- start Canopus server ---------------- */
async function startCanopus(claudeUrl) {
  const port = 20000 + Math.floor(Math.random() * 20000);
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'canopus-data-'));
  const env = { ...process.env, PORT: String(port), HOST: '127.0.0.1', PUBLIC_URL: `http://127.0.0.1:${port}`, DATA_DIR: dataDir, CANOPUS_ADMIN_EMAIL: 'admin@kantor.go.id',
    ANTHROPIC_API_KEY: LIVE ? (process.env.ANTHROPIC_API_KEY || 'proxy-injected') : 'sk-ant-simulated', CANOPUS_ANTHROPIC_BASE_URL: claudeUrl,
    OPENAI_API_KEY: LIVE ? (process.env.OPENAI_API_KEY || '') : 'sk-openai-simulated', CANOPUS_OPENAI_BASE_URL: LIVE ? (process.env.CANOPUS_OPENAI_BASE_URL || claudeUrl + '/oa/v1') : claudeUrl + '/oa/v1', CANOPUS_LOCAL_BASE_URL: claudeUrl + '/local/v1' };
  const proc = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'src/server.mjs'], { cwd: SERVER_DIR, env });
  let log = ''; proc.stdout.on('data', d => log += d); proc.stderr.on('data', d => log += d);
  for (let i = 0; i < 100 && !/running on/.test(log); i++) await new Promise(r => setTimeout(r, 100));
  const invite = log.match(/(http:\/\/\S+#invite=\S+)/)?.[1];
  if (!invite) { console.error(log); throw new Error('Server did not start'); }
  return { proc, port, url: `http://127.0.0.1:${port}/`, invite, dataDir, log: () => log };
}

/* ---------------- helpers ---------------- */
const results = []; let OUT;
async function step(page, name, title, fn, { soft } = {}) {
  const t0 = Date.now(); let r;
  try { r = await fn(); } catch (e) { r = { pass: false, detail: 'Exception: ' + e.message.split('\n')[0] }; }
  const status = r.pass ? 'pass' : soft ? 'warn' : 'fail';
  const shot = `server-${name}.png`; if (page) await page.screenshot({ path: path.join(OUT, shot) }).catch(() => {});
  results.push({ name, title, status, detail: String(r.detail ?? '').replace(/\s+/g, ' ').slice(0, 300), ms: Date.now() - t0 });
  console.log(`${{ pass: '✔', fail: '✘', warn: '!' }[status]} ${title} (${((Date.now() - t0) / 1000).toFixed(1)}s)${status !== 'pass' ? ' — ' + r.detail : ''}`);
}
const ok = (c, detail) => ({ pass: !!c, detail });
async function waitIdle(p) { await p.waitForFunction(() => window.__canopus?.busy(), null, { timeout: 5000 }).catch(() => {}); await p.waitForFunction(() => !window.__canopus.busy(), null, { timeout: TIMEOUT }); await p.waitForTimeout(300); }
async function ask(p, text) {
  await p.click('[data-act=new]'); await p.waitForTimeout(150);
  await p.fill('#input', text); await p.keyboard.press('Enter'); await waitIdle(p);
  return lastBot(p);
}
const lastBot = p => p.evaluate(() => { const s = window.__canopus.state; const c = s.chats.find(x => x.id === s.current); const m = [...c.msgs].reverse().find(x => x.r === 'assistant'); return { text: m.display || '', error: m.error || null, cites: m.citations || [], found: m.found || [], model: m.modelName, provider: m.provider, route: m.route || null }; });
async function follow(p, text) { await p.fill('#input', text); await p.keyboard.press('Enter'); await waitIdle(p); return lastBot(p); }
const setModel = (p, id) => p.evaluate(id => { window.__canopus.state.model = id; }, id);
const putJson = (p, url, body, method = 'PUT') => apiCall(p, url, { method, headers: { 'content-type': 'application/json', 'x-canopus': '1' }, body: JSON.stringify(body) });
const apiCall = (p, url, opts = {}) => p.evaluate(async ([url, opts]) => { const r = await fetch(url, { ...opts, headers: { ...(opts.headers || {}) } }); return { status: r.status, body: await r.text() }; }, [url, opts]);
const cloud = () => recorded.filter(r => r.kind !== 'local');
const leaks = () => cloud().filter(r => Object.values(SECRETS).some(v => r.raw.includes(v)));

/* ---------------- run ---------------- */
const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
OUT = path.join(HERE, 'report', 'server-' + stamp); fs.mkdirSync(OUT, { recursive: true });
const claudeSrv = await startClaudeEndpoint();
const canopus = await startCanopus(`http://127.0.0.1:${claudeSrv.address().port}`);
const browser = await chromium.launch();
const ctxA = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const ctxB = await browser.newContext({ viewport: { width: 1440, height: 900 } });
for (const c of [ctxA, ctxB]) await c.route(/fonts\.(googleapis|gstatic)\.com|google\.com\/s2/, r => r.abort());
const A = await ctxA.newPage(); const B = await ctxB.newPage();
const pageErrors = []; for (const p of [A, B]) p.on('pageerror', e => pageErrors.push(e.message));
let inviteB = null;

try {
  await step(A, 'onboard', 'Administrator sets a password from the one-time link', async () => {
    await A.goto(canopus.invite); await A.fill('#iName', 'Admin Satu'); await A.fill('#iPw', 'KataSandi2026'); await A.fill('#iPw2', 'KataSandi2026');
    await A.click('#invForm button'); await A.waitForSelector('#app:not([hidden])', { timeout: 10000 });
    const reuse = await apiCall(A, '/api/auth/invite?token=' + canopus.invite.split('invite=')[1]);
    return ok(await A.isVisible('#navAdmin') && reuse.status === 404, `admin nav visible; invite link reusable: ${reuse.status !== 404}`);
  });
  await step(A, 'groups', 'Create groups', async () => {
    await A.goto(canopus.url + '#admin'); await A.click('[data-atab=groups]');
    for (const g of ['Polhukam', 'Ekonomi']) { await A.click('[data-act=addgroup]'); await A.fill('#askIn', g); await A.click('[data-dlg=ok]'); await A.waitForTimeout(300); }
    return ok((await A.locator('#adminBody tbody tr').count()) === 2, 'two groups listed');
  });
  await step(A, 'collections', 'Create collections with access rules and upload documents', async () => {
    await A.click('[data-atab=knowledge]');
    await A.click('[data-act=addcol]'); await A.fill('#cName', 'Program Prioritas'); await A.click('[data-act=savecol]'); await A.waitForTimeout(400);
    await A.click('[data-act=addcol]'); await A.fill('#cName', 'Dokumen Polhukam'); await A.locator('#cGroups label', { hasText: 'Polhukam' }).locator('input').check(); await A.click('[data-act=savecol]'); await A.waitForTimeout(400);
    const up = async (col, file, cls) => { await A.locator('.col-card', { hasText: col }).locator('[data-upcol]').click(); await A.selectOption('#docCls', cls); await A.setInputFiles('#docFiles', file); await A.click('[data-act=douploaddocs]'); await A.waitForFunction(() => /indexed|error|not|refused|may not/i.test(document.querySelector('#upLog')?.textContent || '') && !document.querySelector('[data-act=douploaddocs]')?.disabled, null, { timeout: 20000 }); const t = await A.textContent('#upLog'); await A.keyboard.press('Escape'); await A.waitForTimeout(200); return t; };
    const a = await up('Program Prioritas', F.mbg, 'biasa'); const b = await up('Dokumen Polhukam', F.polhukam, 'terbatas');
    return ok(/indexed/.test(a) && /indexed/.test(b), `${a} | ${b}`);
  });
  await step(A, 'classified', 'A “Rahasia” document is refused and never stored', async () => {
    await A.locator('.col-card', { hasText: 'Program Prioritas' }).locator('[data-upcol]').click(); await A.selectOption('#docCls', 'rahasia'); await A.setInputFiles('#docFiles', F.secret); await A.click('[data-act=douploaddocs]');
    await A.waitForFunction(() => /may not/i.test(document.querySelector('#upLog')?.textContent || ''), null, { timeout: 10000 }); const msg = await A.textContent('#upLog'); await A.keyboard.press('Escape');
    const stored = fs.readdirSync(path.join(canopus.dataDir, 'docs')).map(f => fs.readFileSync(path.join(canopus.dataDir, 'docs', f), 'utf8')).some(t => t.includes('Isi dokumen rahasia'));
    return ok(/may not/.test(msg) && !stored, `${msg} · stored on disk: ${stored}`);
  });
  await step(A, 'settings', 'Add a custom term to mask', async () => {
    await A.click('[data-atab=settings]'); await A.fill('#setTerms', SECRETS.term); await A.fill('#setCols', 'Diagnosa'); await A.click('[data-settoggle=canvas]'); await A.click('[data-act=savesettingsadmin]'); await A.waitForTimeout(600); await A.reload(); await A.waitForSelector('#app:not([hidden])');
    const s = JSON.parse((await apiCall(A, '/api/admin/overview')).body).settings; return ok(s.redaction.enabled && s.redaction.terms.includes(SECRETS.term), JSON.stringify(s.redaction));
  });
  await step(A, 'knowledge-answer', 'Answers from internal knowledge with a citation', async () => {
    await A.goto(canopus.url + '#home'); const r = await ask(A, 'Berapa anggaran Program Makan Bergizi Gratis tahun 2026?');
    const chip = await A.locator('.msg.bot').last().locator('.cite').count();
    return ok(!r.error && /71 triliun/.test(r.text) && r.cites.length > 0 && chip > 0, `${r.error || r.text.slice(0, 140)} · citations: ${r.cites.length}`);
  });
  await step(A, 'unmask', 'Sensitive values are masked for the AI but shown to the user', async () => {
    const r = await ask(A, 'Siapa koordinator program MBG dan berapa NIK-nya?');
    const sentMasked = recorded.some(x => /⟦NIK_1⟧/.test(x.raw));
    return ok(!r.error && r.text.includes(SECRETS.nik) && sentMasked && !leaks().length, `UI shows NIK: ${r.text.includes(SECRETS.nik)} · AI saw placeholder: ${sentMasked} · leaks: ${leaks().length}`);
  });
  await step(A, 'canvas', 'Canvas renders inside the locked sandbox', async () => {
    const r = await ask(A, "Create a simple HTML page titled 'Harness Canvas' with a heading."); await A.waitForTimeout(800);
    const frame = A.frameLocator('#panel iframe'); const h1 = await frame.locator('h1').textContent({ timeout: 5000 }).catch(() => null);
    const sandbox = await A.getAttribute('#panel iframe', 'sandbox');
    return ok(h1 && !/allow-same-origin/.test(sandbox || ''), `heading: ${h1} · sandbox: ${sandbox}`);
  });
  await step(A, 'models', 'Admin adds a GPT model and an on-premise model', async () => {
    await A.goto(canopus.url + '#admin'); await A.click('[data-atab=models]');
    const add = async (sel, api, label, tier) => { await A.click(sel); await A.fill('#oaApi', api); await A.fill('#oaLabel', label); await A.selectOption('#oaTier', tier); if (await A.isVisible('#oaIn')) { await A.fill('#oaIn', '1'); await A.fill('#oaOut', '4'); } await A.click('[data-act=saveoa]'); await A.waitForTimeout(500); };
    await add('[data-editoa=""]:not([data-prov=local])', 'gpt-sim', 'GPT Standard', 'standard');
    await add('[data-editoa=""][data-prov=local]', 'llama-sim', 'Local Llama', 'standard');
    const o = JSON.parse((await apiCall(A, '/api/admin/overview')).body);
    return ok(o.providers.openai && o.providers.local && ['openai:gpt-sim', 'local:llama-sim'].every(id => o.settings.models.includes(id)), `enabled: ${o.settings.models.join(', ')}`);
  });
  await step(A, 'auto-route', 'Auto sends quick tasks to the cheapest model and writing to the standard one', async () => {
    await A.goto(canopus.url + '#home'); await A.reload(); await A.waitForSelector('#app:not([hidden])'); await setModel(A, 'auto');
    const a = await ask(A, 'Halo'); const b = await ask(A, 'Tolong ringkas dan tulis surat undangan rapat koordinasi.');
    return ok(a.route?.auto && a.model === 'Claude Swift' && b.route?.category === 'writing' && b.model === 'Claude Core', `“Halo” → ${a.model} (${a.route?.category}) · surat → ${b.model} (${b.route?.category})`);
  });
  await step(A, 'gpt-knowledge', 'GPT answers from internal knowledge with numbered citations', async () => {
    await setModel(A, 'openai:gpt-sim'); const r = await ask(A, 'Berapa anggaran Program Makan Bergizi Gratis tahun 2026?');
    const marks = await A.locator('.msg.bot').last().locator('.cn').count();
    return ok(!r.error && r.provider === 'openai' && /71 triliun/.test(r.text) && r.cites.length > 0 && marks > 0, `${r.error || r.text.slice(0, 120)} · citations ${r.cites.length} · markers ${marks}`);
  });
  await step(A, 'failover', 'If Claude is down, Auto switches to GPT automatically', async () => {
    await setModel(A, 'auto'); const r = await ask(A, 'Tolong tulis memo singkat SIMULATE-OUTAGE');
    return ok(!r.error && r.provider === 'openai' && r.route?.failover, `${r.error || r.text.slice(0, 80)} · via ${r.model} · failover from ${r.route?.failover?.from}`);
  });
  await step(A, 'patients', 'Patient spreadsheet: names, record numbers and diagnoses never reach cloud AI', async () => {
    await A.goto(canopus.url + '#admin'); await A.click('[data-atab=knowledge]');
    await A.locator('.col-card', { hasText: 'Program Prioritas' }).locator('[data-upcol]').click(); await A.setInputFiles('#docFiles', F.patients); await A.click('[data-act=douploaddocs]');
    await A.waitForFunction(() => /indexed|error/i.test(document.querySelector('#upLog')?.textContent || ''), null, { timeout: 20000 }); await A.keyboard.press('Escape');
    await A.goto(canopus.url + '#home'); await setModel(A, 'core'); const before = cloud().length;
    const r = await ask(A, `Kapan kunjungan terakhir pasien ${SECRETS.patient}?`);
    const sent = cloud().slice(before); const leaked = sent.filter(x => [SECRETS.patient, SECRETS.rm, SECRETS.diagnosis].some(v => x.raw.includes(v)));
    return ok(!r.error && r.text.includes(SECRETS.patient) && /2026-11-10/.test(r.text) && sent.length && !leaked.length, `user sees name & date: ${r.text.includes(SECRETS.patient)} · requests to cloud ${sent.length}, with patient data ${leaked.length}`);
  });
  await step(A, 'local-only', 'An “on this server only” collection is never sent to cloud AI', async () => {
    await A.goto(canopus.url + '#admin'); await A.click('[data-atab=knowledge]');
    await A.click('[data-act=addcol]'); await A.fill('#cName', 'Rekam Medis Lokal'); await A.check('#cLocal'); await A.click('[data-act=savecol]'); await A.waitForTimeout(400);
    await A.locator('.col-card', { hasText: 'Rekam Medis Lokal' }).locator('[data-upcol]').click(); await A.setInputFiles('#docFiles', F.local); await A.click('[data-act=douploaddocs]');
    await A.waitForFunction(() => /indexed|error/i.test(document.querySelector('#upLog')?.textContent || ''), null, { timeout: 20000 }); await A.keyboard.press('Escape');
    await A.goto(canopus.url + '#home'); await setModel(A, 'core'); const before = cloud().length;
    const c = await ask(A, 'Apa marker verifikasi di catatan rekam medis?');
    const cloudSaw = cloud().slice(before).some(x => x.raw.includes(SECRETS.local));
    await setModel(A, 'local:llama-sim'); const l = await ask(A, 'Apa marker verifikasi di catatan rekam medis?');
    const localSaw = recorded.some(x => x.kind === 'local' && x.raw.includes(SECRETS.local));
    return ok(!c.text.includes(SECRETS.local) && !cloudSaw && l.provider === 'local' && l.text.includes(SECRETS.local) && localSaw, `cloud answer has it: ${c.text.includes(SECRETS.local)} · cloud saw it: ${cloudSaw} · local answer has it: ${l.text.includes(SECRETS.local)}`);
  });
  await step(A, 'local-lock', 'A chat that used on-premise data cannot move to cloud AI', async () => {
    await setModel(A, 'prime'); const before = cloud().length; const r = await follow(A, 'Jelaskan lebih lanjut.');
    return ok(r.provider === 'local' && cloud().length === before, `answered by ${r.model} (${r.provider}) · cloud requests during this turn: ${cloud().length - before}`);
  });
  await step(A, 'direct-search', 'Direct document search works without any AI request', async () => {
    const before = recorded.length; await A.goto(canopus.url + '#knowledge'); await A.fill('#dsQ', 'marker verifikasi'); await A.click('#dsForm button');
    await A.waitForFunction(() => document.querySelector('#dsRes .doc-row'), null, { timeout: 5000 }); const t = await A.textContent('#dsRes');
    return ok(t.includes(SECRETS.local) && recorded.length === before, `result shown: ${t.includes(SECRETS.local)} · AI requests: ${recorded.length - before}`);
  });
  await step(A, 'project', 'Admin creates a shared project (like a Claude project)', async () => {
    await A.goto(canopus.url + '#admin'); await A.click('[data-atab=projects]'); await A.click('[data-act=addproject]');
    await A.fill('#pjName', 'Asisten Program'); await A.fill('#pjInstr', 'Jawab ringkas. Selalu akhiri jawaban dengan kata PELANGI.');
    await A.locator('#pjCols label', { hasText: 'Program Prioritas' }).locator('input').check(); await A.click('[data-act=saveproject]'); await A.waitForTimeout(600);
    return ok((await A.locator('#adminBody .col-card', { hasText: 'Asisten Program' }).count()) === 1, 'project listed');
  });
  await step(A, 'invite-user', 'Invite a normal user into the Ekonomi group', async () => {
    await A.goto(canopus.url + '#admin'); await A.click('[data-atab=users]'); await A.click('[data-act=adduser]');
    await A.fill('#uEmail', 'staf@kantor.go.id'); await A.fill('#uName', 'Staf Ekonomi'); await A.locator('#uGroups label', { hasText: 'Ekonomi' }).locator('input').check();
    await A.click('[data-act=saveuser]'); await A.waitForSelector('#linkIn'); inviteB = await A.inputValue('#linkIn'); await A.keyboard.press('Escape');
    return ok(/#invite=/.test(inviteB), 'invite link created');
  });
  await step(B, 'user-onboard', 'User sets a password and signs in', async () => {
    await B.goto(inviteB); await B.fill('#iName', 'Staf Ekonomi'); await B.fill('#iPw', 'PasswordStaf99'); await B.fill('#iPw2', 'PasswordStaf99'); await B.click('#invForm button');
    await B.waitForSelector('#app:not([hidden])', { timeout: 10000 }); return ok(!(await B.isVisible('#navAdmin')), 'no admin menu for normal users');
  });
  await step(B, 'acl', 'A user cannot retrieve documents outside their groups', async () => {
    const before = recorded.length;
    const r = await ask(B, 'Apa verification marker di dokumen Polhukam?');
    const sentToAi = recorded.slice(before).some(x => x.raw.includes('ORION-77'));
    const know = JSON.parse((await apiCall(B, '/api/knowledge')).body).map(c => c.name);
    return ok(!r.text.includes('ORION-77') && !sentToAi && !know.includes('Dokumen Polhukam'), `answer: ${r.text.slice(0, 90)} · reached AI: ${sentToAi} · visible collections: ${know.join(', ')}`);
  });
  await step(B, 'api-guards', 'Server rejects forbidden requests', async () => {
    const checks = {
      adminApiAsUser: (await apiCall(B, '/api/admin/overview')).status,
      postWithoutHeader: (await apiCall(B, '/api/quick', { method: 'POST', body: '{}', headers: { 'content-type': 'application/json' } })).status,
      otherUsersBlob: (await apiCall(B, '/api/blobs/does-not-exist')).status,
    };
    const polDoc = JSON.parse((await apiCall(A, '/api/knowledge')).body).find(c => c.name === 'Dokumen Polhukam').docs[0].id;
    checks.restrictedDocFile = (await apiCall(B, `/api/knowledge/docs/${polDoc}/file`)).status;
    const anon = await (await fetch(canopus.url + 'api/me')).status; checks.anonymous = anon;
    const want = { adminApiAsUser: 403, postWithoutHeader: 403, otherUsersBlob: 404, restrictedDocFile: 404, anonymous: 401 };
    return ok(Object.entries(want).every(([k, v]) => checks[k] === v), JSON.stringify(checks));
  });
  await step(B, 'budget', 'A user over budget is stopped with a clear message', async () => {
    const uid = JSON.parse((await apiCall(A, '/api/admin/overview')).body).users.find(u => u.email === 'staf@kantor.go.id').id;
    await apiCall(A, '/api/admin/users/' + uid, { method: 'PATCH', headers: { 'content-type': 'application/json', 'x-canopus': '1' }, body: JSON.stringify({ budget_usd: 0.000001 }) });
    const r = await ask(B, 'Reply with exactly: SHOULD-NOT-RUN');
    await apiCall(A, '/api/admin/users/' + uid, { method: 'PATCH', headers: { 'content-type': 'application/json', 'x-canopus': '1' }, body: JSON.stringify({ budget_usd: null }) });
    return ok(/budget/i.test(r.error || ''), r.error || r.text);
  });
  await step(B, 'use-project', 'A user chats inside the shared project', async () => {
    await B.goto(canopus.url + '#home'); await B.reload(); await B.waitForSelector('#app:not([hidden])');
    await B.locator('#projList [data-project]', { hasText: 'Asisten Program' }).click(); await B.waitForTimeout(200);
    const r = await follow(B, 'Berapa anggaran program MBG 2026?');
    const pid = await B.evaluate(() => { const s = window.__canopus.state; return s.chats.find(c => c.id === s.current)?.projectId; });
    return ok(!r.error && /PELANGI/.test(r.text) && /71 triliun/.test(r.text) && pid, `${r.error || r.text.slice(0, 100)}`);
  });
  const gid = JSON.parse((await apiCall(A, '/api/admin/overview')).body).groups.find(g => g.name === 'Ekonomi').id;
  await step(B, 'group-models', 'Group model permissions: Auto picks the closest allowed model', async () => {
    await putJson(A, '/api/admin/groups/' + gid, { models: ['swift'] }, 'PATCH');
    await B.reload(); await B.waitForSelector('#app:not([hidden])'); await setModel(B, 'auto');
    const r = await ask(B, 'Tolong tulis surat undangan rapat.'); const forced = await apiCall(B, '/api/me');
    const allowed = JSON.parse(forced.body).config.models.map(m => m.id);
    await putJson(A, '/api/admin/groups/' + gid, { models: null }, 'PATCH');
    return ok(r.model === 'Claude Swift' && allowed.join() === 'swift', `writing → ${r.model} · allowed: ${allowed.join(', ')}`);
  });
  await step(B, 'group-budget', 'A group over its shared budget is stopped', async () => {
    await putJson(A, '/api/admin/groups/' + gid, { budget_usd: 0.000001 }, 'PATCH');
    const r = await ask(B, 'Reply with exactly: GROUP-BLOCK'); await putJson(A, '/api/admin/groups/' + gid, { budget_usd: null }, 'PATCH');
    return ok(/group/i.test(r.error || ''), r.error || r.text);
  });
  await step(B, 'rate-limit', 'Per-minute request limit is enforced', async () => {
    await putJson(A, '/api/admin/settings', { rateLimits: { perMinute: 1, perDay: 400 } });
    await ask(B, 'Reply with exactly: ONE'); const r = await ask(B, 'Reply with exactly: TWO');
    await putJson(A, '/api/admin/settings', { rateLimits: { perMinute: 15, perDay: 400 } });
    return ok(/per minute/i.test(r.error || ''), r.error || r.text);
  });
  await step(B, 'persist', 'Chats are stored on the server (survive reload and other devices)', async () => {
    await B.evaluate(() => window.__canopus.flush()); const n = await B.evaluate(() => window.__canopus.state.chats.length);
    const C = await browser.newContext(); const pc = await C.newPage(); await pc.goto(canopus.url); await pc.fill('#lEmail', 'staf@kantor.go.id'); await pc.fill('#lPw', 'PasswordStaf99'); await pc.click('#loginForm button');
    await pc.waitForSelector('#app:not([hidden])'); const m = await pc.evaluate(() => window.__canopus.state.chats.length); await C.close();
    return ok(n > 0 && n === m, `chats here ${n}, on a second device ${m}`);
  });
  await step(null, 'throttle', 'Repeated wrong passwords lock the account temporarily', async () => {
    let last; for (let i = 0; i < 6; i++) last = await fetch(canopus.url + 'api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json', 'x-canopus': '1' }, body: JSON.stringify({ email: 'staf@kantor.go.id', password: 'wrong' + i }) });
    return ok(last.status === 429, `status after 6 attempts: ${last.status}`);
  });
  await step(A, 'webhook', 'Signed webhook notifications reach n8n-style receivers', async () => {
    const got = []; const wh = http.createServer(async (req, res) => { const c = []; for await (const x of req) c.push(x); got.push({ body: Buffer.concat(c).toString(), sig: req.headers['x-canopus-signature'] }); res.end('ok'); });
    await new Promise(r => wh.listen(0, '127.0.0.1', r));
    await A.goto(canopus.url + '#admin'); await A.click('[data-atab=integrations]'); await A.fill('#whUrl', `http://127.0.0.1:${wh.address().port}/hook`); await A.click('[data-act=savewebhook]'); await A.waitForTimeout(500);
    await A.click('[data-act=testwebhook]'); await A.waitForTimeout(800);
    const secret = JSON.parse((await apiCall(A, '/api/admin/webhook/secret')).body).secret;
    const crypto = await import('node:crypto'); const valid = got.length && got[0].sig === 'sha256=' + crypto.createHmac('sha256', secret).update(got[0].body).digest('hex');
    wh.close(); return ok(valid && JSON.parse(got[0].body).event === 'test', `received ${got.length} · signature valid: ${!!valid}`);
  });
  await step(A, 'api-token', 'Integration API: scoped token can ask, cannot upload, and can be revoked', async () => {
    const uid = JSON.parse((await apiCall(A, '/api/admin/overview')).body).users.find(u => u.email === 'admin@kantor.go.id').id;
    const tk = JSON.parse((await putJson(A, '/api/admin/tokens', { name: 'n8n test', user_id: uid, scopes: ['ask'] }, 'POST')).body);
    const call = (path, init = {}) => fetch(canopus.url + path.replace(/^\//, ''), { ...init, headers: { authorization: 'Bearer ' + tk.token, 'content-type': 'application/json', ...(init.headers || {}) } });
    const a = await call('/api/v1/ask', { method: 'POST', body: JSON.stringify({ question: 'Berapa anggaran Program Makan Bergizi Gratis 2026?' }) }); const aj = await a.json();
    const col = JSON.parse((await apiCall(A, '/api/knowledge')).body)[0].id;
    const up = await call(`/api/v1/collections/${col}/docs`, { method: 'POST', headers: { 'x-filename': 'x.txt', 'x-classification': 'biasa', 'content-type': 'text/plain' }, body: 'hello' });
    await apiCall(A, '/api/admin/tokens/' + tk.id, { method: 'DELETE', headers: { 'x-canopus': '1' } });
    const after = await call('/api/v1/ask', { method: 'POST', body: JSON.stringify({ question: 'hi' }) });
    return ok(a.status === 200 && /71 triliun/.test(aj.answer || '') && up.status === 403 && after.status === 401, `ask ${a.status} · upload ${up.status} · after revoke ${after.status}`);
  });
  await step(A, 'audit', 'Audit log records searches, refusals and sign-ins', async () => {
    const rows = JSON.parse((await apiCall(A, '/api/admin/audit?limit=500')).body); const acts = new Set(rows.map(r => r.action));
    const need = ['knowledge.search', 'knowledge.upload', 'knowledge.upload_refused', 'auth.login_failed', 'redaction.applied', 'admin.user_created', 'ai.failover', 'knowledge.direct_search', 'api.ask', 'admin.project_created'];
    const plain = rows.some(r => JSON.stringify(r.detail).includes(SECRETS.nik) || JSON.stringify(r.detail).includes(SECRETS.patient));
    return ok(need.every(a => acts.has(a)) && !plain, `missing: ${need.filter(a => !acts.has(a)).join(', ') || 'none'} · raw NIK in log: ${plain}`);
  });
  await step(A, 'usage', 'Usage and cost are tracked per user', async () => {
    const u = JSON.parse((await apiCall(A, '/api/admin/usage')).body); return ok(u.rows.length >= 2 && u.total > 0, `users with usage: ${u.rows.length} · estimated total $${u.total.toFixed(4)}`);
  });
  await step(B, 'text-mode', 'Text-only mode hides Studio and canvases', async () => {
    await putJson(A, '/api/admin/settings', { canvas: false }); await B.reload(); await B.waitForSelector('#app:not([hidden])');
    return ok(await B.locator('[data-go=studio]').isHidden(), 'Studio hidden for users with no canvases');
  });
  await step(null, 'no-leaks', 'No sensitive value ever reached a cloud AI provider', async () => ok(cloud().length > 0 && !leaks().length, `${cloud().length} cloud requests inspected (Claude + GPT) · ${recorded.length - cloud().length} on-premise · leaks: ${leaks().length}`));
  await step(A, 'tour', 'Every page renders (screenshots for review)', async () => {
    for (const v of ['home', 'knowledge', 'studio', 'prompts', 'skills']) { await A.goto(canopus.url + '#' + v); if (v === 'home') await A.click('[data-go=home]'); await A.waitForTimeout(400); await A.screenshot({ path: path.join(OUT, `server-page-${v}.png`) }); }
    await A.goto(canopus.url + '#admin'); for (const t of ['users', 'groups', 'projects', 'knowledge', 'models', 'settings', 'integrations', 'usage', 'audit']) { await A.click(`[data-atab=${t}]`); await A.waitForTimeout(400); await A.screenshot({ path: path.join(OUT, `server-admin-${t}.png`) }); }
    const M = await browser.newContext({ viewport: { width: 390, height: 844 } }); const pm = await M.newPage(); await pm.goto(canopus.url); await pm.waitForTimeout(500); await pm.screenshot({ path: path.join(OUT, 'server-page-mobile-login.png') }); await M.close();
    return ok(!pageErrors.length, pageErrors.join(' | ') || 'no page errors');
  });
} finally {
  await browser.close(); canopus.proc.kill(); claudeSrv.close();
  fs.writeFileSync(path.join(OUT, 'server.log'), canopus.log());
  fs.writeFileSync(path.join(OUT, 'requests.json'), JSON.stringify(recorded.map(r => ({ kind: r.kind, path: r.path, leaked: Object.entries(SECRETS).filter(([, v]) => r.raw.includes(v)).map(([k]) => k) })), null, 1));
}

const c = k => results.filter(r => r.status === k).length;
let md = `# Canopus server harness report\n\n- Run: ${new Date().toLocaleString()}\n- Mode: ${LIVE ? 'live (real Claude API, recorded)' : 'simulated Claude API'}\n- Requests inspected: ${cloud().length} to cloud AI (Claude + GPT), ${recorded.length - cloud().length} to the on-premise model\n\n**${c('pass')} passed · ${c('fail')} failed · ${c('warn')} warnings**\n\n| | Check | Time | Detail |\n|---|---|---|---|\n`;
for (const r of results) md += `| ${{ pass: '✅', fail: '❌', warn: '⚠️' }[r.status]} | ${r.title} | ${(r.ms / 1000).toFixed(1)}s | ${r.detail.replace(/\|/g, '\\|')} |\n`;
fs.writeFileSync(path.join(OUT, 'report.md'), md); fs.copyFileSync(path.join(OUT, 'report.md'), path.join(HERE, 'report', 'latest-server.md'));
console.log(`\nReport: ${path.join(OUT, 'report.md')}`);
process.exit(c('fail') ? 1 : 0);
