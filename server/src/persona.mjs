// Personas. An analyst persona describes how the AI should work with one analyst (role, focus, style, tone, formats,
// language). A client persona describes the client's voice and boundaries (audiences, key messages, terms, sensitive
// issues). Both are added to the system prompt; the client persona decides *what* may be said and in whose voice,
// the analyst persona decides *how* the analysis is done and presented.

export const ANALYST_FIELDS = [
  ['title', 'Persona', 'e.g. Senior political & policy communications analyst'],
  ['focus', 'Expertise and focus', 'Sectors, issues, regions or stakeholders this analyst covers'],
  ['style', 'Analysis style', 'e.g. data first, scenario-based, critical of weak evidence, always with risks'],
  ['tone', 'Tone', 'e.g. formal and concise, or warm and persuasive'],
  ['format', 'Preferred formats', 'e.g. executive summary first, tables for comparisons, max 5 bullets'],
  ['language', 'Language', 'e.g. Bahasa Indonesia formal (EYD); English for international clients'],
];
export const CLIENT_FIELDS = [
  ['voice', 'Voice and character', 'How the client sounds: e.g. authoritative but empathetic, never defensive'],
  ['audiences', 'Audiences', 'Who the client speaks to: public, media, parliament, partners…'],
  ['messages', 'Key messages', 'The messages every output should support'],
  ['use', 'Terms to use', 'e.g. "penerima manfaat", official program names'],
  ['avoid', 'Terms to avoid', 'e.g. "gratisan", jargon, names not to mention'],
  ['sensitive', 'Sensitive issues', 'Topics that need care or sign-off'],
  ['people', 'Leaders and officials', 'e.g. Menteri: Yassierli; Wakil Menteri: Afriansyah Noor; Dirjen …'],
  ['programs', 'Programs and platforms (with spelling variants)', 'e.g. SIAPkerja (Siap Kerja); MagangHub (Magang Hub, Magang Nasional); KarirHub …'],
  ['sentiment', 'Sentiment rules (client point of view)', 'e.g. Negatif only if it harms the client; Netral = not tendentious; Positif = builds the client image'],
  ['sectors', 'Sectors / priority programs', 'e.g. Peningkatan Kualitas SDM; Penciptaan Kesempatan Kerja yang Layak; Transformasi Dunia Kerja'],
  ['issues', 'Reference issue list', 'One issue per line (or separated by ;). Used to keep issue names consistent week to week and between media and social media'],
  ['spelling', 'Spelling and naming rules', 'e.g. Sumatera → Sumatra; Kemenaker → Kemnaker'],
];

export function parsePersona(value, fields) {
  let o = value; if (typeof o === 'string') { try { o = JSON.parse(o); } catch { o = {}; } }
  const out = {}; for (const [k] of fields) { const v = String(o?.[k] ?? '').trim().slice(0, k === 'issues' ? 12000 : 2000); if (v) out[k] = v; }
  return out;
}
const lines = (p, fields) => fields.filter(([k]) => p[k]).map(([k, label]) => `- ${label}: ${p[k]}`).join('\n');

export function analystBlock(user) {
  const p = parsePersona(user?.persona, ANALYST_FIELDS); if (!Object.keys(p).length) return '';
  return `The analyst you are working with${user.name ? ` (${user.name})` : ''} has this persona. Adapt your analysis and writing to it, unless the user or a client persona asks otherwise:\n${lines(p, ANALYST_FIELDS)}`;
}
export function clientBlock(client) {
  if (!client) return '';
  const p = parsePersona(client.persona, CLIENT_FIELDS); const notes = String(client.instructions || '').trim();
  if (!Object.keys(p).length && !notes && !client.description) return `Client: ${client.name}`;
  return `Client: ${client.name}${client.description ? ` — ${client.description}` : ''}\nClient persona — follow it in everything written for or about this client (voice, key messages, terms to use or avoid, sensitive issues):\n${[lines(p, CLIENT_FIELDS), notes ? `- Other guidelines: ${notes}` : ''].filter(Boolean).join('\n')}`;
}
