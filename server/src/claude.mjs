// Talks to the Claude API on behalf of signed-in users. The API key never leaves this process.
import fs from 'node:fs';
import path from 'node:path';
import Anthropic from '@anthropic-ai/sdk';
import { config, MODELS, HELPER_MODEL, EFFORT, PRICES } from './config.mjs';
import { one, run, now, getSettings, audit, spentThisMonth, budgetFor } from './db.mjs';
import { search, extractText } from './knowledge.mjs';
import { Redactor, SYSTEM_NOTE } from './redact.mjs';

let client;
export async function claude() {
  if (client) return client;
  const opts = { apiKey: config.apiKey, authToken: null, baseURL: config.anthropicBaseUrl, maxRetries: 2, timeout: 10 * 60e3 };
  if (config.outboundProxy) { const { ProxyAgent } = await import('undici'); opts.fetchOptions = { dispatcher: new ProxyAgent(config.outboundProxy) }; }
  client = new Anthropic(opts);
  return client;
}

/* ---------- usage & budget ---------- */
export function recordUsage(userId, model, u = {}, purpose = 'chat') {
  const p = PRICES[model] || PRICES['claude-sonnet-5-5'];
  const input = u.input_tokens || 0, output = u.output_tokens || 0, cr = u.cache_read_input_tokens || 0, cw = u.cache_creation_input_tokens || 0;
  const cost = (input * p.in + cw * p.in * 1.25 + cr * p.cacheRead + output * p.out) / 1e6;
  run(`INSERT INTO usage(user_id,ts,model,input,output,cache_read,cache_write,cost,purpose) VALUES(?,?,?,?,?,?,?,?,?)`, userId, now(), model, input, output, cr, cw, cost, purpose);
  return { in: input + cr + cw, out: output, cost };
}
export function overBudget(user) { const b = budgetFor(user); return b > 0 && spentThisMonth(user.id) >= b; }

/* ---------- message building ---------- */
function blobPath(b) { return path.join(config.dataDir, 'blobs', b.user_id, b.id); }
async function resolveBlock(user, blk, red, settings) {
  if (blk?.type === 'text') return { type: 'text', text: red.mask(String(blk.text).slice(0, 200000)) || ' ' };
  if (blk?.type !== 'blob') return null;
  const b = one(`SELECT * FROM blobs WHERE id=? AND user_id=?`, String(blk.id), user.id);
  if (!b) return { type: 'text', text: `[Attachment no longer available]` };
  const buf = fs.readFileSync(blobPath(b));
  if (b.kind === 'image') {
    if (!settings.imageUploads) return { type: 'text', text: `[Image “${b.name}” omitted: image uploads are disabled by the administrator]` };
    return { type: 'image', source: { type: 'base64', media_type: b.mime, data: buf.toString('base64') } };
  }
  if (b.kind === 'pdf' && !red.enabled) return { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: buf.toString('base64') }, title: b.name };
  if (b.kind === 'pdf' || b.kind === 'docx' || b.kind === 'text') {
    let text;
    try { text = (await extractText(buf, b.name, b.mime)).map((t, i, a) => a.length > 1 ? `[Page ${i + 1}]\n${t}` : t).join('\n\n'); }
    catch (e) { text = `[Could not read this file: ${e.message}]`; }
    return { type: 'document', source: { type: 'text', media_type: 'text/plain', data: red.mask(text) || ' ' }, title: b.name };
  }
  return { type: 'text', text: `[Attachment “${b.name}” is not a supported type]` };
}
// Tool results come back from the browser on later turns; mask them again so a modified client cannot bypass redaction.
function remaskToolResult(b, red) {
  if (b.type !== 'tool_result' || !Array.isArray(b.content)) return b;
  return { ...b, content: b.content.map(c => c.type === 'search_result' ? { ...c, content: (c.content || []).map(t => ({ type: 'text', text: red.mask(t.text) })) } : c.type === 'text' ? { ...c, text: red.mask(c.text) } : c) };
}
// Client sends: user messages with text/blob blocks, and assistant "turns" exactly as this server produced them.
async function buildMessages(user, msgs, red, settings) {
  const out = [];
  for (const m of msgs) {
    if (m.role === 'user' && Array.isArray(m.content) && m.content.some(b => b.type === 'tool_result')) { out.push({ role: 'user', content: m.content.map(b => remaskToolResult(b, red)) }); continue; }
    if (m.role === 'user') {
      const blocks = (await Promise.all((m.content || []).map(b => resolveBlock(user, b, red, settings)))).filter(Boolean);
      blocks.sort((a, b) => (a.type === 'text') - (b.type === 'text')); // documents before the question
      if (!blocks.length) continue;
      if (out.length && out.at(-1).role === 'user') out.at(-1).content.push(...blocks); // e.g. after a failed reply, or after tool results
      else out.push({ role: 'user', content: blocks });
    } else if (m.role === 'assistant' && Array.isArray(m.content) && m.content.length) {
      out.push({ role: 'assistant', content: m.content }); // unchanged: thinking blocks must be replayed as produced
    }
  }
  return out;
}

