// Opening Office files (xlsx, pptx, docx) safely: a small upload must not expand into gigabytes in memory.
// The sizes a zip declares can lie, so each compressed part is inflated once with a hard output limit.
import zlib from 'node:zlib';
const MB = 1024 * 1024;
export async function loadZip(buf, { maxParts = 3000, maxEntry = 200 * MB, maxTotal = 600 * MB, what = 'file' } = {}) {
  const JSZip = (await import('jszip')).default; const zip = await JSZip.loadAsync(buf);
  const files = Object.values(zip.files).filter(f => !f.dir);
  if (files.length > maxParts) throw Object.assign(new Error(`This ${what} has too many parts.`), { status: 422 });
  let total = 0;
  for (const f of files) {
    const d = f._data || {}; const declared = d.uncompressedSize || 0;
    if (declared > maxEntry) throw Object.assign(new Error(`This ${what} expands to more than ${maxEntry / MB} MB in one part.`), { status: 422 });
    let real = declared;
    if (d.compressedContent && d.compression?.magic === '\x08\x00') { // deflate: measure the true size with a ceiling
      try { real = zlib.inflateRawSync(d.compressedContent, { maxOutputLength: maxEntry }).length; }
      catch (e) { throw Object.assign(new Error(e.code === 'ERR_BUFFER_TOO_LARGE' ? `This ${what} expands to more than ${maxEntry / MB} MB in one part.` : `This ${what} is damaged.`), { status: 422 }); }
    }
    total += real; if (total > maxTotal) throw Object.assign(new Error(`This ${what} expands to more than ${maxTotal / MB} MB.`), { status: 422 });
  }
  return zip;
}
