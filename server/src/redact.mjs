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
  constructor({ userId, chatId, enabled, terms = [] }) {
    this.userId = userId; this.chatId = String(chatId || 'none').slice(0, 64); this.enabled = !!enabled;
    this.terms = terms.map(t => String(t).trim()).filter(t => t.length >= 3).sort((a, b) => b.length - a.length);
    this.count = 0;
  }
  tokenFor(kind, value) {
    const hit = one(`SELECT token FROM redactions WHERE user_id=? AND chat_id=? AND value=?`, this.userId, this.chatId, value);
    if (hit) return hit.token;
    const n = one(`SELECT COUNT(*) c FROM redactions WHERE user_id=? AND chat_id=? AND kind=?`, this.userId, this.chatId, kind).c + 1;
    const token = `${OPEN}${kind}_${n}${CLOSE}`;
    run(`INSERT INTO redactions(user_id,chat_id,kind,token,value) VALUES(?,?,?,?,?)`, this.userId, this.chatId, kind, token, value);
    return token;
  }
  mask(text) {
    if (!this.enabled || !text) return text;
    let out = String(text);
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