const KNOWLEDGE_TOOL = {
  name: 'search_knowledge',
  description: 'Search the organization’s internal knowledge base: policies, regulations, reports, program data, meeting notes and other documents this user is allowed to read. Use it whenever the question could be answered from internal documents, before relying on general knowledge. Use specific keywords in the documents’ language (usually Indonesian); call it again with different keywords if the first results are not relevant.',
  input_schema: { type: 'object', properties: { query: { type: 'string', description: 'Keywords to search for, e.g. "anggaran program makan bergizi 2026"' } }, required: ['query'], additionalProperties: false },
  strict: true,
  eager_input_streaming: true,
};

function systemPrompt(user, body, settings, useKnowledge, red) {
  const s = body.system || {};
  const clip = (t, n) => String(t || '').slice(0, n);
  const parts = [
`You are Canopus, the AI assistant of this organization: capable, warm and precise, for research, writing, analysis, planning and document work.

Style: answer directly. Use Markdown (headings, lists, tables) when it helps; keep simple answers short. Reply in the language the user writes in — if they write in Indonesian, reply in Indonesian.

Canvases: when the user asks for a visual deliverable — a report page, dashboard, infographic, one-pager, chart or small interactive tool — build it as ONE complete, self-contained HTML document (inline CSS and JS; Chart.js may be loaded from cdn.jsdelivr.net) inside a single \`\`\`html code block, with a descriptive <title>. Canvases run offline in a sandbox: do not fetch data from the network. Outside the block, add one or two sentences about what you built. When asked to change an existing canvas, output the complete updated HTML again with the same <title>.`];
  if (useKnowledge) parts.push(`Internal knowledge: you have a search_knowledge tool over the organization's documents. For questions about the organization, its programs, policies, data or documents, search first and base your answer on what you find, citing it. If the documents do not contain the answer, say so plainly instead of guessing, and only then add general knowledge, clearly labelled as such. Never present information as coming from internal documents unless a search result supports it.`);
  if (red.enabled) parts.push(SYSTEM_NOTE);
  const name = user.name?.trim(); if (name) parts.push(`The user's name is ${name}.`);
  if (s.instructions) parts.push(`<user_instructions>\n${red.mask(clip(s.instructions, 8000))}\n</user_instructions>`);
  if (s.spaceName) parts.push(`This chat is in the space "${clip(s.spaceName, 100)}".${s.spaceInstructions ? `\n<space_instructions>\n${red.mask(clip(s.spaceInstructions, 8000))}\n</space_instructions>` : ''}`);
  const skills = [...settings.orgSkills.filter(k => k.enabled !== false), ...(Array.isArray(s.skills) ? s.skills.slice(0, 20) : [])];
  if (skills.length) parts.push(`Skills — follow a skill's instructions whenever the request matches its purpose:\n<skills>\n${skills.map(k => `<skill name="${clip(k.name, 80).replace(/"/g, "'")}">\n${clip(k.content, 20000)}\n</skill>`).join('\n')}\n</skills>`);
  parts.push(`Today's date is ${new Date().toDateString()}.`);
  return parts.join('\n\n');
}

