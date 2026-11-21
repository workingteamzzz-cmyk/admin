// The AI engine: model registry (Claude + OpenAI), access rules, the Auto router, limits, failover,
// knowledge search tool, masking, and streaming. API keys never leave this process.
import fs from 'node:fs';
import path from 'node:path';
import Anthropic from '@anthropic-ai/sdk';
import { config, MODELS, HELPER_MODEL, EFFORT, EFFORT_OPENAI, PRICES, CATEGORIES, TIERS } from './config.mjs';
import { one, all, run, now, getSettings, audit, spentThisMonth, budgetFor, userGroups, groupSpent, monthStart, projectsFor } from './db.mjs';
import { search, extractDoc, sensitiveValues } from './knowledge.mjs';
import { Redactor, SYSTEM_NOTE } from './redact.mjs';
import { emitOnce } from './webhooks.mjs';
import { analystBlock, clientBlock } from './persona.mjs';

/* ================= clients ================= */
let anthropicClient, proxyFetch;
async function anthropic() {
  if (anthropicClient) return anthropicClient;
  const opts = { apiKey: config.apiKey, authToken: null, baseURL: config.anthropicBaseUrl, maxRetries: 1, timeout: 10 * 60e3 };
  if (config.outboundProxy) { const { ProxyAgent } = await import('undici'); opts.fetchOptions = { dispatcher: new ProxyAgent(config.outboundProxy) }; }
  return (anthropicClient = new Anthropic(opts));
}
async function httpFetch(url, opts) {
  if (!config.outboundProxy) return fetch(url, opts);
  if (!proxyFetch) { const u = await import('undici'); const agent = new u.ProxyAgent(config.outboundProxy); proxyFetch = (a, b) => u.fetch(a, { ...b, dispatcher: agent }); }
  return proxyFetch(url, opts);
}
export const providerReady = p => (p === 'anthropic' ? !!config.apiKey : p === 'openai' ? !!config.openaiKey : p === 'local' ? !!config.localBaseUrl : false);
const oaStyle = p => p === 'openai' || p === 'local'; // both speak the OpenAI chat format
const endpoint = p => (p === 'local' ? { base: config.localBaseUrl, key: config.localKey, name: 'the local AI server' } : { base: config.openaiBaseUrl, key: config.openaiKey, name: 'OpenAI' });

/* ================= model registry & access ================= */
export function allModels(settings = getSettings()) {
  const list = Object.values(MODELS).map(m => ({ ...m, price: PRICES[m.api] }));
  for (const m of settings.openaiModels || []) list.push({ id: m.id, provider: 'openai', tier: m.tier, label: m.label, api: m.api, d: `OpenAI · ${m.api}`, vision: !!m.vision, reasoning: !!m.reasoning,
    price: { in: +m.priceIn || 0, out: +m.priceOut || 0, cacheRead: m.priceCached === '' || m.priceCached == null ? +m.priceIn || 0 : +m.priceCached } });
  for (const m of settings.localModels || []) list.push({ id: m.id, provider: 'local', tier: m.tier, label: m.label, api: m.api, d: `On this server · ${m.api} · data never leaves`, vision: !!m.vision, reasoning: false, price: { in: 0, out: 0, cacheRead: 0 } });
  return list;
}
// Models a user may use: enabled by the admin, provider configured, and allowed by the user's groups.
export function modelsFor(user, settings = getSettings()) {
  let list = allModels(settings).filter(m => settings.models.includes(m.id) && providerReady(m.provider));
  if (user.role !== 'admin') {
    const groups = userGroups(user.id);
    const restricted = groups.length && groups.every(g => g.models);
    if (restricted) { const ok = new Set(groups.flatMap(g => JSON.parse(g.models || '[]'))); list = list.filter(m => ok.has(m.id)); }
  }
  return list;
}
const tierRank = t => TIERS.indexOf(t);
// Best allowed substitute for a model the user can't use: same tier first, then the nearest lower, then higher.
function substitute(want, allowed, needVision) {
  const pool = allowed.filter(m => !needVision || m.vision);
  if (!pool.length) return null;
  const exact = pool.find(m => m.id === want?.id); if (exact) return exact;
  const t = tierRank(want?.tier ?? 'standard');
  return [...pool].sort((a, b) => { const da = tierRank(a.tier) - t, db = tierRank(b.tier) - t; const sa = da <= 0 ? -da : 10 + da, sb = db <= 0 ? -db : 10 + db; return sa - sb || (a.provider === want?.provider ? -1 : 1); })[0];
}

