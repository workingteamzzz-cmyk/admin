// Outgoing notifications (for n8n, Slack/Teams bridges, email automations, …).
// Each POST carries an HMAC-SHA256 signature of the raw body in X-Canopus-Signature, so the receiver can verify it.
import crypto from 'node:crypto';
import { getSettings, one, run, now, audit } from './db.mjs';

export function sign(secret, body) { return 'sha256=' + crypto.createHmac('sha256', secret).update(body).digest('hex'); }

export async function emit(event, data, { force = false } = {}) {
  const s = getSettings().webhook;
  if (!s.url || !s.secret || (!force && !s.events.includes(event))) return { skipped: true };
  const body = JSON.stringify({ event, ts: new Date().toISOString(), data });
  try {
    const r = await fetch(s.url, { method: 'POST', headers: { 'content-type': 'application/json', 'x-canopus-event': event, 'x-canopus-signature': sign(s.secret, body) }, body, signal: AbortSignal.timeout(5000) });
    return { status: r.status };
  } catch (e) {
    audit(null, 'webhook.failed', { event, error: String(e.message).slice(0, 200) });
    return { error: e.message };
  }
}

// Fire an event at most once per key (e.g. once per user per month per threshold).
export function emitOnce(key, event, data) {
  if (one(`SELECT 1 FROM notices WHERE key=?`, key)) return;
  run(`INSERT INTO notices(key,ts) VALUES(?,?)`, key, now());
  audit(null, event, data);
  emit(event, data);
}
