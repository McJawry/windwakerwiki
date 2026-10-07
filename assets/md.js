// md.js — pure Markdown <-> block model. No DOM access, so the build script can import it too.

export const CALLOUTS = {
  NOTE: { icon: '💡', label: 'Note' },
  TIP: { icon: '✅', label: 'Tip' },
  IMPORTANT: { icon: '📌', label: 'Important' },
  WARNING: { icon: '⚠️', label: 'Warning' },
  CAUTION: { icon: '🚫', label: 'Caution' },
};

export const esc = (s) =>
  String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

let counter = 0;
export const uid = () => 'b' + (++counter).toString(36) + Math.random().toString(36).slice(2, 6);

/* ------------------------------------------------------------------ front matter */

const unq = (s) => {
  if ((s.startsWith('"') && s.endsWith('"') && s.length > 1) || (s.startsWith("'") && s.endsWith("'") && s.length > 1)) {
    return s.slice(1, -1).replace(/\\"/g, '"');
  }
  return s;
};
const quote = (s) => {
  s = String(s);
  return /[:#\[\],"']|^\s|\s$/.test(s) || s === '' ? '"' + s.replace(/"/g, '\\"') + '"' : s;
};

export function parseFrontMatter(src) {
  src = src.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  const m = src.match(/^---\n([\s\S]*?)\n---[ \t]*(?:\n|$)/);
  const meta = {};
  if (!m) return { meta, body: src };
  for (const line of m[1].split('\n')) {
    const kv = line.match(/^([A-Za-z_][\w-]*):\s*(.*)$/);
    if (!kv) continue;
    let v = kv[2].trim();
    if (v.startsWith('[') && v.endsWith(']')) {
      v = v.slice(1, -1).split(',').map((x) => unq(x.trim())).filter(Boolean);
    } else v = unq(v);
    meta[kv[1]] = v;
  }
  return { meta, body: src.slice(m[0].length) };
}

export function stringifyFrontMatter(meta) {
  const lines = [];
  for (const [k, v] of Object.entries(meta)) {
    if (v == null || v === '' || (Array.isArray(v) && !v.length)) continue;
    lines.push(Array.isArray(v) ? `${k}: [${v.map(quote).join(', ')}]` : `${k}: ${quote(v)}`);
  }
  return lines.length ? `---\n${lines.join('\n')}\n---\n\n` : '';
}

/* ------------------------------------------------------------------ inline: markdown -> html */

const ESCAPABLE = /[\\`*_{}\[\]()#+\-.!|~<>]/;
const isAlnum = (c) => !!c && /[\p{L}\p{N}]/u.test(c);

export function safeUrl(u) {
  u = String(u || '').trim();
  if (/^(https?:|mailto:)/i.test(u) || /^[#/.]/.test(u)) return u;
  if (/^[\w@%~.\-]+(?:[/?#][^:]*)?$/.test(u)) return u; // relative path, no scheme
  return '';
}
const extAttrs = (u) => (/^https?:/i.test(u) ? ' target="_blank" rel="noopener noreferrer"' : '');

function matchPair(s, from, open, close) {
  let depth = 0;
  for (let j = from; j < s.length; j++) {
    if (s[j] === '\\') { j++; continue; }
    if (s[j] === open) depth++;
    else if (s[j] === close && --depth === 0) return j;
  }
  return -1;
}

function findCloser(s, from, mark) {
  const ch = mark[0], L = mark.length;
  for (let j = from; j < s.length; j++) {
    const c = s[j];
    if (c === '\\') { j++; continue; }
    if (c === '`') { const e = s.indexOf('`', j + 1); if (e < 0) break; j = e; continue; }
    if (c !== ch) continue;
    let k = j;
    while (s[k] === ch) k++;
    const run = k - j;
    if (run < L || (L === 1 && run > 1 && ch !== '_') || j === from || /\s/.test(s[j - 1]) || (ch === '_' && isAlnum(s[j + L]))) {
      j = k - 1;
      continue;
    }
    return j + run - L;
  }
  return -1;
}

export function inlineToHtml(s) {
  let out = '';
  let i = 0;
  const n = s.length;
  const emph = (mark, tag) => {
    const L = mark.length;
    if (!s.startsWith(mark, i)) return false;
    const after = s[i + L];
    if (!after || /\s/.test(after)) return false;
    if (mark[0] === '_' && isAlnum(s[i - 1])) return false;
    const j = findCloser(s, i + L, mark);
    if (j < 0) return false;
    out += `<${tag}>${inlineToHtml(s.slice(i + L, j))}</${tag}>`;
    i = j + L;
    return true;
  };

  while (i < n) {
    const c = s[i];

    if (c === '\\' && i + 1 < n && ESCAPABLE.test(s[i + 1])) { out += esc(s[i + 1]); i += 2; continue; }

    if (c === '`') {
      let run = 1;
      while (s[i + run] === '`') run++;
      const re = new RegExp('(?<!`)`{' + run + '}(?!`)', 'g');
      re.lastIndex = i + run;
      const m = re.exec(s);
      if (m) {
        let code = s.slice(i + run, m.index);
        if (/^ .* $/.test(code) && code.trim()) code = code.slice(1, -1);
        out += '<code>' + esc(code) + '</code>';
        i = m.index + run;
        continue;
      }
      out += '`'.repeat(run);
      i += run;
      continue;
    }

    if (c === '<') {
      const m = s.slice(i).match(/^<br\s*\/?>/i);
      if (m) { out += '<br>'; i += m[0].length; continue; }
    }

    if (c === '[' && s[i + 1] === '[') {
      const e = s.indexOf(']]', i + 2);
      if (e > 0) {
        const inner = s.slice(i + 2, e);
        const bar = inner.indexOf('|');
        const target = (bar < 0 ? inner : inner.slice(0, bar)).trim();
        const label = (bar < 0 ? target : inner.slice(bar + 1).trim()) || target;
        if (target) {
          out += `<a class="wikilink" data-wiki="${esc(target)}" href="#">${esc(label)}</a>`;
          i = e + 2;
          continue;
        }
      }
    }

    if (c === '[') {
      const close = matchPair(s, i, '[', ']');
      if (close > 0 && s[close + 1] === '(') {
        const pe = matchPair(s, close + 1, '(', ')');
        if (pe > 0) {
          const url = s.slice(close + 2, pe).trim().replace(/\s+"[^"]*"$/, '').replace(/^<|>$/g, '');
          const label = inlineToHtml(s.slice(i + 1, close));
          const safe = safeUrl(url);
          out += safe ? `<a href="${esc(safe)}"${extAttrs(safe)}>${label}</a>` : label;
          i = pe + 1;
          continue;
        }
      }
    }

    if (c === '*' || c === '_') {
      if (emph(c + c, 'strong') || emph(c, 'em')) continue;
    } else if (c === '~') {
      if (emph('~~', 's')) continue;
    } else if (c === 'h' && s.startsWith('http', i) && !isAlnum(s[i - 1])) {
      const m = s.slice(i).match(/^https?:\/\/[^\s<>\]\)]+/);
      if (m) {
        const u = m[0].replace(/[.,;:!?]+$/, '');
        out += `<a href="${esc(u)}"${extAttrs(u)}>${esc(u)}</a>`;
        i += u.length;
        continue;
      }
    }

    out += esc(c);
    i++;
  }
  return out;
}