/* ================= limits ================= */
const minuteHits = new Map();
export function limitProblem(user, settings = getSettings()) {
  const b = budgetFor(user);
  if (b > 0 && spentThisMonth(user.id) >= b) return { code: 'budget', message: `You have reached your monthly AI budget (${usd(b)}). Ask your administrator to raise it.` };
  for (const g of userGroups(user.id)) if (g.budget_usd > 0 && groupSpent(g.id) >= g.budget_usd) return { code: 'group_budget', message: `Your group “${g.name}” has used its monthly AI budget (${usd(g.budget_usd)}). Ask your administrator.` };
  const { perMinute, perDay } = settings.rateLimits;
  const t = now(); const hits = (minuteHits.get(user.id) || []).filter(x => t - x < 60e3);
  if (perMinute > 0 && hits.length >= perMinute) return { code: 'rate', message: `Too many requests — the limit is ${perMinute} per minute. Please wait a moment.` };
  if (perDay > 0 && one(`SELECT COUNT(*) c FROM chat_requests WHERE user_id=? AND ts>=?`, user.id, new Date().setHours(0, 0, 0, 0)).c >= perDay) return { code: 'rate', message: `You have reached today's limit of ${perDay} requests. It resets at midnight.` };
  return null;
}
function countRequest(user) { const t = now(); minuteHits.set(user.id, [...(minuteHits.get(user.id) || []).filter(x => t - x < 60e3), t]); run(`INSERT INTO chat_requests(user_id,ts) VALUES(?,?)`, user.id, t); }
const usd = n => '$' + (+n || 0).toFixed(2);

export function recordUsage(user, model, u, purpose) {
  const p = model.price || PRICES[model.api] || { in: 0, out: 0, cacheRead: 0 };
  const cost = ((u.input || 0) * p.in + (u.cacheWrite || 0) * p.in * 1.25 + (u.cacheRead || 0) * p.cacheRead + (u.output || 0) * p.out) / 1e6;
  run(`INSERT INTO usage(user_id,ts,model,input,output,cache_read,cache_write,cost,purpose,provider) VALUES(?,?,?,?,?,?,?,?,?,?)`, user.id, now(), model.api, u.input || 0, u.output || 0, u.cacheRead || 0, u.cacheWrite || 0, cost, purpose, model.provider);
  return cost;
}
function budgetNotices(user) {
  const month = new Date().toISOString().slice(0, 7); const b = budgetFor(user);
  if (b > 0) { const s = spentThisMonth(user.id); const pct = s / b;
    if (pct >= 1) emitOnce(`u:${user.id}:${month}:100`, 'budget.exhausted', { user: user.email, spent: +s.toFixed(4), budget: b });
    else if (pct >= 0.8) emitOnce(`u:${user.id}:${month}:80`, 'budget.warning', { user: user.email, spent: +s.toFixed(4), budget: b }); }
  for (const g of userGroups(user.id)) if (g.budget_usd > 0) { const s = groupSpent(g.id); const pct = s / g.budget_usd;
    if (pct >= 1) emitOnce(`g:${g.id}:${month}:100`, 'group_budget.exhausted', { group: g.name, spent: +s.toFixed(4), budget: g.budget_usd });
    else if (pct >= 0.8) emitOnce(`g:${g.id}:${month}:80`, 'group_budget.warning', { group: g.name, spent: +s.toFixed(4), budget: g.budget_usd }); }
}

/* ================= Auto router ================= */
const VISUAL_RE = /\b(dashboard|infogra(fis|phic)|canvas|chart|grafik|diagram|visuali[sz]|one-?pager|presentasi|presentation|slide|halaman (laporan|interaktif)|interactive (page|tool))/i;
const LIGHT_RE = /^\s*(hai|halo|hello|hi|hey|terima kasih|thanks|thank you|makasih|selamat (pagi|siang|sore|malam)|good (morning|afternoon|evening)|ok(e|ay)?|sip)\b[\s!.?]*$/i;
async function classify(user, text, hasFiles, settings, red) {
  if (settings.canvas && VISUAL_RE.test(text)) return { category: 'visual', reason: 'asks for a visual deliverable', how: 'rule' };
  if (LIGHT_RE.test(text) && !hasFiles) return { category: 'light', reason: 'short conversational message', how: 'rule' };
  // Ask the cheapest available model. The question is masked first.
  const prompt = `Classify the user's request into exactly one category:\n${Object.entries(CATEGORIES).map(([k, v]) => `- ${k}: ${v.d}`).join('\n')}\n${hasFiles ? 'The user attached files.\n' : ''}Reply with the category name only.`;
  const helper = allModels(settings).filter(m => providerReady(m.provider)).sort((a, b) => tierRank(a.tier) - tierRank(b.tier) || (a.provider === 'anthropic' ? -1 : 1))[0];
  if (!helper) return { category: 'writing', reason: 'default', how: 'default' };
  try {
    const out = await complete(user, helper.provider === 'anthropic' ? { ...helper, api: HELPER_MODEL, price: PRICES[HELPER_MODEL] } : helper, prompt, red.mask(text.slice(0, 1500)) || ' ', 'route', 400);
    const cat = (out.match(/\b(light|knowledge|writing|analysis|visual)\b/i)?.[1] || '').toLowerCase();
    if (CATEGORIES[cat]) return { category: cat, reason: CATEGORIES[cat].label.toLowerCase(), how: 'ai' };
  } catch (e) { console.warn('[router]', e.status || '', e.message); }
  return { category: 'writing', reason: 'default (classifier unavailable)', how: 'default' };
}
export async function chooseModel(user, requested, text, hasImages, hasFiles, settings, red) {
  const allowed = modelsFor(user, settings);
  if (!allowed.length) return { error: 'No AI model is available to you. Ask your administrator.' };
  if (requested && requested !== 'auto') {
    const m = allowed.find(x => x.id === requested);
    if (!m) return { error: 'You are not allowed to use that model. Choose another one or use Auto.' };
    if (hasImages && !m.vision) { const v = substitute(m, allowed, true); if (v) return { model: v, route: { auto: false, category: null, reason: `${m.label} cannot read images`, how: 'rule' } }; }
    return { model: m, route: null };
  }
  const c = await classify(user, text, hasFiles, settings, red);
  const want = allModels(settings).find(m => m.id === settings.routing.rules[c.category]) || allowed[0];
  const m = substitute(want, allowed, hasImages);
  if (!m) return { error: 'No available model can read images. Remove the image or ask your administrator.' };
  return { model: m, route: { auto: true, category: c.category, reason: c.reason, how: c.how, wanted: want.id !== m.id ? want.label : null } };
}
function failoverFor(model, user, settings, tried, needVision) {
  if (model.provider === 'local') return null; // never move a local conversation to a cloud provider
  const pool = modelsFor(user, settings).filter(m => !tried.has(m.id) && m.provider !== model.provider && m.provider !== 'local' && (!needVision || m.vision));
  return pool.sort((a, b) => Math.abs(tierRank(a.tier) - tierRank(model.tier)) - Math.abs(tierRank(b.tier) - tierRank(model.tier)))[0] || null;
}

