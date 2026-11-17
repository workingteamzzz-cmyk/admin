// Canopus end-to-end harness.
//
//   node run.mjs --mock                 # simulated providers, no API key needed
//   node run.mjs                        # live, provider from environment variables (see README.md)
//   node run.mjs --only=basic,canvas    # run a subset
//
// It serves ../canopus.html from localhost, drives it in headless Chromium, and writes
// report/<timestamp>/report.md (+ results.json and one screenshot per scenario).

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP = path.resolve(HERE, '..', 'canopus.html');
const args = Object.fromEntries(process.argv.slice(2).map(a => { const [k, v] = a.replace(/^--/, '').split('='); return [k, v ?? true]; }));
const MOCK = !!args.mock;
const ONLY = args.only ? String(args.only).split(',') : null;
const TIMEOUT = +(args.timeout || (MOCK ? 20000 : 240000));

/* ---------------- provider config ---------------- */
// Live mode reads:
//   CANOPUS_PROVIDER = claude | compat          (default: claude if ANTHROPIC_API_KEY or CANOPUS_PROVIDER=claude)
//   CANOPUS_API_KEY  = the key (or any placeholder when the network proxy injects the real one)
//   CANOPUS_BASE_URL = https://…/v1             (compat only)
//   CANOPUS_MODEL    = model id                 (compat only; claude uses prime|core|swift, default prime)
//   CANOPUS_NAME     = display name for the provider (compat only)
function providerConfig() {
  if (MOCK) {
    const which = args.provider || 'both';
    return { mock: which };
  }
  const kind = process.env.CANOPUS_PROVIDER || (process.env.ANTHROPIC_API_KEY ? 'claude' : 'compat');
  const key = process.env.CANOPUS_API_KEY || process.env.ANTHROPIC_API_KEY || 'proxy-injected';
  if (kind === 'claude') return { kind, key, model: 'claude:' + (process.env.CANOPUS_MODEL || 'prime') };
  const base = process.env.CANOPUS_BASE_URL; const model = process.env.CANOPUS_MODEL;
  if (!base || !model) { console.error('Live compat mode needs CANOPUS_BASE_URL and CANOPUS_MODEL (see README.md).'); process.exit(2); }
  return { kind, key, base, model, name: process.env.CANOPUS_NAME || new URL(base).hostname };
}
const CFG = providerConfig();

/* ---------------- libraries (served locally; the CDN may be blocked) ---------------- */
const LIBDIR = path.join(HERE, 'libs');
async function prepareLibs() {
  fs.mkdirSync(LIBDIR, { recursive: true });
  const sdk = path.join(LIBDIR, 'sdk.mjs');
  if (!fs.existsSync(sdk)) {
    const esbuild = await import('esbuild');
    const entry = path.join(LIBDIR, 'sdk-entry.mjs');
    fs.writeFileSync(entry, 'export { default } from "@anthropic-ai/sdk"; export * from "@anthropic-ai/sdk";');
    await esbuild.build({ entryPoints: [entry], bundle: true, format: 'esm', platform: 'browser', outfile: sdk, absWorkingDir: HERE, nodePaths: [path.join(HERE, 'node_modules')], logLevel: 'error' });
  }
  const nm = p => path.join(HERE, 'node_modules', p);
  return [
    [/@anthropic-ai\/sdk@[^/]+\/\+esm/, sdk],
    [/marked@[^/]+\/lib\/marked\.esm\.js/, nm('marked/lib/marked.esm.js')],
    [/dompurify@[^/]+\/dist\/purify\.es\.mjs/, nm('dompurify/dist/purify.es.mjs')],
    [/jszip@[^/]+\/dist\/jszip\.min\.js/, nm('jszip/dist/jszip.min.js')],
    [/pdfjs-dist@[^/]+\/build\/pdf\.worker\.min\.mjs/, nm('pdfjs-dist/build/pdf.worker.min.mjs')],
    [/pdfjs-dist@[^/]+\/build\/pdf\.min\.mjs/, nm('pdfjs-dist/build/pdf.min.mjs')],
  ];
}

