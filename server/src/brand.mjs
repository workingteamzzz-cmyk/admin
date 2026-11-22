// Brand helpers for report decks: reading a logo's colours (PNG), picking the right logo for dark or light slides,
// style presets, a palette recommended from the client's logo, and applying a style to any PowerPoint template
// (theme colours and fonts), so the same template can be re-toned per client.
import zlib from 'node:zlib';

/* ---------- PNG decoding (enough to read colours: 8-bit greyscale/RGB/RGBA/palette, non-interlaced) ---------- */
export function decodePng(buf) {
  if (!(buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47)) return null;
  let i = 8, w = 0, h = 0, depth = 0, type = 0, interlace = 0, plte = null, trns = null; const idat = [];
  while (i + 8 <= buf.length) {
    const len = buf.readUInt32BE(i), kind = buf.toString('latin1', i + 4, i + 8), data = buf.subarray(i + 8, i + 8 + len);
    if (kind === 'IHDR') { w = data.readUInt32BE(0); h = data.readUInt32BE(4); depth = data[8]; type = data[9]; interlace = data[12]; }
    else if (kind === 'PLTE') plte = data; else if (kind === 'tRNS') trns = data; else if (kind === 'IDAT') idat.push(data); else if (kind === 'IEND') break;
    i += 12 + len;
  }
  if (depth !== 8 || interlace || !w || !h || w * h > 25e6) return null;
  const ch = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[type]; if (!ch) return null;
  let raw; try { raw = zlib.inflateSync(Buffer.concat(idat)); } catch { return null; }
  const stride = w * ch, out = new Uint8Array(w * h * 4); let prev = new Uint8Array(stride), p = 0;
  for (let y = 0; y < h; y++) {
    const f = raw[p++]; const line = new Uint8Array(raw.subarray(p, p + stride)); p += stride;
    for (let x = 0; x < stride; x++) { const a = x >= ch ? line[x - ch] : 0, b = prev[x], c = x >= ch ? prev[x - ch] : 0;
      if (f === 1) line[x] = (line[x] + a) & 255; else if (f === 2) line[x] = (line[x] + b) & 255; else if (f === 3) line[x] = (line[x] + ((a + b) >> 1)) & 255;
      else if (f === 4) { const pa = Math.abs(b - c), pb = Math.abs(a - c), pc = Math.abs(a + b - 2 * c); line[x] = (line[x] + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)) & 255; } }
    for (let x = 0; x < w; x++) { const o = (y * w + x) * 4, s = x * ch;
      if (type === 0) { out[o] = out[o + 1] = out[o + 2] = line[s]; out[o + 3] = 255; }
      else if (type === 4) { out[o] = out[o + 1] = out[o + 2] = line[s]; out[o + 3] = line[s + 1]; }
      else if (type === 2) { out[o] = line[s]; out[o + 1] = line[s + 1]; out[o + 2] = line[s + 2]; out[o + 3] = 255; }
      else if (type === 6) { out[o] = line[s]; out[o + 1] = line[s + 1]; out[o + 2] = line[s + 2]; out[o + 3] = line[s + 3]; }
      else { const k = line[s]; out[o] = plte?.[k * 3] ?? 0; out[o + 1] = plte?.[k * 3 + 1] ?? 0; out[o + 2] = plte?.[k * 3 + 2] ?? 0; out[o + 3] = trns && k < trns.length ? trns[k] : 255; } }
    prev = line;
  }
  return { w, h, px: out };
}

const hex = (r, g, b) => [r, g, b].map(v => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('').toUpperCase();
const rgb = h => [0, 2, 4].map(i => parseInt(h.slice(i, i + 2), 16));
const lum = ([r, g, b]) => (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
function hsl([r, g, b]) { r /= 255; g /= 255; b /= 255; const mx = Math.max(r, g, b), mn = Math.min(r, g, b), l = (mx + mn) / 2; if (mx === mn) return [0, 0, l]; const d = mx - mn; const s = l > 0.5 ? d / (2 - mx - mn) : d / (mx + mn); const h = mx === r ? (g - b) / d + (g < b ? 6 : 0) : mx === g ? (b - r) / d + 2 : (r - g) / d + 4; return [h * 60, s, l]; }
function fromHsl(h, s, l) { const k = n => (n + h / 30) % 12, a = s * Math.min(l, 1 - l), f = n => l - a * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1)); return hex(f(0) * 255, f(8) * 255, f(4) * 255); }