/* ================= prompts & message building ================= */
const KNOWLEDGE_DESC = 'Search the organization’s internal knowledge base: policies, regulations, reports, program data, meeting notes and other documents this user is allowed to read. Use it whenever the question could be answered from internal documents, before relying on general knowledge. Use specific keywords in the documents’ language (usually Indonesian); search again with different keywords if the results are not relevant.';
const KNOWLEDGE_SCHEMA = { type: 'object', properties: { query: { type: 'string', description: 'Keywords to search for, e.g. "anggaran program makan bergizi 2026"' } }, required: ['query'], additionalProperties: false };

function systemPrompt(user, body, settings, useKnowledge, red, provider, project) {
  const s = body.system || {}; const clip = (t, n) => String(t || '').slice(0, n);
  const parts = [`You are Canopus, the AI workspace of this organization's communications team: a senior strategic communications consultant who is also a precise researcher and writer. You help with media monitoring, issue analysis, communication strategy, messaging, reports and everyday questions.

How you work, like a good consultant:
- Lead with the answer: the bottom line or recommendation first, then the reasoning.
- Ground it in evidence: data, coverage, internal documents; say what is fact, what is interpretation and what is assumption. Never invent figures, quotes or sources.
- Make it actionable: options with trade-offs, a clear recommendation, risks and how to mitigate them, and concrete next steps (what, who, when, how success is measured).
- Use frameworks when they help, without jargon: situation–complication–resolution, stakeholder mapping, message house, SWOT, risk likelihood × impact.
- When brainstorming, go wide first (many varied ideas), then narrow to the most promising with reasons.
- Ask one short clarifying question only when the request cannot be answered well without it; otherwise state your assumption and proceed.

Style: well-structured text with Markdown (headings, lists, tables) when it helps; short answers for simple questions. Reply in the language the user writes in — if they write in Indonesian, reply in formal, clear Indonesian.`];
  if (settings.canvas) parts.push(`Canvases: when the user asks for a visual deliverable — a report page, dashboard, infographic, one-pager, chart or small interactive tool — build it as ONE complete, self-contained HTML document (inline CSS and JS; Chart.js may be loaded from cdn.jsdelivr.net) inside a single \`\`\`html code block, with a descriptive <title>. Canvases run offline in a sandbox: do not fetch data from the network. Outside the block, add one or two sentences about what you built. When asked to change an existing canvas, output the complete updated HTML again with the same <title>.`);
  else parts.push(`Answer in text only. Do not produce HTML pages, dashboards or code for visualizations; when data would suit a chart, present it as a clear Markdown table instead.`);
  if (project) parts.push(`This chat uses the shared project "${clip(project.name, 100)}".${project.instructions ? `\n<project_instructions>\n${red.mask(clip(project.instructions, 20000))}\n</project_instructions>` : ''}`);
  if (useKnowledge) parts.push(`Internal knowledge: you have a search_knowledge tool over the organization's documents${project?.collections?.length ? ' (limited to this project\'s collections)' : body.scopeLabel ? ` (limited to: ${String(body.scopeLabel).slice(0, 200)})` : ''}. Table files are indexed row by row as "Column: value" lines, so search for names, record numbers or values directly. For questions about the organization, its programs, policies, data or documents, search first and base your answer on what you find. If the documents do not contain the answer, say so plainly instead of guessing; only then add general knowledge, clearly labelled as such. Never present information as coming from internal documents unless a search result supports it.${oaStyle(provider) ? ' Search results are numbered like [1], [2]. Cite them inline with the same number in square brackets right after the sentence that uses them, e.g. "... Rp71 triliun [1]." Only cite numbers that appear in the results.' : ''}`);
  if (red.enabled) parts.push(SYSTEM_NOTE);
  if (user.name?.trim()) parts.push(`The user's name is ${user.name.trim()}.`);
  const ap = analystBlock(user); if (ap) parts.push(ap);
  // When the chat is aimed at a client's space, that client's persona applies too.
  if (Array.isArray(body.scope) && body.scope.length) { try { const c = one(`SELECT * FROM clients WHERE collection_id=?`, String(body.scope[0])); if (c) parts.push(clientBlock(c)); } catch {} }
  if (s.instructions) parts.push(`<user_instructions>\n${red.mask(clip(s.instructions, 8000))}\n</user_instructions>`);
  if (s.spaceName) parts.push(`This chat is in the space "${clip(s.spaceName, 100)}".${s.spaceInstructions ? `\n<space_instructions>\n${red.mask(clip(s.spaceInstructions, 8000))}\n</space_instructions>` : ''}`);
  const skills = [...settings.orgSkills.filter(k => k.enabled !== false), ...(Array.isArray(s.skills) ? s.skills.slice(0, 20) : [])];
  if (skills.length) parts.push(`Skills — follow a skill's instructions whenever the request matches its purpose:\n<skills>\n${skills.map(k => `<skill name="${clip(k.name, 80).replace(/"/g, "'")}">\n${clip(k.content, 20000)}\n</skill>`).join('\n')}\n</skills>`);
  parts.push(`Today's date is ${new Date().toDateString()}.`);
  return parts.join('\n\n');
}

