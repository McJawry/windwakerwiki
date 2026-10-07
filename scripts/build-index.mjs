// Builds <contentDir>/_index.json (titles, tags, search text, wiki links) from the Markdown files.
// Run automatically by .github/workflows/pages.yml, or by hand:  node scripts/build-index.mjs
import { readdirSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { join, relative, sep, basename, dirname } from 'node:path';
import { parseFrontMatter, plainText, extractLinks } from '../assets/md.js';

let contentDir = 'wiki';
try { contentDir = JSON.parse(readFileSync('config.json', 'utf8')).contentDir || 'wiki'; } catch {}
contentDir = contentDir.replace(/^\/+|\/+$/g, '');

const files = [];
(function walk(dir) {
  for (const name of readdirSync(dir)) {
    if (name.startsWith('_') || name.startsWith('.') || name === 'assets' || name === 'node_modules') continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p);
    else if (name.endsWith('.md')) files.push(p);
  }
})(contentDir);

const prettify = (s) => { s = s.replace(/[-_]+/g, ' '); return s.charAt(0).toUpperCase() + s.slice(1); };
const pages = files.sort().map((path) => {
  const file = relative(contentDir, path).split(sep).join('/');
  let id = file.replace(/\.md$/, '');
  if (id.endsWith('/index')) id = id.slice(0, -'/index'.length);
  const { meta, body } = parseFrontMatter(readFileSync(path, 'utf8'));
  const h1 = body.match(/^#\s+(.+)$/m);
  return {
    id, file,
    title: meta.title || (h1 && h1[1].trim()) || prettify(basename(id)),
    icon: meta.icon || '',
    tags: Array.isArray(meta.tags) ? meta.tags : meta.tags ? [meta.tags] : [],
    order: meta.order != null && meta.order !== '' ? Number(meta.order) : null,
    text: plainText(body).slice(0, 5000),
    links: extractLinks(body),
  };
});

writeFileSync(join(contentDir, '_index.json'), JSON.stringify({ generated: new Date().toISOString(), pages }, null, 1));
console.log(`Indexed ${pages.length} page(s) -> ${contentDir}/_index.json`);