// Average brightness of the visible pixels and the main brand colours (greys, near-white and near-black left out).
export function logoInfo(buf) {
  const img = decodePng(buf); if (!img) return { kind: 'jpeg', lum: 0.5, colors: [] };
  const { w, h, px } = img; const step = Math.max(1, Math.floor(Math.sqrt(w * h / 40000))); const bins = new Map(); let sum = 0, n = 0;
  for (let y = 0; y < h; y += step) for (let x = 0; x < w; x += step) { const o = (y * w + x) * 4; if (px[o + 3] < 128) continue; const c = [px[o], px[o + 1], px[o + 2]]; sum += lum(c); n++;
    const [, s, l] = hsl(c); if (s < 0.25 || l < 0.08 || l > 0.92) continue; const key = (c[0] >> 4) << 8 | (c[1] >> 4) << 4 | (c[2] >> 4); const b = bins.get(key) || { n: 0, r: 0, g: 0, b: 0 }; b.n++; b.r += c[0]; b.g += c[1]; b.b += c[2]; bins.set(key, b); }
  const colors = []; for (const b of [...bins.values()].sort((a, c) => c.n - a.n)) { const c = [b.r / b.n, b.g / b.n, b.b / b.n]; if (colors.every(x => Math.abs(hsl(rgb(x))[0] - hsl(c)[0]) > 18 || Math.abs(hsl(rgb(x))[2] - hsl(c)[2]) > 0.25)) colors.push(hex(...c)); if (colors.length >= 4) break; }
  return { kind: 'png', lum: n ? sum / n : 0.5, colors };
}

/* ---------- styles ---------- */
// Sentiment stays semantic in every style: accent3 = positive, accent4 = negative (charts and news cards use them).
export const STYLE_PRESETS = [
  { id: 'editorial', name: 'Editorial data', description: 'Navy, bright blue and amber highlights; calm and readable, suits ministries and data-heavy reports.', font: 'Plus Jakarta Sans',
    colors: { dk2: '0F1E3D', lt2: 'F5F7FB', accent1: '2459F0', accent2: 'F2A93B', accent3: '1FA971', accent4: 'E04A4A', accent5: '6C7A93', accent6: '7FB3FF' } },
  { id: 'classic', name: 'Government classic', description: 'Deep navy and gold, formal and restrained.', font: 'Source Sans 3',
    colors: { dk2: '13294B', lt2: 'F4F1EA', accent1: '1F4E8C', accent2: 'C9A227', accent3: '2E8B57', accent4: 'B83B3B', accent5: '8A8F98', accent6: '5B7DB1' } },
  { id: 'modern', name: 'Modern bold', description: 'Dark aubergine with vivid accents; striking, for campaigns and pitches (less suited to formal ministry decks).', font: 'Plus Jakarta Sans',
    colors: { dk2: '1B0B33', lt2: 'F6F3FB', accent1: '6C3BFF', accent2: 'FF4F9A', accent3: '19C37D', accent4: 'FF5A4E', accent5: 'FFC83D', accent6: '35C2FF' } },
  { id: 'minimal', name: 'Minimal monochrome', description: 'Charcoal and greys with a single teal accent; quiet and premium.', font: 'Inter',
    colors: { dk2: '1F2328', lt2: 'F3F4F6', accent1: '0E8A8A', accent2: '0E8A8A', accent3: '2F9E68', accent4: 'C94A4A', accent5: '7A808A', accent6: 'A9B0BA' } },
  { id: 'warm', name: 'Warm professional', description: 'Slate with terracotta and sand; friendly but serious.', font: 'Lato',
    colors: { dk2: '2D3A45', lt2: 'F7F3EE', accent1: 'C8613A', accent2: 'E0B36A', accent3: '3E9B6E', accent4: 'C0392B', accent5: '7D8C96', accent6: '5E8FA8' } },
];