// Converts one stored user content block (text / file reference) into an Anthropic-style block.
async function resolveBlock(user, blk, red, settings, pdfNative) {
  if (blk?.type === 'text') return { type: 'text', text: red.mask(String(blk.text).slice(0, 200000)) || ' ' };
  if (blk?.type !== 'blob') return null;
  const b = one(`SELECT * FROM blobs WHERE id=? AND user_id=?`, String(blk.id), user.id);
  if (!b) return { type: 'text', text: '[Attachment no longer available]' };
  const buf = fs.readFileSync(path.join(config.dataDir, 'blobs', b.user_id, b.id));
  if (b.kind === 'image') {
    if (!settings.imageUploads) return { type: 'text', text: `[Image “${b.name}” omitted: image uploads are disabled]` };
    return { type: 'image', source: { type: 'base64', media_type: b.mime, data: buf.toString('base64') } };
  }
  if (b.kind === 'pdf' && pdfNative) return { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: buf.toString('base64') }, title: b.name };
  let text;
  try { const d = await extractDoc(buf, b.name, b.mime); red.addValues(d.sensitive); text = d.pages.map((t, i, a) => (a.length > 1 && !d.table ? `[Page ${i + 1}]\n${t}` : t)).join('\n\n'); }
  catch (e) { text = `[Could not read this file: ${e.message}]`; }
  return { type: 'document', source: { type: 'text', media_type: 'text/plain', data: red.mask(text) || ' ' }, title: b.name };
}
function finalText(provider, turn) {
  if (oaStyle(provider)) return turn.filter(m => m.role === 'assistant' && typeof m.content === 'string').map(m => m.content).join('');
  return turn.filter(m => m.role === 'assistant').flatMap(m => m.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
}
function remask(provider, m, red) {
  if (oaStyle(provider)) return m.role === 'tool' ? { ...m, content: red.mask(String(m.content)) } : m;
  if (m.role !== 'user' || !Array.isArray(m.content)) return m;
  return { ...m, content: m.content.map(b => b.type !== 'tool_result' || !Array.isArray(b.content) ? b : { ...b, content: b.content.map(c => c.type === 'search_result' ? { ...c, content: (c.content || []).map(t => ({ type: 'text', text: red.mask(t.text) })) } : c.type === 'text' ? { ...c, text: red.mask(c.text) } : c) }) };
}
// Builds the conversation in the target provider's format. Turns produced by the same provider are replayed
// unchanged (keeps Claude's thinking blocks valid); turns from the other provider become plain assistant text.
async function buildMessages(user, items, red, settings, provider) {
  const out = []; const pdfNative = provider === 'anthropic' && !red.enabled;
  const pushUser = blocks => { if (out.length && out.at(-1).role === 'user' && Array.isArray(out.at(-1).content)) out.at(-1).content.push(...blocks); else out.push({ role: 'user', content: blocks }); };
  for (const it of items) {
    if (it.role === 'user') {
      const blocks = (await Promise.all((it.content || []).map(b => resolveBlock(user, b, red, settings, pdfNative)))).filter(Boolean);
      blocks.sort((a, b) => (a.type === 'text') - (b.type === 'text'));
      if (blocks.length) pushUser(blocks);
    } else if (it.role === 'turn' && Array.isArray(it.messages) && it.messages.length) {
      if (it.provider === provider) for (const m of it.messages) { if (provider === 'anthropic' && m.role === 'user') pushUser(remask(provider, m, red).content); else out.push(remask(provider, m, red)); }
      else { const t = finalText(it.provider, it.messages); if (t) out.push({ role: 'assistant', content: oaStyle(provider) ? t : [{ type: 'text', text: t }] }); }
    }
  }
  if (!oaStyle(provider)) return out;
  // Anthropic-style user blocks → OpenAI chat parts.
  return out.map(m => {
    if (m.role !== 'user' || !Array.isArray(m.content)) return m;
    const parts = m.content.map(b => b.type === 'image' ? { type: 'image_url', image_url: { url: `data:${b.source.media_type};base64,${b.source.data}` } }
      : b.type === 'document' ? { type: 'text', text: `<document name="${b.title || 'file'}">\n${b.source.data}\n</document>` } : { type: 'text', text: b.text });
    return { role: 'user', content: parts.every(p => p.type === 'text') ? parts.map(p => p.text).join('\n\n') : parts };
  });
}

/* ================= providers ================= */
async function runAnthropic({ model, system, messages, useKnowledge, useWeb, mode, emit, signal, doSearch }) {
  if (model.provider !== 'anthropic') throw new Error('Internal routing error: non-Claude model sent to the Claude API');
  const tools = [];
  if (useKnowledge) tools.push({ name: 'search_knowledge', description: KNOWLEDGE_DESC, input_schema: KNOWLEDGE_SCHEMA, strict: true, eager_input_streaming: true });
  if (useWeb && model.search) tools.push({ type: model.search, name: 'web_search', max_uses: 5 });
  const params = { model: model.api, max_tokens: 64000, system, thinking: { type: 'adaptive', display: 'summarized' }, output_config: { effort: EFFORT[mode] || 'medium' }, cache_control: { type: 'ephemeral' }, ...(tools.length ? { tools } : {}) };
  if (model.fallback) { params.betas = ['server-side-fallback-2026-07-01']; params.fallbacks = 'default'; }
  const api = await anthropic(); const turn = []; const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }; const cites = [];
  let paused = false, stop = null, searches = 0;
  for (let step = 0; step < 10; step++) {
    const stream = api.beta.messages.stream({ ...params, messages: [...messages, ...turn] });
    signal.onabort = () => stream.abort();
    for await (const ev of stream) {
      if (ev.type === 'content_block_start') { const b = ev.content_block;
        if (b.type === 'server_tool_use') emit({ t: 'status', d: 'Searching the web…' });
        else if (b.type === 'tool_use') emit({ t: 'status', d: 'Searching internal knowledge…' });
        else if (b.type === 'text') emit({ t: 'status', d: '' }); }
      else if (ev.type === 'content_block_delta') {
        if (ev.delta.type === 'text_delta') emit({ t: 'text', d: ev.delta.text });
        else if (ev.delta.type === 'thinking_delta') emit({ t: 'thinking', d: ev.delta.thinking }); }
    }
    const fin = await stream.finalMessage();
    const u = fin.usage || {}; usage.input += u.input_tokens || 0; usage.output += u.output_tokens || 0; usage.cacheRead += u.cache_read_input_tokens || 0; usage.cacheWrite += u.cache_creation_input_tokens || 0;
    if (paused && turn.at(-1)?.role === 'assistant') turn.at(-1).content.push(...fin.content); else turn.push({ role: 'assistant', content: fin.content });
    paused = false;
    for (const b of fin.content) if (b.type === 'text') for (const c of b.citations || []) {
      if (c.type === 'search_result_location') cites.push({ kind: 'doc', source: c.source, title: c.title, text: c.cited_text });
      else if (c.type === 'web_search_result_location') cites.push({ kind: 'web', url: c.url, title: c.title, text: c.cited_text }); }
    stop = fin.stop_reason;
    if (stop === 'pause_turn') { paused = true; continue; }
    if (stop !== 'tool_use') break;
    const results = [];
    for (const b of fin.content.filter(b => b.type === 'tool_use')) {
      if (b.name !== 'search_knowledge' || typeof b.input?.query !== 'string' || !b.input.query.trim()) { results.push({ type: 'tool_result', tool_use_id: b.id, is_error: true, content: 'Invalid tool call: provide a non-empty "query" string.' }); continue; }
      if (++searches > 6) { results.push({ type: 'tool_result', tool_use_id: b.id, is_error: true, content: 'Search limit reached for this answer. Answer with what you have.' }); continue; }
      const hits = doSearch(b.input.query).filter(h => !h.localOnly); // defence in depth: on-premise passages never go to a cloud API
      results.push({ type: 'tool_result', tool_use_id: b.id, content: hits.length
        ? hits.map(h => ({ type: 'search_result', source: h.source, title: h.label, content: [{ type: 'text', text: h.masked }], citations: { enabled: true } }))
        : [{ type: 'text', text: 'No matching passages in the internal knowledge base for this query.' }] });
    }
    turn.push({ role: 'user', content: results });
  }
  return { turn, text: finalText('anthropic', turn), cites, usage, stop };
}

