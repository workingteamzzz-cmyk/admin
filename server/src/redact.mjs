// Replaces sensitive values with stable placeholders before text is sent to the AI, and restores them on the way back.
// The mapping is stored per user and per chat on this server only, so the same value always gets the same placeholder
// within a conversation (which also keeps prompt caching effective).
import { one, run, all } from './db.mjs';

const OPEN = '⟦', CLOSE = '⟧';
const PATTERNS = [
  ['EMAIL', /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g],
  ['NPWP', /\b\d{2}\.\d{3}\.\d{3}\.\d-\d{3}\.\d{3}\b/g],
  ['NIP', /\b\d{8}\s?\d{6}\s?\d\s?\d{3}\b/g],
  ['NIK', /\b\d{16}\b/g],
  ['PHONE', /(?<![\w+])(?:\+62|62|0)8\d{1,3}[-\s]?\d{3,4}[-\s]?\d{3,5}\b/g],
];
const TOKEN_RE = /⟦([A-Z]+_\d+)⟧/g;

export class Redactor {
  // values: [{kind, value}] from sensitive table columns (patient names, record numbers, addresses, …)
  constructor({ userId, chatId, enabled, terms = [], values = [] }) {
    this.userId = userId; this.chatId = String(chatId || 'none').slice(0, 64); this.enabled = !!enabled;
    this.terms = terms.map(t => String(t).trim()).filter(t => t.length >= 3).sort((a, b) => b.length - a.length);
    this.values = []; this.addValues(values);
    this.count = 0;
  }
  addValues(values) {
    const seen = new Set(this.values.map(v => v.lower));
    for (const v of values) { const value = String(v.value || '').trim(); const lower = value.toLowerCase(); if (value.length < 3 || /^\d{1,3}$/.test(value) || seen.has(lower)) continue; seen.add(lower); this.values.push({ kind: v.kind || 'NAME', value, lower }); }
    this.values.sort((a, b) => b.value.length - a.value.length);
  }
  tokenFor(kind, value) {
    const hit = one(`SELECT token FROM redactions WHERE user_id=? AND chat_id=? AND value=?`, this.userId, this.chatId, value);
    if (hit) return hit.token;
    const n = one(`SELECT COUNT(*) c FROM redactions WHERE user_id=? AND chat_id=? AND kind=?`, this.userId, this.chatId, kind).c + 1;
    const token = `${OPEN}${kind}_${n}${CLOSE}`;
    run(`INSERT INTO redactions(user_id,chat_id,kind,token,value,created) VALUES(?,?,?,?,?,?)`, this.userId, this.chatId, kind, token, value, Date.now());
    return token;
  }
  mask(text) {
    if (!this.enabled || !text) return text;
    let out = String(text);
    let lower = out.toLowerCase();
    for (const v of this.values) {
      if (!lower.includes(v.lower)) continue; // cheap check first; most values are not in a given text
      const re = new RegExp(`(?<![\\p{L}\\p{N}])${v.value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\p{L}\\p{N}])`, 'giu');
      out = out.replace(re, m => { this.count++; return this.tokenFor(v.kind, m); }); lower = out.toLowerCase();
    }
    for (const term of this.terms) {
      const re = new RegExp(`(?<![\\p{L}\\p{N}])${term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\p{L}\\p{N}])`, 'giu');
      out = out.replace(re, m => { this.count++; return this.tokenFor('NAME', m); });
    }
    for (const [kind, re] of PATTERNS) out = out.replace(re, m => { this.count++; return this.tokenFor(kind, m); });
    return out;
  }
  unmask(text) {
    if (!text || !text.includes(OPEN)) return text;
    const rows = all(`SELECT token, value FROM redactions WHERE user_id=? AND chat_id=?`, this.userId, this.chatId);
    const map = new Map(rows.map(r => [r.token, r.value]));
    return text.replace(TOKEN_RE, m => map.get(m) ?? m);
  }
  // Streaming version: holds back a partial placeholder until it is complete.
  streamUnmasker() {
    let pending = '';
    return {
      push: d => { pending += d; const k = pending.lastIndexOf(OPEN); let emit;
        if (k >= 0 && pending.indexOf(CLOSE, k) < 0 && pending.length - k < 40) { emit = pending.slice(0, k); pending = pending.slice(k); }
        else { emit = pending; pending = ''; }
        return this.unmask(emit); },
      flush: () => { const e = this.unmask(pending); pending = ''; return e; },
    };
  }
}
export const SYSTEM_NOTE = `Some text contains placeholders such as ${OPEN}NIK_1${CLOSE} or ${OPEN}NAME_2${CLOSE}. They stand for personal or sensitive values that were hidden for privacy. Copy placeholders exactly as written when you need to refer to them; never guess, expand or invent the hidden value.`;