/* ---------- chat (Server-Sent Events) ---------- */
export async function chat(req, res, user, body, ip) {
  const settings = getSettings();
  const send = ev => { if (!res.writableEnded) res.write(`data: ${JSON.stringify(ev)}\n\n`); };
  res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache, no-transform', 'x-accel-buffering': 'no' });
  const fail = (message, code) => { send({ t: 'error', message, code }); res.end(); };

  if (!config.apiKey) return fail('The server has no Anthropic API key configured. Ask the administrator.', 'config');
  if (overBudget(user)) return fail(`You have reached your monthly AI budget ($${budgetFor(user)}). Ask the administrator to raise it.`, 'budget');
  const M = MODELS[body.model] && settings.models.includes(body.model) ? MODELS[body.model] : MODELS[settings.defaultModel] || MODELS.core;
  const useKnowledge = body.knowledge !== false;
  const useWeb = !!body.web && settings.webSearch;
  const red = new Redactor({ userId: user.id, chatId: body.chatId, enabled: settings.redaction.enabled, terms: settings.redaction.terms });

  let messages;
  try { messages = await buildMessages(user, Array.isArray(body.messages) ? body.messages : [], red, settings); }
  catch (e) { return fail('Could not prepare the conversation: ' + e.message); }
  if (!messages.length || messages.at(-1).role !== 'user') return fail('Nothing to send.');

  const tools = [];
  if (useKnowledge) tools.push(KNOWLEDGE_TOOL);
  if (useWeb) tools.push({ type: M.search, name: 'web_search', max_uses: 5 });
  const params = {
    model: M.api, max_tokens: 64000, system: systemPrompt(user, body, settings, useKnowledge, red),
    thinking: { type: 'adaptive', display: 'summarized' }, output_config: { effort: EFFORT[body.mode] || 'medium' },
    cache_control: { type: 'ephemeral' }, ...(tools.length ? { tools } : {}),
  };
  if (M.fallback) { params.betas = ['server-side-fallback-2026-07-01']; params.fallbacks = 'default'; }

  const api = await claude();
  const turn = []; const citations = []; const totals = { in: 0, out: 0, cost: 0 };
  const unmask = red.streamUnmasker(); let display = ''; let stop = null; let searches = 0;
  let aborted = false; let current = null; let paused = false;
  res.on('close', () => { if (!res.writableFinished) { aborted = true; current?.abort(); } });

  try {
    for (let step = 0; step < 10 && !aborted; step++) {
      current = api.beta.messages.stream({ ...params, messages: [...messages, ...turn] });
      for await (const ev of current) {
        if (ev.type === 'content_block_start') {
          const b = ev.content_block;
          if (b.type === 'server_tool_use') send({ t: 'status', d: 'Searching the web…' });
          else if (b.type === 'tool_use' && b.name === 'search_knowledge') send({ t: 'status', d: 'Searching internal knowledge…' });
          else if (b.type === 'text') send({ t: 'status', d: '' });
        } else if (ev.type === 'content_block_delta') {
          if (ev.delta.type === 'text_delta') { const d = unmask.push(ev.delta.text); if (d) { display += d; send({ t: 'text', d }); } }
          else if (ev.delta.type === 'thinking_delta') send({ t: 'thinking', d: red.unmask(ev.delta.thinking) });
        }
      }
      const fin = await current.finalMessage();
      const u = recordUsage(user.id, M.api, fin.usage, 'chat'); totals.in += u.in; totals.out += u.out; totals.cost += u.cost;
      if (paused && turn.at(-1)?.role === 'assistant') turn.at(-1).content.push(...fin.content); else turn.push({ role: 'assistant', content: fin.content });
      paused = false;
      for (const b of fin.content) if (b.type === 'text') for (const c of b.citations || []) citations.push(c);
      stop = fin.stop_reason;
      if (stop === 'pause_turn') { paused = true; continue; }
      if (stop !== 'tool_use') break;
      const results = [];
      for (const b of fin.content.filter(b => b.type === 'tool_use')) {
        if (b.name !== 'search_knowledge' || typeof b.input?.query !== 'string' || !b.input.query.trim()) {
          results.push({ type: 'tool_result', tool_use_id: b.id, is_error: true, content: 'Invalid tool call: provide a non-empty "query" string.' }); continue;
        }
        if (++searches > 6) { results.push({ type: 'tool_result', tool_use_id: b.id, is_error: true, content: 'Search limit reached for this answer. Answer with what you have.' }); continue; }
        const query = red.unmask(b.input.query).slice(0, 300);
        const hits = search(user, query);
        audit(user.id, 'knowledge.search', { query: red.mask(query), results: hits.map(h => ({ doc: h.docId, page: h.page })) }, ip);
        send({ t: 'status', d: `Found ${hits.length} passage${hits.length === 1 ? '' : 's'} in internal knowledge` });
        send({ t: 'sources', d: hits.map(h => ({ title: h.title, page: h.page, collection: h.collection, docId: h.docId, text: h.text.slice(0, 600) })) });
        results.push({ type: 'tool_result', tool_use_id: b.id, content: hits.length
          ? hits.map(h => ({ type: 'search_result', source: `canopus:doc/${h.docId}${h.page ? '#page=' + h.page : ''}`, title: `${h.title}${h.page ? ' — page ' + h.page : ''} (${h.collection})`, content: [{ type: 'text', text: red.mask(h.text) }], citations: { enabled: true } }))
          : [{ type: 'text', text: 'No matching passages in the internal knowledge base for this query.' }] });
      }
      turn.push({ role: 'user', content: results });
    }
    const tail = unmask.flush(); if (tail) { display += tail; send({ t: 'text', d: tail }); }
    const cites = [...new Map(citations.filter(c => c.type === 'search_result_location' || c.type === 'web_search_result_location')
      .map(c => [c.url || c.source + '|' + (c.cited_text || '').slice(0, 40), { kind: c.type === 'web_search_result_location' ? 'web' : 'doc', url: c.url || null, source: c.source || null, title: red.unmask(c.title || c.url || ''), text: red.unmask(c.cited_text || '').slice(0, 800) }])).values()];
    if (red.count) audit(user.id, 'redaction.applied', { chat: red.chatId, count: red.count }, ip);
    send({ t: 'done', turn, display, citations: cites, usage: totals, stop });
    res.end();
  } catch (e) {
    if (aborted) { res.end(); return; }
    console.error('[chat]', e.status || '', e.message);
    const s = e.status;
    const msg = s === 401 ? 'The server’s Anthropic API key was rejected. Ask the administrator.'
      : s === 429 ? 'The AI service is rate-limited right now. Try again in a moment.'
      : s === 529 || s >= 500 ? 'The AI service is busy. Please try again shortly.'
      : s === 400 ? 'The AI service rejected the request: ' + (e.error?.error?.message || e.message)
      : s === 404 ? 'Model not available: ' + (e.error?.error?.message || e.message)
      : 'Could not reach the AI service. ' + (e.message || '');
    fail(msg, s || 'network');
  }
}