async function runOpenAI({ model, system, messages, useKnowledge, mode, emit, signal, doSearch }) {
  const turn = []; const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }; const sources = []; let stop = null, searches = 0;
  const tools = useKnowledge ? [{ type: 'function', function: { name: 'search_knowledge', description: KNOWLEDGE_DESC, parameters: KNOWLEDGE_SCHEMA, strict: true } }] : null;
  for (let step = 0; step < 8; step++) {
    const body = { model: model.api, messages: [{ role: 'system', content: system }, ...messages, ...turn], stream: true, stream_options: { include_usage: true }, ...(tools ? { tools } : {}), ...(model.reasoning ? { reasoning_effort: EFFORT_OPENAI[mode] || 'medium' } : {}) };
    const ep = endpoint(model.provider); const fetcher = model.provider === 'local' ? fetch : httpFetch; // local server: no outbound proxy
    const res = await fetcher(ep.base + '/chat/completions', { method: 'POST', signal, headers: { 'content-type': 'application/json', authorization: 'Bearer ' + ep.key }, body: JSON.stringify(body) });
    if (!res.ok) { let msg = ''; try { const j = await res.json(); msg = j.error?.message || JSON.stringify(j).slice(0, 300); } catch {} throw Object.assign(new Error(msg || 'HTTP ' + res.status), { status: res.status, provider: model.provider }); }
    const reader = res.body.getReader(); const dec = new TextDecoder(); let buf = '', text = '', finish = null; const calls = [];
    outer: while (true) {
      const { done, value } = await reader.read(); if (done) break;
      buf += dec.decode(value, { stream: true }); let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
        if (!line.startsWith('data:')) continue; const data = line.slice(5).trim(); if (data === '[DONE]') break outer;
        let j; try { j = JSON.parse(data); } catch { continue; }
        if (j.error) throw Object.assign(new Error(j.error.message || 'OpenAI error'), { status: 502, provider: 'openai' });
        if (j.usage) { const cached = j.usage.prompt_tokens_details?.cached_tokens || 0; usage.input += (j.usage.prompt_tokens || 0) - cached; usage.cacheRead += cached; usage.output += j.usage.completion_tokens || 0; }
        const ch = j.choices?.[0]; if (!ch) continue; const d = ch.delta || {};
        if (d.content) { text += d.content; emit({ t: 'text', d: d.content }); }
        if (typeof d.reasoning_content === 'string') emit({ t: 'thinking', d: d.reasoning_content });
        for (const tc of d.tool_calls || []) { const c = calls[tc.index] ||= { id: '', name: '', args: '' }; if (tc.id) c.id = tc.id; if (tc.function?.name) c.name += tc.function.name; if (tc.function?.arguments) c.args += tc.function.arguments; if (c.name === 'search_knowledge') emit({ t: 'status', d: 'Searching internal knowledge…' }); }
        if (ch.finish_reason) finish = ch.finish_reason;
      }
    }
    const real = calls.filter(Boolean);
    turn.push({ role: 'assistant', content: text || null, ...(real.length ? { tool_calls: real.map(c => ({ id: c.id, type: 'function', function: { name: c.name, arguments: c.args } })) } : {}) });
    stop = finish;
    if (finish !== 'tool_calls' || !real.length) break;
    for (const c of real) {
      let q = null; try { q = JSON.parse(c.args).query; } catch {}
      if (c.name !== 'search_knowledge' || typeof q !== 'string' || !q.trim()) { turn.push({ role: 'tool', tool_call_id: c.id, content: 'Invalid tool call: provide a non-empty "query" string.' }); continue; }
      if (++searches > 6) { turn.push({ role: 'tool', tool_call_id: c.id, content: 'Search limit reached for this answer. Answer with what you have.' }); continue; }
      const hits = doSearch(q).filter(h => model.provider === 'local' || !h.localOnly); // on-premise passages only to the local model
      const lines = hits.map(h => { sources.push(h); return `[${sources.length}] ${h.label}\n${h.masked}`; });
      turn.push({ role: 'tool', tool_call_id: c.id, content: lines.length ? lines.join('\n\n') : 'No matching passages in the internal knowledge base for this query.' });
    }
  }
  const text = finalText('openai', turn);
  const used = [...new Set([...text.matchAll(/\[(\d{1,2})\]/g)].map(m => +m[1]))].filter(n => sources[n - 1]);
  const cites = used.map(n => ({ kind: 'doc', n, source: sources[n - 1].source, title: sources[n - 1].label, text: sources[n - 1].masked }));
  return { turn, text, cites, usage, stop: stop === 'tool_calls' ? 'end_turn' : stop === 'length' ? 'max_tokens' : stop === 'content_filter' ? 'refusal' : 'end_turn' };
}