/* ------------------------------------------------------------------ block parsing */

const FENCE = /^\s*(`{3,}|~{3,})\s*([\w+#.\-]*)\s*$/;
const HEADING = /^(#{1,6})\s+(.*)$/;
const HR = /^\s*([-*_])(\s*\1){2,}\s*$/;
const LIST = /^(\s*)(?:([-*+])|(\d+)[.)])\s+(.*)$/;
const IMG = /^\s*!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)\s*$/;
const TABLE_SEP = /^\s*\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)*\|?\s*$/;
const DETAILS = /^\s*<details/i;

const isListLine = (l) => LIST.test(l) && !HR.test(l);
const isBlockStart = (l) =>
  FENCE.test(l) || HEADING.test(l) || HR.test(l) || /^\s*>/.test(l) || isListLine(l) || /^\s*\|/.test(l) || DETAILS.test(l) || IMG.test(l);

const splitRow = (line) =>
  line.trim().replace(/^\|/, '').replace(/\|$/, '').split(/(?<!\\)\|/).map((c) => c.trim());

function joinLines(lines) {
  let s = '';
  lines.forEach((l, k) => {
    const last = k === lines.length - 1;
    if (!last && /(\s{2,}|\\)$/.test(l)) s += l.replace(/(\s{2,}|\\)$/, '') + '<br>';
    else s += last ? l.trim() : l.trim() + ' ';
  });
  return s;
}

export function parseBlocks(body) {
  const lines = body.replace(/\r\n?/g, '\n').split('\n');
  const blocks = [];
  let i = 0;
  let stack = [];
  const push = (b) => blocks.push({ id: uid(), indent: 0, ...b });

  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) { i++; continue; }
    let m;

    if (!isListLine(line)) {
      const prev = blocks[blocks.length - 1];
      const lazy = prev && /^(bullet|numbered|todo)$/.test(prev.type) && i > 0 && lines[i - 1].trim() && /^\s+\S/.test(line) && !isBlockStart(line);
      if (lazy) { prev.html += ' ' + inlineToHtml(line.trim()); i++; continue; }
      stack = [];
    }

    if ((m = line.match(FENCE))) {
      const fence = m[1];
      const code = [];
      i++;
      while (i < lines.length && !lines[i].trim().startsWith(fence)) code.push(lines[i++]);
      i++;
      push({ type: 'code', lang: m[2] || '', code: code.join('\n') });
      continue;
    }

    if (HR.test(line)) { push({ type: 'divider' }); i++; continue; }

    if ((m = line.match(HEADING))) {
      push({ type: 'h' + Math.min(m[1].length, 3), html: inlineToHtml(m[2].trim()) });
      i++;
      continue;
    }

    if ((m = line.match(IMG))) { push({ type: 'image', alt: m[1], url: m[2] }); i++; continue; }

    if (DETAILS.test(line)) {
      const rest = [];
      let j = i + 1;
      while (j < lines.length && !/^\s*<\/details>/i.test(lines[j])) rest.push(lines[j++]);
      i = j + 1;
      let summary = '';
      const idx = rest.findIndex((l) => /<summary>/i.test(l));
      if (idx >= 0) {
        const sm = rest[idx].match(/<summary>(.*?)<\/summary>/i);
        summary = sm ? sm[1] : '';
        rest.splice(idx, 1);
      }
      const paras = [];
      let cur = [];
      for (const l of rest) {
        if (l.trim()) cur.push(l.trim());
        else if (cur.length) { paras.push(cur.join(' ')); cur = []; }
      }
      if (cur.length) paras.push(cur.join(' '));
      push({ type: 'toggle', html: inlineToHtml(summary), body: paras.map(inlineToHtml).join('<br>') });
      continue;
    }

    if (/^\s*\|/.test(line) && i + 1 < lines.length && TABLE_SEP.test(lines[i + 1]) && lines[i + 1].includes('-')) {
      const rows = [splitRow(line).map(inlineToHtml)];
      i += 2;
      while (i < lines.length && /^\s*\|/.test(lines[i])) rows.push(splitRow(lines[i++]).map(inlineToHtml));
      const cols = Math.max(...rows.map((r) => r.length));
      rows.forEach((r) => { while (r.length < cols) r.push(''); });
      push({ type: 'table', rows });
      continue;
    }

    if (/^\s*>/.test(line)) {
      const qs = [];
      while (i < lines.length && /^\s*>/.test(lines[i])) qs.push(lines[i++].replace(/^\s*>\s?/, ''));
      let variant = null;
      const cm = qs[0].match(/^\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]\s*(.*)$/i);
      if (cm) { variant = cm[1].toUpperCase(); qs[0] = cm[2]; if (!qs[0]) qs.shift(); }
      const paras = [];
      let cur = [];
      for (const l of qs) {
        if (l.trim()) cur.push(l);
        else if (cur.length) { paras.push(joinLines(cur)); cur = []; }
      }
      if (cur.length) paras.push(joinLines(cur));
      const html = paras.map(inlineToHtml).join('<br><br>');
      push(variant ? { type: 'callout', variant, html } : { type: 'quote', html });
      continue;
    }

    if ((m = line.match(LIST)) && isListLine(line)) {
      const w = m[1].replace(/\t/g, '    ').length;
      while (stack.length && stack[stack.length - 1] > w) stack.pop();
      if (!stack.length || stack[stack.length - 1] < w) stack.push(w);
      const indent = Math.min(stack.length - 1, 3);
      let text = m[4];
      if (m[2]) {
        const t = text.match(/^\[([ xX])\](?:\s+(.*))?$/);
        if (t) push({ type: 'todo', checked: t[1] !== ' ', indent, html: inlineToHtml(t[2] || '') });
        else push({ type: 'bullet', indent, html: inlineToHtml(text) });
      } else push({ type: 'numbered', indent, html: inlineToHtml(text) });
      i++;
      continue;
    }

    const para = [line];
    i++;
    while (i < lines.length && lines[i].trim() && !isBlockStart(lines[i])) para.push(lines[i++]);
    push({ type: 'p', html: inlineToHtml(joinLines(para)) });
  }
  return blocks;
}

/* ------------------------------------------------------------------ block serialising */

export function numbering(blocks) {
  const out = new Array(blocks.length).fill(0);
  let nums = [];
  blocks.forEach((b, i) => {
    const ind = b.indent || 0;
    if (b.type === 'numbered') {
      nums.length = Math.min(nums.length, ind + 1);
      while (nums.length < ind + 1) nums.push(0);
      out[i] = ++nums[ind];
    } else if (b.type === 'bullet' || b.type === 'todo') {
      nums.length = Math.min(nums.length, ind);
    } else nums = [];
  });
  return out;
}

const encUrl = (u) => String(u).replace(/ /g, '%20').replace(/\)/g, '%29');

// h2m: (inlineHtml) => inline markdown. Supplied by the editor because it needs a DOM.
export function blocksToMd(blocks, h2m) {
  const nums = numbering(blocks);
  const parts = [];
  const add = (text, list = false, fam = '', ind = 0) => parts.push({ text, list, fam, ind });
  const clean = (md) => md.replace(/(<br>)+$/, '').replace(/^\s+|\s+$/g, '');

  blocks.forEach((b, i) => {
    const pad = '    '.repeat(b.indent || 0);
    switch (b.type) {
      case 'p': {
        let t = clean(h2m(b.html));
        if (!t) return;
        t = t.replace(/^([#>+-])/, '\\$1').replace(/^(\d+)([.)])(\s|$)/, '$1\\$2$3');
        add(t);
        break;
      }
      case 'h1': case 'h2': case 'h3': {
        const t = clean(h2m(b.html));
        if (t) add('#'.repeat(+b.type[1]) + ' ' + t);
        break;
      }
      case 'bullet': add(pad + '- ' + clean(h2m(b.html)), true, 'u', b.indent || 0); break;
      case 'todo': add(pad + `- [${b.checked ? 'x' : ' '}] ` + clean(h2m(b.html)), true, 'u', b.indent || 0); break;
      case 'numbered': add(pad + nums[i] + '. ' + clean(h2m(b.html)), true, 'o', b.indent || 0); break;
      case 'quote': add('> ' + clean(h2m(b.html))); break;
      case 'callout': {
        const t = clean(h2m(b.html));
        add(`> [!${b.variant || 'NOTE'}]` + (t ? '\n> ' + t : ''));
        break;
      }
      case 'code': {
        let f = '```';
        while ((b.code || '').includes(f)) f += '`';
        add(f + (b.lang || '') + '\n' + (b.code || '').replace(/\n+$/, '') + '\n' + f);
        break;
      }
      case 'divider': add('---'); break;
      case 'image':
        if (b.url) add(`![${(b.alt || '').replace(/[\[\]\n]/g, ' ')}](${encUrl(b.url)})`);
        break;
      case 'table': {
        const rows = b.rows.map((r) => r.map((c) => clean(h2m(c)).replace(/\|/g, '\\|') || ' '));
        const cols = Math.max(1, ...rows.map((r) => r.length));
        rows.forEach((r) => { while (r.length < cols) r.push(' '); });
        const line = (r) => '| ' + r.join(' | ') + ' |';
        add([line(rows[0]), line(Array(cols).fill('---')), ...rows.slice(1).map(line)].join('\n'));
        break;
      }
      case 'toggle': {
        const sum = clean(h2m(b.html)).replace(/<br>/g, ' ') || 'Toggle';
        const body = h2m(b.body || '').split('<br>').map((x) => x.trim()).filter(Boolean);
        add(`<details>\n<summary>${sum}</summary>\n\n${body.join('\n\n')}${body.length ? '\n\n' : ''}</details>`);
        break;
      }
    }
  });

  let out = '';
  let topFam = '';
  parts.forEach((p, k) => {
    if (k) {
      const sameList = parts[k - 1].list && p.list && !(p.ind === 0 && p.fam !== topFam);
      out += sameList ? '\n' : '\n\n';
    }
    if (!p.list) topFam = '';
    else if (p.ind === 0) topFam = p.fam;
    out += p.text;
  });
  return out;
}

/* ------------------------------------------------------------------ helpers for the index */

export function plainText(md) {
  return md
    .replace(/```[^\n]*\n([\s\S]*?)```/g, '$1')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, '$2')
    .replace(/\[\[([^\]]+)\]\]/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/<\/?[a-z][^>]*>/gi, ' ')
    .replace(/^\s*(?:#{1,6}|>|[-*+]|\d+[.)])\s+(\[[ xX]\]\s+)?/gm, '')
    .replace(/^\s*\[!\w+\]\s*/gm, '')
    .replace(/^[\s|:-]+$/gm, '')
    .replace(/[*~`|\\]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export function extractLinks(md) {
  const out = new Set();
  for (const m of md.matchAll(/\[\[([^\]|]+)(?:\|[^\]]*)?\]\]/g)) out.add(m[1].trim());
  return [...out];
}

export function slugify(s) {
  return String(s)
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}