/* ---------- small helper calls (titles, prompt polishing) ---------- */
export async function quick(user, purpose, text, chatId) {
  if (!config.apiKey) throw Object.assign(new Error('No API key configured'), { status: 503 });
  if (overBudget(user)) throw Object.assign(new Error('Monthly AI budget reached'), { status: 402 });
  const settings = getSettings();
  const red = new Redactor({ userId: user.id, chatId: chatId || 'quick', enabled: settings.redaction.enabled, terms: settings.redaction.terms });
  const system = purpose === 'title'
    ? 'Write a short, specific title (2–6 words) for a conversation that starts with the message below. Use the same language as the message. Reply with the title only — no quotes, no trailing punctuation.'
    : 'You improve prompts for an AI assistant. Rewrite the user\'s prompt so it is clear, specific and well-structured: state the goal, relevant context, and the desired output format. Keep the user\'s intent and language, and keep any placeholders like ⟦NAME_1⟧ exactly. Do not answer the prompt. Reply with the improved prompt only.';
  const api = await claude();
  const r = await api.messages.create({ model: HELPER_MODEL, max_tokens: purpose === 'title' ? 512 : 2048, output_config: { effort: 'low' }, system, messages: [{ role: 'user', content: red.mask(String(text).slice(0, purpose === 'title' ? 1500 : 8000)) || ' ' }] });
  recordUsage(user.id, HELPER_MODEL, r.usage, purpose);
  return red.unmask(r.content.filter(b => b.type === 'text').map(b => b.text).join('').trim());
}