// Short non-streaming completion (titles, prompt polishing, routing).
export async function complete(user, model, system, text, purpose, maxTokens = 1024, effort = 'low') {
  if (oaStyle(model.provider)) {
    const ep = endpoint(model.provider);
    const res = await (model.provider === 'local' ? fetch : httpFetch)(ep.base + '/chat/completions', { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + ep.key }, body: JSON.stringify({ model: model.api, messages: [{ role: 'system', content: system }, { role: 'user', content: text }] }), signal: AbortSignal.timeout(maxTokens > 4096 ? 300e3 : 60e3) });
    if (!res.ok) throw Object.assign(new Error('HTTP ' + res.status), { status: res.status });
    const j = await res.json(); const u = j.usage || {};
    recordUsage(user, model, { input: u.prompt_tokens, output: u.completion_tokens }, purpose);
    return (j.choices?.[0]?.message?.content || '').trim();
  }
  const r = await (await anthropic()).messages.create({ model: model.api, max_tokens: maxTokens, output_config: { effort }, system, messages: [{ role: 'user', content: text }] });
  const u = r.usage || {}; recordUsage(user, model, { input: u.input_tokens, output: u.output_tokens, cacheRead: u.cache_read_input_tokens, cacheWrite: u.cache_creation_input_tokens }, purpose);
  return r.content.filter(b => b.type === 'text').map(b => b.text).join('').trim();
}