// A palette built from the client's logo colours: the darkest brand colour (deepened) carries titles and dark slides,
// the most vivid one is the main accent, a contrasting hue or amber the highlight.
export function paletteFromLogo(colors) {
  if (!colors?.length) return null;
  const hs = colors.map(c => ({ c, h: hsl(rgb(c)) })); const vivid = [...hs].sort((a, b) => b.h[1] - a.h[1])[0]; const darkest = [...hs].sort((a, b) => a.h[2] - b.h[2])[0];
  const base = darkest.h; const dk2 = fromHsl(base[0], Math.min(0.7, base[1]), Math.min(0.22, base[2]));
  const acc1 = fromHsl(vivid.h[0], Math.max(0.55, vivid.h[1]), Math.min(0.5, Math.max(0.38, vivid.h[2])));
  const other = hs.find(x => Math.abs(x.h[0] - vivid.h[0]) > 40 && x.h[1] > 0.35); const reddish = other && (other.h[0] < 20 || other.h[0] > 340); // red would read as 'negative'
  const acc2 = other && !reddish ? fromHsl(other.h[0], Math.max(0.6, other.h[1]), 0.55) : 'F2A93B';
  return { id: 'logo', name: 'From the client logo', description: 'Colours taken from the logo, with readable contrast and fixed sentiment colours.', font: 'Plus Jakarta Sans',
    colors: { dk2, lt2: fromHsl(base[0], 0.35, 0.96), accent1: acc1, accent2: acc2, accent3: '1FA971', accent4: 'E04A4A', accent5: fromHsl(base[0], 0.12, 0.55), accent6: reddish ? fromHsl(other.h[0], 0.55, 0.62) : fromHsl(vivid.h[0], 0.7, 0.72) } };
}
// Recommended first: the logo palette when there is one, then presets that fit the client's voice.
export function recommendStyles(logoColors, personaText = '') {
  const fromLogo = paletteFromLogo(logoColors); const formal = /kementerian|ministry|pemerintah|government|lembaga|badan|dinas|formal/i.test(personaText);
  const order = formal ? ['editorial', 'classic', 'minimal', 'warm', 'modern'] : ['editorial', 'modern', 'minimal', 'warm', 'classic'];
  const presets = order.map(id => STYLE_PRESETS.find(p => p.id === id));
  return [...(fromLogo ? [{ ...fromLogo, recommended: true }] : []), ...presets.map((p, i) => ({ ...p, recommended: !fromLogo && i === 0 }))];
}
export function sanitizeStyle(st) {
  if (!st || typeof st !== 'object') return null; const colors = {};
  for (const k of ['dk2', 'lt2', 'accent1', 'accent2', 'accent3', 'accent4', 'accent5', 'accent6']) { const v = String(st.colors?.[k] || '').replace('#', '').toUpperCase(); if (/^[0-9A-F]{6}$/.test(v)) colors[k] = v; }
  if (!Object.keys(colors).length) return null;
  return { id: String(st.id || 'custom').slice(0, 30), name: String(st.name || 'Custom').slice(0, 60), font: String(st.font || '').replace(/[<>"&]/g, '').slice(0, 60), colors };
}
// Re-tones a template: theme colours and the heading/body fonts.
export async function applyStyle(zip, style) {
  if (!style) return;
  for (const f of Object.keys(zip.files).filter(n => /^ppt\/theme\/theme\d+\.xml$/.test(n))) {
    let x = await zip.file(f).async('string');
    for (const [k, v] of Object.entries(style.colors)) x = x.replace(new RegExp(`(<a:${k}>)\\s*<a:(?:srgbClr|sysClr)[^>]*?(?:/>|>[\\s\\S]*?</a:(?:srgbClr|sysClr)>)`), `$1<a:srgbClr val="${v}"/>`);
    if (style.font) x = x.replace(/(<a:(?:majorFont|minorFont)>\s*<a:latin typeface=")[^"]*"/g, `$1${style.font}"`);
    zip.file(f, x);
  }
}
export const isDarkHex = h => lum(rgb(h)) < 0.45;
