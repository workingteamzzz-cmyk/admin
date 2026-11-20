// PowerPoint builder: reads an organization's .pptx/.potx template (its masters, layouts and theme), then writes new
// slides on those layouts from a structured outline. Tables and charts are native PowerPoint objects (charts carry an
// embedded workbook so they stay editable). Runs entirely on this server.
import { writeXlsx, toNumber } from './tables.mjs';

const NS = 'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"';
const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const CT_SLIDE = 'application/vnd.openxmlformats-officedocument.presentationml.slide+xml';
const CT_CHART = 'application/vnd.openxmlformats-officedocument.drawingml.chart+xml';
const esc = v => String(v ?? '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffe\uffff]/g, '').replace(/[<>&"]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c]));
const unx = t => String(t).replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
const attr = (tag, name) => tag.match(new RegExp(`\\s${name}="([^"]*)"`))?.[1];
const fmtNum = new Intl.NumberFormat('id-ID', { maximumFractionDigits: 2 });
const show = v => (typeof v === 'number' ? fmtNum.format(v) : String(v ?? ''));

/* ================= reading a template ================= */
function placeholders(xml) {
  const out = [];
  for (const m of xml.matchAll(/<p:sp>([\s\S]*?)<\/p:sp>/g)) {
    const ph = m[1].match(/<p:ph\b[^>]*\/?>/)?.[0]; if (!ph) continue;
    const off = m[1].match(/<a:off x="(-?\d+)" y="(-?\d+)"\/>/), ext = m[1].match(/<a:ext cx="(\d+)" cy="(\d+)"\/>/);
    out.push({ type: attr(ph, 'type') || 'obj', idx: attr(ph, 'idx') ?? null, sz: attr(ph, 'sz') || null, orient: attr(ph, 'orient') || null,
      box: off && ext ? { x: +off[1], y: +off[2], w: +ext[1], h: +ext[2] } : null });
  }
  return out;
}
export async function openTemplate(buf) {
  const JSZip = (await import('jszip')).default; const zip = await JSZip.loadAsync(buf);
  if (Object.keys(zip.files).length > 3000) throw new Error('The template has too many parts');
  const read = async n => (zip.file(n) ? zip.file(n).async('string') : '');
  const pres = await read('ppt/presentation.xml'); if (!pres) throw new Error('This is not a PowerPoint file (.pptx or .potx)');
  const sz = pres.match(/<p:sldSz\b[^>]*>/)?.[0] || ''; const width = +attr(sz, 'cx') || 12192000, height = +attr(sz, 'cy') || 6858000;
  const masterXml = await read('ppt/slideMasters/slideMaster1.xml'); const master = placeholders(masterXml);
  const layouts = [];
  for (const f of Object.keys(zip.files).filter(n => /^ppt\/slideLayouts\/slideLayout\d+\.xml$/.test(n)).sort((a, b) => +a.match(/(\d+)\.xml/)[1] - +b.match(/(\d+)\.xml/)[1])) {
    const x = await read(f); const tag = x.match(/<p:sldLayout\b[^>]*>/)?.[0] || '';
    layouts.push({ file: f, name: attr(x.match(/<p:cSld\b[^>]*>/)?.[0] || '', 'name') || f.split('/').pop(), type: attr(tag, 'type') || 'cust', phs: placeholders(x) });
  }
  const theme = await read('ppt/theme/theme1.xml'); const colors = {};
  for (const k of ['dk1', 'lt1', 'dk2', 'lt2', 'accent1', 'accent2', 'accent3', 'accent4', 'accent5', 'accent6']) {
    const m = theme.match(new RegExp(`<a:${k}>\\s*<a:(?:srgbClr val="([0-9A-Fa-f]{6})"|sysClr[^>]*lastClr="([0-9A-Fa-f]{6})")`)); if (m) colors[k] = (m[1] || m[2]).toUpperCase();
  }
  const font = theme.match(/<a:minorFont>\s*<a:latin typeface="([^"]*)"/)?.[1] || '';
  const slides = (pres.match(/<p:sldId\b/g) || []).length;
  // The template's own slides (e.g. last month's report): their titles and text show the AI the expected structure.
  const presRels = await read('ppt/_rels/presentation.xml.rels'); const relT = Object.fromEntries([...presRels.matchAll(/<Relationship\b[^>]*\/>/g)].map(m => [attr(m[0], 'Id'), attr(m[0], 'Target')]));
  const structure = [];
  for (const m of pres.matchAll(/<p:sldId\b[^>]*>/g)) {
    const target = relT[attr(m[0], 'r:id')]; if (!target) continue; const x = await read('ppt/' + target.replace(/^\/?ppt\//, ''));
    let title = ''; const body = [];
    for (const sp of x.matchAll(/<p:sp>([\s\S]*?)<\/p:sp>/g)) {
      const txt = [...sp[1].matchAll(/<a:p>([\s\S]*?)<\/a:p>/g)].map(p => [...p[1].matchAll(/<a:t>([\s\S]*?)<\/a:t>/g)].map(t => t[1]).join('')).filter(Boolean).join(' / ');
      if (!txt) continue; if (!title && /<p:ph[^>]*type="(title|ctrTitle)"/.test(sp[1])) title = txt; else body.push(txt);
    }
    const kinds = [x.includes('drawingml/2006/chart') && 'chart', x.includes('<a:tbl>') && 'table', x.includes('<p:pic>') && 'picture'].filter(Boolean);
    structure.push({ title: unx(title).slice(0, 160), text: unx(body.join(' | ')).slice(0, 400), has: kinds });
    if (structure.length >= 40) break;
  }
  return { zip, width, height, master, layouts, colors, font, slides, structure };
}
// What the UI and the AI need to know about a template.
export function describeTemplate(t) {
  return { structure: t.structure, width: t.width, height: t.height, ratio: t.width / t.height > 1.5 ? '16:9' : '4:3', colors: t.colors, font: t.font, existingSlides: t.slides,
    layouts: t.layouts.map(l => ({ name: l.name, type: l.type })), supports: Object.fromEntries(Object.keys(KIND_LAYOUT).map(k => [k, !!chooseLayout(t, k)?.exact])) };
}

/* ================= choosing layouts ================= */
const isTitle = p => p.type === 'title' || p.type === 'ctrTitle';
const isBody = p => ['obj', 'body', 'subTitle'].includes(p.type) && p.orient !== 'vert';
const KIND_LAYOUT = {
  title: { types: ['title'], name: /title slide|judul|cover|sampul/i },
  section: { types: ['secHead'], name: /section|bagian|divider|pemisah/i },
  bullets: { types: ['obj', 'tx'], name: /title and content|title, content|konten|content/i },
  two: { types: ['twoObj', 'twoTxTwoObj'], name: /two content|comparison|dua|perbandingan/i },
  visual: { types: ['titleOnly'], name: /title only|judul saja/i },
};
function chooseLayout(t, kind) {
  const spec = KIND_LAYOUT[kind === 'closing' ? 'title' : ['table', 'chart', 'kpi', 'quote', 'matrix', 'actions'].includes(kind) ? 'visual' : kind] || KIND_LAYOUT.bullets;
  const L = t.layouts; const hasTitle = l => l.phs.some(isTitle);
  let l = L.find(x => spec.types.includes(x.type) && hasTitle(x)) || L.find(x => spec.name.test(x.name) && hasTitle(x));
  if (l) return { layout: l, exact: true };
  if (kind === 'closing') return chooseLayout(t, 'title');
  if (kind === 'section') { const r = chooseLayout(t, 'title'); if (r) return { ...r, exact: false }; }
  l = L.find(x => hasTitle(x) && x.phs.some(isBody) && !['title', 'secHead'].includes(x.type)) || L.find(hasTitle) || L[0];
  return l ? { layout: l, exact: false } : null;
}
function phBox(t, layout, p) {
  if (p?.box) return p.box;
  const m = t.master.find(x => (isTitle(p || {}) ? x.type === 'title' : x.type === 'body'));
  return m?.box || (isTitle(p || {}) ? { x: t.width * 0.05, y: t.height * 0.05, w: t.width * 0.9, h: t.height * 0.14 } : { x: t.width * 0.05, y: t.height * 0.22, w: t.width * 0.9, h: t.height * 0.68 });
}
// The free area for tables/charts on a layout: its body placeholder, else the master's body area.
function contentBox(t, layout) {
  const body = layout.phs.filter(isBody).sort((a, b) => (a.box?.x ?? 0) - (b.box?.x ?? 0));
  if (body.length === 1 && body[0].box) return body[0].box;
  if (body.length > 1 && body.every(b => b.box)) { const x = Math.min(...body.map(b => b.box.x)), y = Math.min(...body.map(b => b.box.y)); return { x, y, w: Math.max(...body.map(b => b.box.x + b.box.w)) - x, h: Math.max(...body.map(b => b.box.y + b.box.h)) - y }; }
  const m = t.master.find(x => x.type === 'body')?.box; if (m) return m;
  const title = layout.phs.find(isTitle); const tb = phBox(t, layout, title); const top = tb.y + tb.h + t.height * 0.03;
  return { x: tb.x, y: top, w: tb.w, h: t.height * 0.92 - top };
}

/* ================= shapes ================= */
// Inline **bold** → runs.
function runs(text, rPr = '') {
  const parts = String(text ?? '').split(/(\*\*[^*]+\*\*)/g).filter(x => x !== '');
  return (parts.length ? parts : ['']).map(p => { const b = /^\*\*[^*]+\*\*$/.test(p); return `<a:r><a:rPr lang="id-ID" dirty="0"${b ? ' b="1"' : ''}${rPr}/><a:t>${esc(b ? p.slice(2, -2) : p)}</a:t></a:r>`; }).join('');
}
function paras(lines, { size, bullets = true } = {}) {
  const sz = size ? ` sz="${size}"` : '';
  return lines.map(l => { const s = String(l ?? ''); const sub = /^\s{2,}|^[-–•]\s/.test(s); const text = s.replace(/^\s*[-–•]?\s*/, '');
    return `<a:p>${sub || !bullets ? `<a:pPr lvl="${sub ? 1 : 0}"${bullets ? '' : ' marL="0" indent="0"'}>${bullets ? '' : '<a:buNone/>'}</a:pPr>` : ''}${runs(text, sz)}</a:p>`; }).join('') || '<a:p><a:endParaRPr lang="id-ID"/></a:p>';
}
function phShape(id, p, inner, bodyPr = '<a:bodyPr/>') {
  const ph = `<p:ph${p.type !== 'obj' ? ` type="${p.type}"` : ''}${p.sz ? ` sz="${p.sz}"` : ''}${p.idx != null ? ` idx="${p.idx}"` : ''}/>`;
  return `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="Placeholder ${id}"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr><p:nvPr>${ph}</p:nvPr></p:nvSpPr><p:spPr/><p:txBody>${bodyPr}<a:lstStyle/>${inner}</p:txBody></p:sp>`;
}
const fill = c => (!c ? '<a:noFill/>' : /^[0-9A-F]{6}$/i.test(c) ? `<a:solidFill><a:srgbClr val="${c}"/></a:solidFill>` : `<a:solidFill><a:schemeClr val="${c}"/></a:solidFill>`);
function textBox(id, box, inner, { fillClr = null, geom = 'rect', anchor = 't', inset = 91440, autofit = true } = {}) {
  return `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="Text ${id}"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="${Math.round(box.x)}" y="${Math.round(box.y)}"/><a:ext cx="${Math.round(box.w)}" cy="${Math.round(box.h)}"/></a:xfrm><a:prstGeom prst="${geom}"><a:avLst/></a:prstGeom>${fill(fillClr)}<a:ln><a:noFill/></a:ln></p:spPr><p:txBody><a:bodyPr wrap="square" lIns="${inset}" tIns="${inset}" rIns="${inset}" bIns="${inset}" anchor="${anchor}">${autofit ? '<a:normAutofit/>' : ''}</a:bodyPr><a:lstStyle/>${inner}</p:txBody></p:sp>`;
}
function rectShape(id, box, clr) {
  return `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="Shape ${id}"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="${Math.round(box.x)}" y="${Math.round(box.y)}"/><a:ext cx="${Math.round(box.w)}" cy="${Math.round(box.h)}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom>${fill(clr)}<a:ln><a:noFill/></a:ln></p:spPr></p:sp>`;
}
// Simpler, explicit paragraph writer used for styled text (KPIs, captions, quotes).
function styled(text, { sz, b, clr, algn, i } = {}) {
  const parts = String(text ?? '').split(/(\*\*[^*]+\*\*)/g).filter(x => x !== '');
  const r = (parts.length ? parts : ['']).map(p => { const bold = b || /^\*\*[^*]+\*\*$/.test(p); const t = /^\*\*[^*]+\*\*$/.test(p) ? p.slice(2, -2) : p;
    return `<a:r><a:rPr lang="id-ID" dirty="0"${sz ? ` sz="${sz}"` : ''}${bold ? ' b="1"' : ''}${i ? ' i="1"' : ''}>${clr ? fill(clr) : ''}</a:rPr><a:t>${esc(t)}</a:t></a:r>`; }).join('');
  return `<a:p>${algn ? `<a:pPr algn="${algn}"/>` : ''}${r}</a:p>`;
}

function tableFrame(id, box, columns, rows, { fontSize, numericCols }) {
  const lens = columns.map((c, i) => Math.min(40, Math.max(String(c).length * 0.9, ...rows.map(r => show(r[i]).length), 4)));
  const total = lens.reduce((a, b) => a + b, 0); const widths = lens.map(l => Math.round(box.w * l / total));
  const rowH = Math.round(fontSize / 100 * 12700 * 2.1);
  const cell = (v, i, head, band, bold) => `<a:tc><a:txBody><a:bodyPr/><a:lstStyle/><a:p><a:pPr algn="${numericCols[i] ? 'r' : 'l'}"/><a:r><a:rPr lang="id-ID" sz="${fontSize}" dirty="0"${head || bold ? ' b="1"' : ''}>${head ? fill('bg1') : ''}</a:rPr><a:t>${esc(show(v).slice(0, 160))}</a:t></a:r></a:p></a:txBody><a:tcPr marL="68580" marR="68580" marT="34290" marB="34290" anchor="ctr">${['L', 'R', 'T', 'B'].map(s => `<a:ln${s}><a:noFill/></a:ln${s}>`).join('').replace('<a:lnB><a:noFill/></a:lnB>', `<a:lnB w="6350"><a:solidFill><a:schemeClr val="tx1"><a:lumMod val="25000"/><a:lumOff val="75000"/></a:schemeClr></a:solidFill></a:lnB>`)}${head ? fill('accent1') : band ? '<a:solidFill><a:schemeClr val="accent1"><a:alpha val="8000"/></a:schemeClr></a:solidFill>' : '<a:noFill/>'}</a:tcPr></a:tc>`;
  const trs = [`<a:tr h="${rowH}">${columns.map((c, i) => cell(c, i, true)).join('')}</a:tr>`, ...rows.map((r, k) => `<a:tr h="${rowH}">${columns.map((_, i) => cell(r[i], i, false, k % 2 === 1, /^total$/i.test(String(r[0]).trim()))).join('')}</a:tr>`)];
  return `<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="${id}" name="Table ${id}"/><p:cNvGraphicFramePr><a:graphicFrameLocks noGrp="1"/></p:cNvGraphicFramePr><p:nvPr/></p:nvGraphicFramePr><p:xfrm><a:off x="${Math.round(box.x)}" y="${Math.round(box.y)}"/><a:ext cx="${Math.round(box.w)}" cy="${rowH * (rows.length + 1)}"/></p:xfrm><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/table"><a:tbl><a:tblPr firstRow="1" bandRow="1"/><a:tblGrid>${widths.map(w => `<a:gridCol w="${w}"/>`).join('')}</a:tblGrid>${trs.join('')}</a:tbl></a:graphicData></a:graphic></p:graphicFrame>`;
}
function chartFrame(id, box, rid) {
  return `<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="${id}" name="Chart ${id}"/><p:cNvGraphicFramePr/><p:nvPr/></p:nvGraphicFramePr><p:xfrm><a:off x="${Math.round(box.x)}" y="${Math.round(box.y)}"/><a:ext cx="${Math.round(box.w)}" cy="${Math.round(box.h)}"/></p:xfrm><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/chart"><c:chart xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" r:id="${rid}"/></a:graphicData></a:graphic></p:graphicFrame>`;
}

/* ================= charts ================= */
const SENT = [[/^(positif|positive|pos)$/i, 'accent3'], [/^(negatif|negative|neg)$/i, 'accent4'], [/^(netral|neutral|neu)$/i, 'A5A5A5']];
const colorFor = (name, i) => SENT.find(([re]) => re.test(String(name).trim()))?.[1] || `accent${(i % 6) + 1}`;
const colLetter = i => String.fromCharCode(65 + i);
function chartXml(type, cats, series, { stacked, labels }) {
  const n = cats.length; const isPie = type === 'pie' || type === 'doughnut';
  const strCache = vals => `<c:ptCount val="${vals.length}"/>${vals.map((v, i) => `<c:pt idx="${i}"><c:v>${esc(v)}</c:v></c:pt>`).join('')}`;
  const numCache = vals => `<c:formatCode>General</c:formatCode><c:ptCount val="${vals.length}"/>${vals.map((v, i) => (v == null ? '' : `<c:pt idx="${i}"><c:v>${v}</c:v></c:pt>`)).join('')}`;
  const txPr = sz => `<c:txPr><a:bodyPr/><a:lstStyle/><a:p><a:pPr><a:defRPr sz="${sz}"/></a:pPr><a:endParaRPr lang="id-ID"/></a:p></c:txPr>`;
  const dl = (val, pct) => `<c:dLbls>${txPr(1100)}${isPie ? '<c:dLblPos val="bestFit"/>' : ''}<c:showLegendKey val="0"/><c:showVal val="${val ? 1 : 0}"/><c:showCatName val="0"/><c:showSerName val="0"/><c:showPercent val="${pct ? 1 : 0}"/><c:showBubbleSize val="0"/></c:dLbls>`;
  const ser = (s, k) => {
    const clr = colorFor(s.name, k); const sp = type === 'line' ? `<c:spPr><a:ln w="28575" cap="rnd">${fill(clr)}<a:round/></a:ln></c:spPr>` : `<c:spPr>${fill(clr)}</c:spPr>`;
    const dpts = isPie ? cats.map((c, i) => `<c:dPt><c:idx val="${i}"/><c:bubble3D val="0"/><c:spPr>${fill(colorFor(c, i))}<a:ln w="12700"><a:solidFill><a:schemeClr val="bg1"/></a:solidFill></a:ln></c:spPr></c:dPt>`).join('') : '';
    const marker = type === 'line' ? `<c:marker><c:symbol val="circle"/><c:size val="5"/><c:spPr>${fill(clr)}</c:spPr></c:marker>` : '';
    return `<c:ser><c:idx val="${k}"/><c:order val="${k}"/><c:tx><c:strRef><c:f>Sheet1!$${colLetter(k + 1)}$1</c:f><c:strCache>${strCache([s.name])}</c:strCache></c:strRef></c:tx>${sp}${type === 'bar' || type === 'column' ? '<c:invertIfNegative val="0"/>' : ''}${marker}${dpts}${labels ? dl(!isPie, isPie) : ''}<c:cat><c:strRef><c:f>Sheet1!$A$2:$A$${n + 1}</c:f><c:strCache>${strCache(cats)}</c:strCache></c:strRef></c:cat><c:val><c:numRef><c:f>Sheet1!$${colLetter(k + 1)}$2:$${colLetter(k + 1)}$${n + 1}</c:f><c:numCache>${numCache(s.values)}</c:numCache></c:numRef></c:val>${type === 'line' ? '<c:smooth val="0"/>' : ''}</c:ser>`;
  };
  const axes = horizontal => `<c:catAx><c:axId val="5001"/><c:scaling><c:orientation val="${horizontal ? 'maxMin' : 'minMax'}"/></c:scaling><c:delete val="0"/><c:axPos val="${horizontal ? 'l' : 'b'}"/><c:numFmt formatCode="General" sourceLinked="0"/><c:majorTickMark val="none"/><c:minorTickMark val="none"/><c:tickLblPos val="nextTo"/><c:spPr><a:ln w="9525"><a:solidFill><a:schemeClr val="tx1"><a:lumMod val="25000"/><a:lumOff val="75000"/></a:schemeClr></a:solidFill></a:ln></c:spPr>${txPr(1100)}<c:crossAx val="5002"/><c:crosses val="autoZero"/><c:auto val="1"/><c:lblAlgn val="ctr"/><c:lblOffset val="100"/><c:noMultiLvlLbl val="0"/></c:catAx><c:valAx><c:axId val="5002"/><c:scaling><c:orientation val="minMax"/></c:scaling><c:delete val="${horizontal ? 1 : 0}"/><c:axPos val="${horizontal ? 'b' : 'l'}"/>${horizontal ? '' : '<c:majorGridlines><c:spPr><a:ln w="6350"><a:solidFill><a:schemeClr val="tx1"><a:lumMod val="15000"/><a:lumOff val="85000"/></a:schemeClr></a:solidFill></a:ln></c:spPr></c:majorGridlines>'}<c:numFmt formatCode="#,##0" sourceLinked="0"/><c:majorTickMark val="none"/><c:minorTickMark val="none"/><c:tickLblPos val="nextTo"/><c:spPr><a:ln><a:noFill/></a:ln></c:spPr>${txPr(1050)}<c:crossAx val="5001"/><c:crosses val="${horizontal ? 'max' : 'autoZero'}"/><c:crossBetween val="between"/></c:valAx>`;
  let plot;
  if (isPie) plot = type === 'pie' ? `<c:pieChart><c:varyColors val="1"/>${ser(series[0], 0)}<c:firstSliceAng val="0"/></c:pieChart>` : `<c:doughnutChart><c:varyColors val="1"/>${ser(series[0], 0)}<c:firstSliceAng val="0"/><c:holeSize val="55"/></c:doughnutChart>`;
  else if (type === 'line') plot = `<c:lineChart><c:grouping val="standard"/><c:varyColors val="0"/>${series.map(ser).join('')}<c:marker val="1"/><c:axId val="5001"/><c:axId val="5002"/></c:lineChart>${axes(false)}`;
  else { const h = type === 'bar'; plot = `<c:barChart><c:barDir val="${h ? 'bar' : 'col'}"/><c:grouping val="${stacked ? 'stacked' : 'clustered'}"/><c:varyColors val="0"/>${series.map(ser).join('')}<c:gapWidth val="${h ? 60 : 80}"/>${stacked ? '<c:overlap val="100"/>' : ''}<c:axId val="5001"/><c:axId val="5002"/></c:barChart>${axes(h)}`; }
  const legend = series.length > 1 || isPie ? `<c:legend><c:legendPos val="${isPie ? 'r' : 'b'}"/><c:overlay val="0"/>${txPr(1100)}</c:legend>` : '';
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<c:chartSpace xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="${REL}"><c:date1904 val="0"/><c:lang val="id-ID"/><c:roundedCorners val="0"/><c:chart><c:autoTitleDeleted val="1"/><c:plotArea><c:layout/>${plot}<c:spPr><a:noFill/><a:ln><a:noFill/></a:ln></c:spPr></c:plotArea>${legend}<c:plotVisOnly val="1"/><c:dispBlanksAs val="gap"/></c:chart><c:spPr><a:noFill/><a:ln><a:noFill/></a:ln></c:spPr>${txPr(1100)}<c:externalData r:id="rId1"><c:autoUpdate val="0"/></c:externalData></c:chartSpace>`;
}

/* ================= building ================= */
const MAX_SLIDES = 60;
// Removes the template's own example slides (keeps masters, layouts and theme).
async function removeSlides(zip) {
  const presRels = await zip.file('ppt/_rels/presentation.xml.rels').async('string');
  let ct = await zip.file('[Content_Types].xml').async('string');
  const slideRels = [...presRels.matchAll(/<Relationship\b[^>]*\/>/g)].map(m => m[0]).filter(r => /\/slide"/.test(attr(r, 'Type') ? `${attr(r, 'Type')}"` : ''));
  for (const r of slideRels) {
    const target = 'ppt/' + attr(r, 'Target').replace(/^\/?ppt\//, '').replace(/^\.\.\//, '');
    const relsPath = target.replace(/slides\/(slide\d+\.xml)$/, 'slides/_rels/$1.rels');
    const rels = zip.file(relsPath) ? await zip.file(relsPath).async('string') : '';
    for (const nr of rels.matchAll(/Target="\.\.\/notesSlides\/(notesSlide\d+\.xml)"/g)) { zip.remove('ppt/notesSlides/' + nr[1]); zip.remove('ppt/notesSlides/_rels/' + nr[1] + '.rels'); ct = ct.replace(new RegExp(`<Override PartName="/ppt/notesSlides/${nr[1]}"[^>]*/>`), ''); }
    zip.remove(target); zip.remove(relsPath); ct = ct.replace(new RegExp(`<Override PartName="/${target.replace(/\./g, '\\.')}"[^>]*/>`), '');
  }
  zip.file('ppt/_rels/presentation.xml.rels', slideRels.reduce((x, r) => x.replace(r, ''), presRels));
  zip.file('[Content_Types].xml', ct);
}

// outline: { slides: [...] } (already validated). resolve(source) → {columns, rows} or null.
export async function buildDeck(templateBuf, outline, resolve) {
  const t = await openTemplate(templateBuf); const zip = t.zip;
  await removeSlides(zip);
  let ct = (await zip.file('[Content_Types].xml').async('string')).replace('application/vnd.openxmlformats-officedocument.presentationml.template.main+xml', 'application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml');
  let presRels = await zip.file('ppt/_rels/presentation.xml.rels').async('string');
  let pres = await zip.file('ppt/presentation.xml').async('string');
  let nextRid = Math.max(0, ...[...presRels.matchAll(/Id="rId(\d+)"/g)].map(m => +m[1])) + 1;
  let chartNo = Math.max(0, ...Object.keys(zip.files).map(n => +(n.match(/^ppt\/charts\/chart(\d+)\.xml$/)?.[1] || 0))) + 1;
  let embedNo = Math.max(0, ...Object.keys(zip.files).map(n => +(n.match(/^ppt\/embeddings\/Microsoft_Excel_Worksheet(\d+)\.xlsx$/)?.[1] || 0))) + 1;
  const sldIds = []; const warnings = [];
  let slideNo = 0;

  const addSlide = (layout, shapes, extraRels = []) => {
    if (slideNo >= MAX_SLIDES) return false;
    slideNo++; const name = `slide${slideNo}.xml`;
    zip.file(`ppt/slides/${name}`, `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sld ${NS}><p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>${shapes.join('')}</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>`);
    zip.file(`ppt/slides/_rels/${name}.rels`, `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${REL}/slideLayout" Target="../slideLayouts/${layout.file.split('/').pop()}"/>${extraRels.join('')}</Relationships>`);
    ct = ct.replace('</Types>', `<Override PartName="/ppt/slides/${name}" ContentType="${CT_SLIDE}"/></Types>`);
    const rid = `rId${nextRid++}`; presRels = presRels.replace('</Relationships>', `<Relationship Id="${rid}" Type="${REL}/slide" Target="slides/${name}"/></Relationships>`);
    sldIds.push(`<p:sldId id="${1000 + slideNo}" r:id="${rid}"/>`); return true;
  };
  const titleShapes = (layout, title, idStart = 2) => { const p = layout.phs.find(isTitle); return p ? [phShape(idStart, p, paras([title], { bullets: false }))] : [textBox(idStart, phBox(t, layout, null), styled(title, { sz: 2800, b: true, clr: 'tx2' }))]; };
  const caption = (id, box, text) => text ? [rectShape(id, { x: box.x, y: box.y, w: 54864, h: box.h }, 'accent2'), textBox(id + 1, { x: box.x + 120000, y: box.y, w: box.w - 120000, h: box.h }, styled(text, { sz: 1400 }), { anchor: 'ctr' })] : [];
  const split = (box, text) => { if (!text) return [box, null]; const ch = Math.min(box.h * 0.22, 900000); return [{ ...box, h: box.h - ch - 80000 }, { x: box.x, y: box.y + box.h - ch, w: box.w, h: ch }]; };

  for (const s of outline.slides) {
    const pick = chooseLayout(t, s.kind); if (!pick) { warnings.push('The template has no usable layouts'); break; }
    const L = pick.layout; const title = s.title || '';
    if (s.kind === 'title' || s.kind === 'closing' || s.kind === 'section') {
      const shapes = titleShapes(L, title); const sub = L.phs.find(p => p.type === 'subTitle') || L.phs.find(p => isBody(p) && !isTitle(p));
      if ((s.subtitle || '').trim() && sub) shapes.push(phShape(3, sub, paras(String(s.subtitle).split('\n'), { bullets: false })));
      addSlide(L, shapes); continue;
    }
    if (s.kind === 'bullets') {
      const shapes = titleShapes(L, title); const body = L.phs.filter(isBody).sort((a, b) => (a.box?.x ?? 0) - (b.box?.x ?? 0))[0];
      const total = s.bullets.join(' ').length; const size = total > 700 ? 1400 : total > 450 ? 1600 : null;
      if (body) shapes.push(phShape(3, body, paras(s.bullets, { size }), '<a:bodyPr><a:normAutofit/></a:bodyPr>'));
      else shapes.push(textBox(3, contentBox(t, L), paras(s.bullets, { size: size || 1800 })));
      addSlide(L, shapes); continue;
    }
    if (s.kind === 'two') {
      const shapes = titleShapes(L, title); const bodies = L.phs.filter(isBody).sort((a, b) => (a.box?.x ?? 0) - (b.box?.x ?? 0));
      const sides = [[s.left_title, s.left], [s.right_title, s.right]];
      if (pick.exact && bodies.length >= 2 && L.type === 'twoObj') sides.forEach(([h, items], k) => shapes.push(phShape(3 + k, bodies[k], paras([...(h ? [`**${h}**`] : []), ...items], { size: 1600 }), '<a:bodyPr><a:normAutofit/></a:bodyPr>')));
      else { const box = contentBox(t, L); const gap = box.w * 0.04, w = (box.w - gap) / 2;
        sides.forEach(([h, items], k) => shapes.push(textBox(3 + k, { x: box.x + k * (w + gap), y: box.y, w, h: box.h }, (h ? styled(h, { sz: 1800, b: true, clr: 'accent1' }) : '') + paras(items, { size: 1600 })))); }
      addSlide(L, shapes); continue;
    }
    if (s.kind === 'kpi') {
      const shapes = titleShapes(L, title); const [area, capBox] = split(contentBox(t, L), s.caption);
      const items = s.items.slice(0, 4); const gap = area.w * 0.03; const w = (area.w - gap * (items.length - 1)) / Math.max(1, items.length); const h = Math.min(area.h, 2200000);
      items.forEach((it, k) => shapes.push(textBox(10 + k, { x: area.x + k * (w + gap), y: area.y + (area.h - h) / 2, w, h }, styled(it.value, { sz: items.length > 3 ? 3600 : 4400, b: true, clr: 'accent1', algn: 'ctr' }) + styled(it.label, { sz: 1400, algn: 'ctr' }) + (it.note ? styled(it.note, { sz: 1100, algn: 'ctr', clr: 'tx2', i: true }) : ''), { fillClr: 'lt2', geom: 'roundRect', anchor: 'ctr', inset: 137160 })));
      if (capBox) shapes.push(...caption(30, capBox, s.caption));
      addSlide(L, shapes); continue;
    }
    if (s.kind === 'quote') {
      const shapes = titleShapes(L, title); const box = contentBox(t, L); const h = Math.min(box.h, 2600000); const y = box.y + (box.h - h) / 2;
      shapes.push(rectShape(10, { x: box.x, y, w: 91440, h }, 'accent2'));
      shapes.push(textBox(11, { x: box.x + 300000, y, w: box.w - 300000, h }, styled(`“${s.quote}”`, { sz: s.quote.length > 220 ? 2000 : 2600, i: true, clr: 'tx2' }) + (s.source ? styled(`— ${s.source}`, { sz: 1400, clr: 'accent1', b: true }) : ''), { anchor: 'ctr' }));
      addSlide(L, shapes); continue;
    }
    if (s.kind === 'matrix') { // 2×2: SWOT, stakeholder map (influence × support), risk map, options
      const shapes = titleShapes(L, title); const [area, capBox] = split(contentBox(t, L), s.caption);
      const gap = Math.min(area.w, area.h) * 0.03, w = (area.w - gap) / 2, h = (area.h - gap) / 2;
      const fills = ['accent1', 'accent2', 'accent3', 'accent6'];
      s.quadrants.slice(0, 4).forEach((q, k) => { const x = area.x + (k % 2) * (w + gap), y = area.y + Math.floor(k / 2) * (h + gap);
        shapes.push(rectShape(20 + k * 2, { x, y, w: 64008, h }, fills[k]));
        shapes.push(textBox(21 + k * 2, { x: x + 64008, y, w: w - 64008, h }, styled(q.title, { sz: 1500, b: true, clr: fills[k] }) + q.points.map(pt => styled('• ' + pt, { sz: q.points.join(' ').length > 220 ? 1100 : 1250 })).join(''), { fillClr: 'lt2', inset: 118872 })); });
      if (capBox) shapes.push(...caption(40, capBox, s.caption));
      addSlide(L, shapes); continue;
    }
    if (s.kind === 'actions') { // action plan: what, who, when, how success is measured
      const heads = s.headers?.length === 4 ? s.headers : ['Aksi', 'PIC', 'Waktu', 'Indikator keberhasilan'];
      const rows = s.rows.map(r => [r.action, r.owner, r.when, r.kpi]); const fontSize = rows.length > 6 ? 1100 : 1200; const rowH = fontSize / 100 * 12700 * 2.1;
      const [area, capBox] = split(contentBox(t, L), s.caption); const per = Math.max(3, Math.floor(area.h / (rowH * 1.4)) - 1);
      for (let pg = 0; pg * per < rows.length && pg < 3; pg++) {
        const shapes = titleShapes(L, pg ? `${title} (lanjutan)` : title); shapes.push(tableFrame(10, area, heads, rows.slice(pg * per, (pg + 1) * per), { fontSize, numericCols: [false, false, false, false] }));
        if (capBox && pg === 0) shapes.push(...caption(30, capBox, s.caption)); addSlide(L, shapes);
      }
      continue;
    }
    if (s.kind === 'table') {
      const data = resolve(s.source); if (!data) { warnings.push(`Slide “${title}”: data “${s.source}” not found`); continue; }
      let cols = s.columns?.length ? s.columns.map(c => data.columns.findIndex(x => x.toLowerCase() === c.toLowerCase())).filter(i => i >= 0) : data.columns.map((_, i) => i);
      if (!cols.length) cols = data.columns.map((_, i) => i); cols = cols.slice(0, 8);
      let rows = data.rows.map(r => cols.map(i => r[i]));
      if (s.top) rows = rows.slice(0, s.top);
      const columns = cols.map(i => data.columns[i]);
      const numericCols = columns.map((_, i) => rows.length && rows.filter(r => r[i] !== '' && r[i] != null).every(r => typeof r[i] === 'number' || toNumber(r[i]) != null));
      rows = rows.map(r => r.map((v, i) => (numericCols[i] && typeof v !== 'number' && toNumber(v) != null ? toNumber(v) : v)));
      const fontSize = columns.length > 6 ? 1000 : 1200; const rowH = fontSize / 100 * 12700 * 2.1;
      const [area, capBox] = split(contentBox(t, L), s.caption);
      const per = Math.max(3, Math.floor(area.h / rowH) - 1); const pages = Math.max(1, Math.ceil(rows.length / per));
      if (pages > 4) { warnings.push(`Slide “${title}”: only the first ${per * 4} of ${rows.length} rows are shown`); rows = rows.slice(0, per * 4); }
      for (let pg = 0; pg < Math.min(pages, 4); pg++) {
        const chunk = rows.slice(pg * per, (pg + 1) * per); if (!chunk.length && pg) break;
        const shapes = titleShapes(L, pg ? `${title} (lanjutan)` : title); shapes.push(tableFrame(10, area, columns, chunk, { fontSize, numericCols }));
        if (capBox && pg === 0) shapes.push(...caption(30, capBox, s.caption));
        addSlide(L, shapes);
      }
      continue;
    }
    if (s.kind === 'chart') {
      const data = resolve(s.source); if (!data) { warnings.push(`Slide “${title}”: data “${s.source}” not found`); continue; }
      const find = c => data.columns.findIndex(x => x.toLowerCase() === String(c || '').toLowerCase());
      let ci = find(s.category); if (ci < 0) ci = 0;
      let si = (s.series || []).map(find).filter(i => i >= 0 && i !== ci);
      if (!si.length) si = data.columns.map((_, i) => i).filter(i => i !== ci && data.rows.some(r => typeof r[i] === 'number' || toNumber(r[i]) != null)).slice(0, 1);
      if (!si.length) { warnings.push(`Slide “${title}”: no numeric column to chart`); continue; }
      let type = ['bar', 'column', 'line', 'pie', 'doughnut'].includes(s.chart) ? s.chart : 'column';
      let rows = data.rows.filter(r => !/^total$/i.test(String(r[ci]).trim()));
      const limit = type === 'pie' || type === 'doughnut' ? 8 : type === 'line' ? 60 : 15;
      if ((type === 'pie' || type === 'doughnut') && si.length > 1) si = si.slice(0, 1);
      if (rows.length > limit) {
        if (type === 'line') rows = rows.slice(-limit);
        else { const keep = rows.slice(0, limit - 1); const rest = rows.slice(limit - 1); const other = [...keep[0].map(() => '')]; other[ci] = 'Lainnya'; si.forEach(i => { other[i] = rest.reduce((a, r) => a + (toNumber(r[i]) || 0), 0); }); rows = [...keep, other]; }
      }
      const cats = rows.map(r => String(r[ci] ?? '').slice(0, 60) || '(kosong)');
      const series = si.map(i => ({ name: data.columns[i], values: rows.map(r => { const v = typeof r[i] === 'number' ? r[i] : toNumber(r[i]); return v == null || (s.stacked && v === 0) ? null : v; }) }));
      if (type === 'column' && (cats.length > 8 && cats.reduce((a, c) => a + c.length, 0) / cats.length > 12)) type = 'bar';
      const no = chartNo++, eNo = embedNo++;
      zip.file(`ppt/charts/chart${no}.xml`, chartXml(type, cats, series, { stacked: !!s.stacked && series.length > 1, labels: type !== 'line' && cats.length <= 20 }));
      zip.file(`ppt/charts/_rels/chart${no}.xml.rels`, `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${REL}/package" Target="../embeddings/Microsoft_Excel_Worksheet${eNo}.xlsx"/></Relationships>`);
      zip.file(`ppt/embeddings/Microsoft_Excel_Worksheet${eNo}.xlsx`, await writeXlsx([{ name: 'Sheet1', columns: [data.columns[ci], ...series.map(x => x.name)], rows: cats.map((c, k) => [c, ...series.map(x => x.values[k] ?? '')]), noFilter: true }]));
      ct = ct.replace('</Types>', `<Override PartName="/ppt/charts/chart${no}.xml" ContentType="${CT_CHART}"/></Types>`);
      const [area, capBox] = split(contentBox(t, L), s.caption);
      const shapes = titleShapes(L, title); shapes.push(chartFrame(10, area, 'rId2'));
      if (capBox) shapes.push(...caption(30, capBox, s.caption));
      addSlide(L, shapes, [`<Relationship Id="rId2" Type="${REL}/chart" Target="../charts/chart${no}.xml"/>`]);
      continue;
    }
  }
  if (!slideNo) throw new Error('The outline produced no slides');
  if (!/Extension="xlsx"/.test(ct)) ct = ct.replace('<Default ', '<Default Extension="xlsx" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"/><Default ');
  const list = `<p:sldIdLst>${sldIds.join('')}</p:sldIdLst>`;
  pres = /<p:sldIdLst>[\s\S]*?<\/p:sldIdLst>|<p:sldIdLst\/>/.test(pres) ? pres.replace(/<p:sldIdLst>[\s\S]*?<\/p:sldIdLst>|<p:sldIdLst\/>/, list) : pres.replace(/<p:sldSz\b/, list + '<p:sldSz');
  zip.file('ppt/presentation.xml', pres); zip.file('ppt/_rels/presentation.xml.rels', presRels); zip.file('[Content_Types].xml', ct);
  zip.remove('docProps/thumbnail.jpeg');
  const buf = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
  return { buf, slides: slideNo, warnings };
}

/* ================= outline validation ================= */
export const SLIDE_KINDS = ['title', 'section', 'bullets', 'two', 'kpi', 'quote', 'matrix', 'actions', 'table', 'chart', 'closing'];
const st = (v, n) => String(v ?? '').trim().slice(0, n);
const lines = (v, max, n = 400) => (Array.isArray(v) ? v : v ? String(v).split('\n') : []).map(x => st(x, n)).filter(Boolean).slice(0, max);
export function sanitizeOutline(o) {
  const slides = [];
  for (const r of (Array.isArray(o?.slides) ? o.slides : []).slice(0, 40)) {
    if (!r || !SLIDE_KINDS.includes(r.kind)) continue;
    const s = { kind: r.kind, title: st(r.title, 160) };
    if (['title', 'section', 'closing'].includes(r.kind)) s.subtitle = st(r.subtitle, 300);
    if (r.kind === 'bullets') s.bullets = lines(r.bullets, 9);
    if (r.kind === 'two') { s.left_title = st(r.left_title, 80); s.right_title = st(r.right_title, 80); s.left = lines(r.left, 7); s.right = lines(r.right, 7); }
    if (r.kind === 'kpi') s.items = (Array.isArray(r.items) ? r.items : []).slice(0, 4).map(i => ({ value: st(i?.value, 24), label: st(i?.label, 80), note: st(i?.note, 80) })).filter(i => i.value);
    if (r.kind === 'quote') { s.quote = st(r.quote, 400); s.source = st(r.source, 120); if (!s.quote) continue; }
    if (r.kind === 'table') { s.source = st(r.source, 120); s.columns = lines(r.columns, 8, 120); s.top = Math.max(0, Math.min(200, +r.top || 0)); }
    if (r.kind === 'chart') { s.source = st(r.source, 120); s.chart = ['bar', 'column', 'line', 'pie', 'doughnut'].includes(r.chart) ? r.chart : 'column'; s.category = st(r.category, 120); s.series = lines(r.series, 6, 120); s.stacked = !!r.stacked; }
    if (r.kind === 'matrix') { s.quadrants = (Array.isArray(r.quadrants) ? r.quadrants : []).slice(0, 4).map(q => ({ title: st(q?.title, 80), points: lines(q?.points, 5, 160) })); while (s.quadrants.length < 4) s.quadrants.push({ title: '', points: [] }); if (!s.quadrants.some(q => q.title || q.points.length)) continue; }
    if (r.kind === 'actions') { s.rows = (Array.isArray(r.rows) ? r.rows : []).slice(0, 15).map(x => ({ action: st(x?.action, 200), owner: st(x?.owner, 80), when: st(x?.when, 60), kpi: st(x?.kpi, 160) })).filter(x => x.action); s.headers = lines(r.headers, 4, 40); if (s.headers.length !== 4) delete s.headers; if (!s.rows.length) continue; }
    if (['kpi', 'table', 'chart', 'matrix', 'actions'].includes(r.kind)) s.caption = st(r.caption, 300);
    if (r.kind === 'bullets' && !s.bullets.length) continue;
    if (r.kind === 'kpi' && !s.items.length) continue;
    slides.push(s);
  }
  return { title: st(o?.title, 160), slides };
}