/* ================= the chat orchestrator ================= */
// emit(event) receives: route, status, thinking, text, sources, done, error. Returns the final result.
export async function converse(user, body, emit, signal, ip) {
  const settings = getSettings();
  const fail = (message, code) => { emit({ t: 'error', message, code }); return { error: message, code }; };
  const limit = limitProblem(user, settings); if (limit) return fail(limit.message, limit.code);
  const red = new Redactor({ userId: user.id, chatId: body.chatId, enabled: settings.redaction.enabled, terms: settings.redaction.terms, values: settings.redaction.enabled ? sensitiveValues() : [] });
  const items = Array.isArray(body.messages) ? body.messages : [];
  const project = body.projectId ? projectsFor(user).find(p => p.id === body.projectId) : null;
  if (body.projectId && !project) return fail('You do not have access to this project.', 'project');
  const lastUser = [...items].reverse().find(i => i.role === 'user');
  if (!lastUser) return fail('Nothing to send.');
  const lastText = (lastUser.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n');
  const blobKinds = (lastUser.content || []).filter(b => b.type === 'blob').map(b => one(`SELECT kind FROM blobs WHERE id=? AND user_id=?`, String(b.id), user.id)?.kind);
  const anyImages = items.some(i => i.role === 'user' && (i.content || []).some(b => b.type === 'blob' && one(`SELECT kind FROM blobs WHERE id=? AND user_id=?`, String(b.id), user.id)?.kind === 'image'));
  const requested = project && project.model !== 'auto' && (!body.model || body.model === 'auto') ? project.model : body.model;
  // A conversation that already used a local model (and so possibly local-only knowledge) stays on local models.
  const lockedLocal = items.some(i => i.role === 'turn' && i.provider === 'local');
  let pick;
  if (lockedLocal) {
    const locals = modelsFor(user, settings).filter(m => m.provider === 'local');
    const m = locals.find(x => x.id === requested) || locals[0];
    if (!m) return fail('This conversation used confidential on-premise knowledge, so it can only continue with the local AI model, which is not available right now.', 'model');
    if (requested && requested !== 'auto' && requested !== m.id) emit({ t: 'status', d: 'This conversation stays on the local model to keep on-premise data inside the server.' });
    pick = { model: m, route: { auto: false, reason: 'conversation contains on-premise knowledge', how: 'rule', locked: true } };
  } else pick = await chooseModel(user, requested, lastText, anyImages, blobKinds.length > 0, settings, red);
  if (pick.error) return fail(pick.error, 'model');
  countRequest(user);
  const useKnowledge = body.knowledge !== false; const useWeb = !!body.web && settings.webSearch; let model;
  // Optional knowledge scope chosen in the composer: everything (default), or specific spaces (team, a person, a client).
  const scope = Array.isArray(body.scope) && body.scope.length ? body.scope.map(String).slice(0, 20) : null;
  const doSearch = q => {
    const query = red.unmask(q).slice(0, 300); const hits = search(user, query, { collections: project?.collections?.length ? project.collections : scope, includeLocalOnly: model.provider === 'local' });
    audit(user.id, 'knowledge.search', { query: red.mask(query), project: project?.name, results: hits.map(h => ({ doc: h.docId, page: h.page })) }, ip);
    emit({ t: 'status', d: `Found ${hits.length} passage${hits.length === 1 ? '' : 's'} in internal knowledge` });
    emit({ t: 'sources', d: hits.map(h => ({ title: h.title, page: h.page, collection: h.collection, docId: h.docId, text: h.text.slice(0, 600) })) });
    return hits.map(h => ({ ...h, source: `canopus:doc/${h.docId}${h.page ? '#page=' + h.page : ''}`, label: `${h.title}${h.page ? ' — page ' + h.page : ''} (${h.collection})`, masked: red.mask(h.text) }));
  };

  model = pick.model; let route = pick.route; const tried = new Set();
  for (let attempt = 0; attempt < 2; attempt++) {
    tried.add(model.id);
    emit({ t: 'route', model: { id: model.id, label: model.label, provider: model.provider }, route });
    let streamed = false; const relay = ev => { if (ev.t === 'text' || ev.t === 'thinking') streamed = true; emit(ev); };
    const unmask = red.streamUnmasker(); let display = '';
    const out = ev => { if (ev.t === 'text') { const d = unmask.push(ev.d); if (d) { display += d; relay({ t: 'text', d }); } } else if (ev.t === 'thinking') relay({ t: 'thinking', d: red.unmask(ev.d) }); else relay(ev); };
    try {
      const messages = await buildMessages(user, items, red, settings, model.provider);
      if (!messages.length || messages.at(-1).role !== 'user') return fail('Nothing to send.');
      const system = systemPrompt(user, body, settings, useKnowledge, red, model.provider, project);
      const run_ = model.provider === 'anthropic' ? runAnthropic : oaStyle(model.provider) ? runOpenAI : null;
      if (!run_) return fail('Unknown model provider.', 'model');
      const r = await run_({ model, system, messages, useKnowledge, useWeb, mode: body.mode, emit: out, signal, doSearch });
      const tail = unmask.flush(); if (tail) { display += tail; emit({ t: 'text', d: tail }); }
      const cost = recordUsage(user, model, r.usage, 'chat');
      if (red.count) audit(user.id, 'redaction.applied', { chat: red.chatId, count: red.count }, ip);
      budgetNotices(user);
      const citations = [...new Map(r.cites.map(c => [(c.url || c.source) + '|' + (c.text || '').slice(0, 40), { ...c, title: red.unmask(c.title || c.url || ''), text: red.unmask(c.text || '').slice(0, 800) }])).values()];
      const result = { t: 'done', provider: model.provider, model: { id: model.id, label: model.label }, route, turn: r.turn, display, citations, usage: { in: r.usage.input + r.usage.cacheRead + r.usage.cacheWrite, out: r.usage.output, cost }, stop: r.stop };
      emit(result); return result;
    } catch (e) {
      if (signal.aborted) return { aborted: true };
      const status = e.status || 0;
      console.error(`[${model.provider}]`, status, e.message);
      const transient = !status || status === 429 || status >= 500;
      const alt = settings.routing.failover && transient && !streamed ? failoverFor(model, user, settings, tried, anyImages) : null;
      if (alt) {
        audit(user.id, 'ai.failover', { from: model.api, to: alt.api, status }, ip);
        emit({ t: 'status', d: `${model.label} is unavailable — switching to ${alt.label}…` });
        route = { ...(route || {}), failover: { from: model.label, reason: status ? `HTTP ${status}` : 'connection error' } };
        model = alt; continue;
      }
      const who = model.provider === 'openai' ? 'OpenAI' : model.provider === 'local' ? 'The local AI server' : 'Anthropic';
      const msg = status === 401 ? `The server’s ${who} API key was rejected. Ask the administrator.`
        : status === 429 ? `${who} is rate-limiting requests right now. Try again in a moment.`
        : status >= 500 ? `${who} is busy or unavailable. Please try again shortly.`
        : status === 400 ? `${who} rejected the request: ${e.error?.error?.message || e.message}`
        : status === 404 ? `Model not available at ${who}: ${e.error?.error?.message || e.message}`
        : `Could not reach ${who}. ${e.message || ''}`;
      return fail(msg, status || 'network');
    }
  }
}

export async function quick(user, purpose, text, chatId) {
  const settings = getSettings();
  const lim = limitProblem(user, settings); if (lim && lim.code !== 'rate') throw Object.assign(new Error(lim.message), { status: 402 });
  const red = new Redactor({ userId: user.id, chatId: chatId || 'quick', enabled: settings.redaction.enabled, terms: settings.redaction.terms, values: settings.redaction.enabled ? sensitiveValues() : [] });
  const helper = modelsFor(user, settings).sort((a, b) => tierRank(a.tier) - tierRank(b.tier) || (a.provider === 'anthropic' ? -1 : 1))[0];
  if (!helper) throw Object.assign(new Error('No AI model available'), { status: 503 });
  const model = helper.provider === 'anthropic' ? { ...helper, api: HELPER_MODEL, price: PRICES[HELPER_MODEL] } : helper;
  const system = purpose === 'title'
    ? 'Write a short, specific title (2–6 words) for a conversation that starts with the message below. Use the same language as the message. Reply with the title only — no quotes, no trailing punctuation.'
    : 'You improve prompts for an AI assistant. Rewrite the user\'s prompt so it is clear, specific and well-structured: state the goal, relevant context, and the desired output format. Keep the user\'s intent and language, and keep any placeholders like ⟦NAME_1⟧ exactly. Do not answer the prompt. Reply with the improved prompt only.';
  const out = await complete(user, model, system, red.mask(String(text).slice(0, purpose === 'title' ? 1500 : 8000)) || ' ', purpose, purpose === 'title' ? 512 : 2048);
  return red.unmask(out);
}

// Model for report work: the one the user picked, else the model the admin's routing rule names for this kind of task.
export function reportModel(user, requested, rule = 'writing') {
  const settings = getSettings(); const allowed = modelsFor(user, settings);
  if (!allowed.length) throw Object.assign(new Error('No AI model is available to you. Ask your administrator.'), { status: 503 });
  if (requested && requested !== 'auto') { const m = allowed.find(x => x.id === requested); if (!m) throw Object.assign(new Error('You are not allowed to use that model.'), { status: 403 }); return m; }
  const want = allModels(settings).find(m => m.id === settings.routing.rules[rule]) || allowed[0];
  return substitute(want, allowed, false);
}
// The cheapest model the user may use (for bulk labelling).
export function helperModel(user) {
  const helper = modelsFor(user).sort((a, b) => tierRank(a.tier) - tierRank(b.tier) || (a.provider === 'anthropic' ? -1 : 1))[0];
  if (!helper) throw Object.assign(new Error('No AI model available'), { status: 503 });
  return helper.provider === 'anthropic' ? { ...helper, api: HELPER_MODEL, price: PRICES[HELPER_MODEL] } : helper;
}

export async function listOpenAIModels() {
  if (!config.openaiKey) throw Object.assign(new Error('OPENAI_API_KEY is not set on the server'), { status: 400 });
  const r = await httpFetch(config.openaiBaseUrl + '/models', { headers: { authorization: 'Bearer ' + config.openaiKey }, signal: AbortSignal.timeout(20e3) });
  if (!r.ok) throw Object.assign(new Error('OpenAI returned HTTP ' + r.status), { status: 502 });
  const j = await r.json(); return (j.data || []).map(m => m.id).sort();
}
export { monthStart };
