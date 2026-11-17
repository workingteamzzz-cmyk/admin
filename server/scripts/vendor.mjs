// Copies the browser libraries the web app needs into public/vendor, so the app never loads code from a CDN.
import fs from 'node:fs'; import path from 'node:path'; import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, 'public', 'vendor'); fs.mkdirSync(out, { recursive: true });
for (const [src, dst] of [['marked/lib/marked.esm.js', 'marked.esm.js'], ['dompurify/dist/purify.es.mjs', 'purify.es.mjs'], ['jszip/dist/jszip.min.js', 'jszip.min.js']])
  fs.copyFileSync(path.join(root, 'node_modules', src), path.join(out, dst));
console.log('Vendored browser libraries into public/vendor');