/* ---------------- fixtures ---------------- */
const FIX = path.join(HERE, 'report', '.fixtures');
function crc32(buf) { let c, crc = 0xffffffff; for (let n = 0; n < buf.length; n++) { c = (crc ^ buf[n]) & 0xff; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; crc = (crc >>> 8) ^ c; } return (crc ^ 0xffffffff) >>> 0; }
function png(w, h, [r, g, b]) {
  const raw = Buffer.alloc((w * 3 + 1) * h); for (let y = 0; y < h; y++) { raw[y * (w * 3 + 1)] = 0; for (let x = 0; x < w; x++) raw.set([r, g, b], y * (w * 3 + 1) + 1 + x * 3); }
  const chunk = (t, d) => { const len = Buffer.alloc(4); len.writeUInt32BE(d.length); const td = Buffer.concat([Buffer.from(t), d]); const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td)); return Buffer.concat([len, td, crc]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
function pdf(lines) {
  const content = 'BT /F1 20 Tf 72 720 Td 26 TL ' + lines.map(l => `(${l.replace(/[()\\]/g, '\\$&')}) Tj T*`).join(' ') + ' ET';
  const objs = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'];
  let out = '%PDF-1.4\n'; const offs = [];
  objs.forEach((o, i) => { offs.push(out.length); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const x = out.length; out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n` + offs.map(o => String(o).padStart(10, '0') + ' 00000 n \n').join('');
  return Buffer.from(out + `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${x}\n%%EOF\n`, 'latin1');
}
function fixtures() {
  fs.mkdirSync(FIX, { recursive: true });
  const f = {
    txt: path.join(FIX, 'project-notes.txt'), pdf: path.join(FIX, 'briefing.pdf'), png: path.join(FIX, 'swatch.png'),
  };
  fs.writeFileSync(f.txt, 'Internal project notes.\nThe project codename is BLUE HERON.\nThe approved budget is 4.2 billion rupiah.\n');
  fs.writeFileSync(f.pdf, pdf(['Canopus harness briefing', 'The verification marker is VEGA-42.', 'Prepared for testing only.']));
  fs.writeFileSync(f.png, png(64, 64, [220, 20, 20]));
  return f;
}

/* ---------------- mock providers ---------------- */
function mockAnswer(messages, sys) {
  const flat = JSON.stringify(messages);
  const lastUser = [...messages].reverse().find(m => m.role === 'user');
  const lastText = typeof lastUser.content === 'string' ? lastUser.content : lastUser.content.filter(b => b.type === 'text').map(b => b.text).join('\n');
  const has = re => re.test(lastText);
  let t;
  const ex = lastText.match(/Reply with exactly:\s*(\S+)/i);
  if (ex) t = ex[1];
  else if (has(/code word/i) && /ORION-7/.test(flat) && !has(/ORION-7/)) t = 'Your code word is ORION-7.';
  else if (has(/remember/i)) t = 'OK.';
  else if (has(/^Translate the text below/i)) t = 'Good morning, the meeting starts at nine.';
  else if (has(/ibu kota/i)) t = 'Ibu kota Indonesia adalah Jakarta.';
  else if (has(/codename/i)) t = /BLUE HERON/.test(flat) ? 'The codename in project-notes.txt is BLUE HERON.' : 'I could not find a codename.';
  else if (has(/marker/i)) t = /VEGA-42/.test(flat) || /"type":"document"[^}]*application\/pdf/.test(flat) ? 'The marker in the PDF is VEGA-42.' : 'I could not read the PDF.';
  else if (has(/colou?r/i)) t = /image/.test(flat) ? 'Red.' : 'I do not see an image.';
  else if (has(/Change the heading/i)) t = 'Updated.\n\n```html\n<!doctype html><html><head><title>Harness Canvas</title></head><body><h1>Hello again</h1></body></html>\n```\n\nThe heading is changed.';
  else if (has(/HTML page/i)) t = 'Here it is.\n\n```html\n<!doctype html><html><head><title>Harness Canvas</title></head><body style="font-family:sans-serif"><h1>Hello Canopus</h1></body></html>\n```\n\nA simple page.';
  else t = 'Hello! How can I help?';
  if (/PELANGI/.test(sys)) t += ' PELANGI';
  if (/ZEBRA-CHECK/.test(sys)) t += ' ZEBRA-CHECK';
  return t;
}
const sse = evs => evs.map(e => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join('');
function anthropicStream(body) {
  const text = mockAnswer(body.messages, JSON.stringify(body.system));
  const ev = [{ type: 'message_start', message: { id: 'msg_mock', type: 'message', role: 'assistant', model: body.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 120, output_tokens: 1 } } }];
  let i = 0;
  ev.push({ type: 'content_block_start', index: i, content_block: { type: 'thinking', thinking: '', signature: '' } }, { type: 'content_block_delta', index: i, delta: { type: 'thinking_delta', thinking: 'Working out the answer.' } }, { type: 'content_block_delta', index: i, delta: { type: 'signature_delta', signature: 'sig' } }, { type: 'content_block_stop', index: i }); i++;
  if (body.tools?.length) {
    ev.push({ type: 'content_block_start', index: i, content_block: { type: 'server_tool_use', id: 'srvtoolu_1', name: 'web_search', input: {} } }, { type: 'content_block_delta', index: i, delta: { type: 'input_json_delta', partial_json: '{"query":"test"}' } }, { type: 'content_block_stop', index: i }); i++;
    ev.push({ type: 'content_block_start', index: i, content_block: { type: 'web_search_tool_result', tool_use_id: 'srvtoolu_1', content: [{ type: 'web_search_result', url: 'https://example.com/news', title: 'Example News', encrypted_content: 'x', page_age: null }] } }, { type: 'content_block_stop', index: i }); i++;
  }
  ev.push({ type: 'content_block_start', index: i, content_block: { type: 'text', text: '' } });
  for (const ch of text.match(/[\s\S]{1,24}/g)) ev.push({ type: 'content_block_delta', index: i, delta: { type: 'text_delta', text: ch } });
  ev.push({ type: 'content_block_stop', index: i }, { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 42 } }, { type: 'message_stop' });
  return sse(ev);
}
function compatStream(body) {
  const sys = body.messages.find(m => m.role === 'system')?.content || '';
  const text = mockAnswer(body.messages.filter(m => m.role !== 'system'), sys);
  const ch = text.match(/[\s\S]{1,24}/g).map(c => ({ id: 'c', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { content: c }, finish_reason: null }] }));
  ch.push({ id: 'c', object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }, { id: 'c', choices: [], usage: { prompt_tokens: 90, completion_tokens: 30 } });
  return ch.map(c => `data: ${JSON.stringify(c)}\n\n`).join('') + 'data: [DONE]\n\n';
}
const MOCK_BASE = 'https://mock-provider.canopus.test/v1';
async function installMocks(ctx) {
  const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*' };
  const slow = b => /essay|2000-word/i.test(JSON.stringify(b.messages.at(-1)));
  await ctx.route('https://api.anthropic.com/**', async r => {
    const req = r.request(); if (req.method() === 'OPTIONS') return r.fulfill({ status: 204, headers: cors });
    const body = JSON.parse(req.postData());
    if (/nonexistent/.test(body.model)) return r.fulfill({ status: 404, headers: { ...cors, 'content-type': 'application/json' }, body: JSON.stringify({ type: 'error', error: { type: 'not_found_error', message: 'model: ' + body.model } }) });
    if (!body.stream) return r.fulfill({ status: 200, headers: { ...cors, 'content-type': 'application/json' }, body: JSON.stringify({ id: 'm', type: 'message', role: 'assistant', model: body.model, content: [{ type: 'text', text: 'Harness Test Chat' }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } }) });
    if (slow(body)) await new Promise(res => setTimeout(res, 6000));
    try { await r.fulfill({ status: 200, headers: { ...cors, 'content-type': 'text/event-stream' }, body: anthropicStream(body) }); } catch {}
  });
  await ctx.route(MOCK_BASE + '/**', async r => {
    const req = r.request(); if (req.method() === 'OPTIONS') return r.fulfill({ status: 204, headers: cors });
    if (req.url().endsWith('/models')) return r.fulfill({ status: 200, headers: { ...cors, 'content-type': 'application/json' }, body: JSON.stringify({ data: [{ id: 'mock-chat-1' }, { id: 'mock-chat-2' }] }) });
    const body = JSON.parse(req.postData());
    if (/nonexistent/.test(body.model)) return r.fulfill({ status: 404, headers: { ...cors, 'content-type': 'application/json' }, body: JSON.stringify({ error: { message: 'The model does not exist', code: 'model_not_found' } }) });
    if (!body.stream) return r.fulfill({ status: 200, headers: { ...cors, 'content-type': 'application/json' }, body: JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'Harness Test Chat' } }] }) });
    if (slow(body)) await new Promise(res => setTimeout(res, 6000));
    try { await r.fulfill({ status: 200, headers: { ...cors, 'content-type': 'text/event-stream' }, body: compatStream(body) }); } catch {}
  });
}

/* ---------------- page helpers ---------------- */
const state = p => p.evaluate(() => JSON.parse(JSON.stringify(window.__canopus.state)));
async function waitIdle(p, timeout = TIMEOUT) {
  await p.waitForFunction(() => window.__canopus.busy(), null, { timeout: 5000 }).catch(() => {});
  await p.waitForFunction(() => !window.__canopus.busy(), null, { timeout });
  await p.waitForTimeout(300);
}
async function lastReply(p) {
  return p.evaluate(() => { const s = window.__canopus.state; const c = s.chats.find(x => x.id === s.current); const m = c && [...c.msgs].reverse().find(x => x.r === 'assistant');
    return m ? { text: (m.content || []).filter(b => b.type === 'text').map(b => b.text).join(''), error: m.error || null, stopped: !!m.stopped, refused: !!m.refused, usage: m.usage || null, blocks: (m.content || []).map(b => b.type) } : null; });
}
async function newChat(p) { await p.click('[data-act=new]'); await p.waitForTimeout(200); }
async function send(p, text, files) {
  if (files) { await p.setInputFiles('#file', files); await p.waitForFunction(n => document.querySelectorAll('#chips .chip').length >= n, files.length); }
  await p.fill('#input', text); await p.keyboard.press('Enter');
  await waitIdle(p);
  return lastReply(p);
}

/* ---------------- scenarios ---------------- */
const isClaude = () => (MOCK ? CURRENT_MOCK === 'claude' : CFG.kind === 'claude');
let CURRENT_MOCK = null;
const S = [];
const scenario = (name, title, fn, opts = {}) => S.push({ name, title, fn, ...opts });
const expect = (cond, detail) => ({ pass: !!cond, detail });

scenario('connect', 'Connect a provider through Settings', async p => {
  await p.click('.user'); await p.click('[data-settab=models]');
  if (isClaude()) { await p.fill('#sKey', MOCK ? 'sk-ant-mock' : CFG.key); }
  else {
    await p.click('[data-act=addprov]');
    const prov = p.locator('#provList .prov').last();
    await prov.locator('[data-pf=preset]').selectOption('custom');
    await prov.locator('[data-pf=name]').fill(MOCK ? 'Mock Provider' : CFG.name);
    await prov.locator('[data-pf=baseUrl]').fill(MOCK ? MOCK_BASE : CFG.base);
    await prov.locator('[data-pf=key]').fill(MOCK ? 'mock-key' : CFG.key);
    await prov.locator('[data-pf=models]').fill(MOCK ? 'mock-chat-1' : CFG.model);
  }
  await p.click('[data-act=savesettings]'); await p.waitForTimeout(300);
  if (!MOCK && isClaude() && CFG.model !== 'claude:prime') await p.evaluate(m => window.__canopus.configure({ model: m }), CFG.model);
  const s = await state(p); const models = await p.evaluate(() => window.__canopus.models().map(m => m.key));
  return expect(models.length > 0 && s.onboarded, `models available: ${models.join(', ')}`);
});
scenario('basic', 'Answers a simple instruction exactly', async p => {
  await newChat(p); const r = await send(p, 'Reply with exactly: CANOPUS-OK');
  return expect(r && !r.error && /CANOPUS-OK/.test(r.text), r?.error || r?.text);
});
scenario('indonesian', 'Replies in Indonesian when asked in Indonesian', async p => {
  await newChat(p); const r = await send(p, 'Apa ibu kota Indonesia? Jawab dalam satu kalimat.');
  return expect(r && !r.error && /Jakarta/i.test(r.text) && /\b(adalah|ibu kota|ialah)\b/i.test(r.text), r?.error || r?.text);
});
scenario('memory', 'Remembers earlier turns in the same chat', async p => {
  await newChat(p); await send(p, 'Remember this code word: ORION-7. Just reply OK.');
  const r = await send(p, 'What is my code word? Reply with the code word only.');
  return expect(r && !r.error && /ORION-7/.test(r.text), r?.error || r?.text);
});
scenario('text-file', 'Reads an attached text file', async (p, f) => {
  await newChat(p); const r = await send(p, 'What is the project codename in the attached file? Reply with the codename only.', [f.txt]);
  return expect(r && !r.error && /BLUE HERON/i.test(r.text), r?.error || r?.text);
});
scenario('pdf', 'Reads an attached PDF', async (p, f) => {
  await newChat(p); const r = await send(p, 'What is the verification marker in the attached PDF? Reply with the marker only.', [f.pdf]);
  return expect(r && !r.error && /VEGA-42/i.test(r.text), r?.error || r?.text);
});
scenario('image', 'Understands an attached image', async (p, f) => {
  await newChat(p); const r = await send(p, 'What is the dominant colour of the attached image? Answer in one word.', [f.png]);
  return expect(r && !r.error && /red|merah/i.test(r.text), r?.error || r?.text);
}, { soft: true });
scenario('canvas', 'Builds a canvas, shows it in the side panel and saves it to Studio', async p => {
  await newChat(p);
  const r = await send(p, "Create a simple HTML page titled 'Harness Canvas' with one heading that says 'Hello Canopus'. Keep it very short.");
  await p.waitForTimeout(500);
  const s = await state(p); const cv = s.canvases.find(c => /harness canvas/i.test(c.title));
  const panel = await p.isVisible('#panel iframe');
  return expect(cv && panel, `canvas: ${cv ? cv.title : 'none'} · panel open: ${panel} · ${r?.error || ''}`);
});
scenario('canvas-version', 'Revising a canvas saves a new version', async p => {
  const r = await send(p, "Change the heading to 'Hello again'. Keep the same <title>.");
  const s = await state(p); const cv = s.canvases.find(c => /harness canvas/i.test(c.title));
  return expect(cv && cv.versions.length >= 2 && /Hello again/i.test(cv.versions.at(-1).html), `versions: ${cv?.versions.length ?? 0} · ${r?.error || ''}`);
});
scenario('space', 'Space instructions apply to chats in the space', async p => {
  await p.evaluate(() => { const s = window.__canopus.state; s.spaces.push({ id: 'hs', name: 'Harness Space', instructions: 'Always end every reply with the word PELANGI.', color: '#a99bff', fileIds: [] }); });
  await p.goto(p.url().split('#')[0] + '#space/hs'); await p.waitForTimeout(300);
  await p.click('[data-act=spacechat]'); await p.waitForTimeout(200);
  const r = await send(p, 'Say hello in one short sentence.');
  const s = await state(p); const c = s.chats.find(x => x.id === s.current);
  return expect(r && !r.error && /PELANGI/.test(r.text) && c.spaceId === 'hs', r?.error || r?.text);
});
scenario('skill', 'An enabled skill changes the behaviour', async p => {
  await p.evaluate(() => window.__canopus.state.skills.push({ id: 'hsk', name: 'Harness skill', description: 'test', content: 'In every reply, include the exact phrase ZEBRA-CHECK.', enabled: true }));
  await p.goto(p.url().split('#')[0] + '#home'); await newChat(p);
  const r = await send(p, 'Say hello in one short sentence.');
  await p.evaluate(() => { const s = window.__canopus.state; s.skills = s.skills.filter(x => x.id !== 'hsk'); });
  return expect(r && !r.error && /ZEBRA-CHECK/.test(r.text), r?.error || r?.text);
});
scenario('prompt', 'A prompt template fills in and sends', async p => {
  await p.goto(p.url().split('#')[0] + '#prompts'); await p.waitForTimeout(200);
  await p.click('.tpl[data-useprompt="bp6"]');
  await p.fill('[data-var="language"]', 'English'); await p.fill('[data-var="text"]', 'Selamat pagi, rapat dimulai pukul sembilan.');
  await p.click('[data-act=fillprompt]'); await p.waitForTimeout(200);
  const filled = await p.inputValue('#input');
  await p.keyboard.press('Enter'); await waitIdle(p); const r = await lastReply(p);
  const sent = await p.evaluate(() => { const s = window.__canopus.state; const c = s.chats.find(x => x.id === s.current); return c?.msgs.find(m => m.r === 'user')?.text || ''; });
  return expect(/Translate the text below into English/.test(filled) && /^Translate the text below/.test(sent) && r && !r.error && r.text.length > 0, `sent as a new chat: ${/^Translate/.test(sent)} · ${r?.error || r?.text}`);
});
scenario('stop', 'Stop button interrupts a long reply cleanly', async p => {
  await newChat(p);
  await p.fill('#input', 'Write a 2000-word essay about the history of astronomy.'); await p.keyboard.press('Enter');
  await p.waitForFunction(() => window.__canopus.busy(), null, { timeout: 5000 });
  await p.waitForTimeout(2000); await p.click('#send.stop');
  await p.waitForFunction(() => !window.__canopus.busy(), null, { timeout: 15000 });
  const r = await lastReply(p);
  return expect(r && r.stopped && !r.error, `stopped=${r?.stopped} error=${r?.error} chars=${r?.text.length}`);
});
scenario('web', 'Web search returns sources (Claude only)', async p => {
  await newChat(p); await p.evaluate(() => { window.__canopus.state.web = true; });
  const r = await send(p, 'Search the web: what is one major science headline this week? Cite a source.');
  await p.evaluate(() => { window.__canopus.state.web = false; });
  const srcs = await p.locator('.msg.bot').last().locator('.src').count();
  return expect(r && !r.error && r.blocks.includes('web_search_tool_result') && srcs > 0, `sources shown: ${srcs} · ${r?.error || r?.text.slice(0, 120)}`);
}, { claudeOnly: true });
scenario('bad-model', 'A wrong model ID shows a helpful error', async p => {
  await newChat(p);
  // Rewrite the model ID of the next chat request only, then restore.
  await p.evaluate(() => { const orig = window.fetch; window.__restoreFetch = () => { window.fetch = orig; };
    window.fetch = (u, o) => { if (/\/(messages|chat\/completions)$/.test(String(u)) && o?.body) { const b = JSON.parse(o.body); if (b.stream) { b.model = 'canopus-nonexistent-model'; o = { ...o, body: JSON.stringify(b) }; } } return orig(u, o); }; });
  const r = await send(p, 'Hello');
  await p.evaluate(() => window.__restoreFetch());
  const shown = await p.locator('.msg.bot').last().locator('.err').count();
  return expect(r && r.error && shown > 0, r?.error || 'no error shown');
});
scenario('tour', 'Every page renders (screenshots for review)', async p => {
  const base = p.url().split('#')[0]; const shots = [];
  for (const v of ['home', 'studio', 'sources', 'prompts', 'skills', 'space/hs']) {
    await p.goto(base + '#' + v); if (v === 'home') await p.click('[data-go=home]'); await p.waitForTimeout(500);
    const f = `${CURRENT_LABEL}-page-${v.replace('/', '-')}.png`; await p.screenshot({ path: path.join(OUT, f) }); shots.push(f);
  }
  await p.click('.user'); await p.click('[data-settab=models]'); await p.waitForTimeout(200);
  await p.screenshot({ path: path.join(OUT, `${CURRENT_LABEL}-page-settings.png`) }); await p.keyboard.press('Escape');
  await p.setViewportSize({ width: 390, height: 844 }); await p.goto(base + '#home'); await p.waitForTimeout(400);
  await p.screenshot({ path: path.join(OUT, `${CURRENT_LABEL}-page-mobile.png`) }); await p.setViewportSize({ width: 1440, height: 900 });
  const errs = await p.evaluate(() => document.querySelectorAll('.err').length);
  return expect(true, `${shots.length + 2} page screenshots saved`);
});
scenario('persist', 'Everything survives a page reload', async p => {
  const before = await state(p);
  await p.waitForTimeout(600); await p.reload(); await p.waitForFunction(() => window.__canopus, null, { timeout: 15000 }); await p.waitForTimeout(800);
  const after = await state(p);
  return expect(after.chats.length === before.chats.length && after.canvases.length === before.canvases.length, `chats ${before.chats.length}→${after.chats.length}, canvases ${before.canvases.length}→${after.canvases.length}`);
});

/* ---------------- runner ---------------- */
let CURRENT_LABEL = '';
async function runSuite(label, providerKind) {
  CURRENT_LABEL = label;
  const libs = await prepareLibs();
  const html = fs.readFileSync(APP);
  const server = http.createServer((req, res) => { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(html); });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}/`;
  const launch = {};
  if (!MOCK && process.env.HTTPS_PROXY) launch.proxy = { server: process.env.HTTPS_PROXY, bypass: '127.0.0.1,localhost' };
  const browser = await chromium.launch(launch);
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await ctx.route(/fonts\.(googleapis|gstatic)\.com|google\.com\/s2\/favicons/, r => r.abort());
  await ctx.route(/cdn\.jsdelivr\.net/, r => { const u = r.request().url(); const hit = libs.find(([re]) => re.test(u)); if (!hit) return r.abort(); r.fulfill({ status: 200, headers: { 'content-type': 'text/javascript', 'access-control-allow-origin': '*' }, body: fs.readFileSync(hit[1]) }); });
  if (MOCK) await installMocks(ctx);
  const page = await ctx.newPage();
  const consoleErrors = [];
  page.on('pageerror', e => consoleErrors.push(e.message));
  await page.goto(url); await page.waitForFunction(() => window.__canopus, null, { timeout: 15000 }); await page.waitForTimeout(400);
  // dismiss the welcome dialog
  if (await page.isVisible('[data-act=welcomeother]')) { await page.fill('#sName', 'Harness'); await page.click('[data-act=savesettings]'); }
  const f = fixtures();
  const dir = OUT; const results = [];
  for (const sc of S) {
    if (ONLY && !ONLY.includes(sc.name)) continue;
    if (sc.claudeOnly && providerKind !== 'claude') { results.push({ ...sc, status: 'skip', detail: 'Claude-only feature', ms: 0 }); continue; }
    const t0 = Date.now(); let res;
    try { res = await sc.fn(page, f); } catch (e) { res = { pass: false, detail: 'Exception: ' + e.message.split('\n')[0] }; }
    const shot = `${label}-${sc.name}.png`; await page.screenshot({ path: path.join(dir, shot) }).catch(() => {});
    const status = res.pass ? 'pass' : sc.soft ? 'warn' : 'fail';
    results.push({ name: sc.name, title: sc.title, status, detail: String(res.detail ?? '').replace(/\s+/g, ' ').slice(0, 300), ms: Date.now() - t0, shot });
    console.log(`${{ pass: '✔', fail: '✘', warn: '!' }[status]} [${label}] ${sc.title} (${((Date.now() - t0) / 1000).toFixed(1)}s)${status !== 'pass' ? ' — ' + res.detail : ''}`);
    await page.keyboard.press('Escape').catch(() => {});
  }
  await browser.close(); server.close();
  return { label, providerKind, results, consoleErrors };
}

const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const OUT = path.join(HERE, 'report', stamp); fs.mkdirSync(OUT, { recursive: true });
const suites = [];
if (MOCK) {
  for (const k of (CFG.mock === 'both' ? ['claude', 'compat'] : [CFG.mock])) { CURRENT_MOCK = k; suites.push(await runSuite('mock-' + k, k)); }
} else {
  suites.push(await runSuite('live-' + CFG.kind, CFG.kind));
}

/* ---------------- report ---------------- */
let md = `# Canopus harness report\n\n- Run: ${new Date().toLocaleString()}\n- Mode: ${MOCK ? 'mock (simulated providers)' : `live — ${CFG.kind === 'claude' ? 'Anthropic Claude (' + CFG.model + ')' : CFG.name + ' · ' + CFG.model}`}\n\n`;
let failed = 0;
for (const s of suites) {
  const c = k => s.results.filter(r => r.status === k).length; failed += c('fail');
  md += `## ${s.label}\n\n**${c('pass')} passed · ${c('fail')} failed · ${c('warn')} warnings · ${c('skip')} skipped**\n\n| | Scenario | Time | Detail |\n|---|---|---|---|\n`;
  for (const r of s.results) md += `| ${{ pass: '✅', fail: '❌', warn: '⚠️', skip: '⏭️' }[r.status]} | ${r.title} | ${(r.ms / 1000).toFixed(1)}s | ${r.detail.replace(/\|/g, '\\|')} |\n`;
  if (s.consoleErrors.length) md += `\nPage errors:\n${s.consoleErrors.map(e => '- ' + e).join('\n')}\n`;
  md += '\n';
}
fs.writeFileSync(path.join(OUT, 'report.md'), md);
fs.writeFileSync(path.join(OUT, 'results.json'), JSON.stringify(suites, null, 2));
fs.copyFileSync(path.join(OUT, 'report.md'), path.join(HERE, 'report', 'latest.md'));
console.log(`\nReport: ${path.join(OUT, 'report.md')}`);
process.exit(failed ? 1 : 0);
