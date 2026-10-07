// editor.js — a small Notion-style block editor. Blocks live in an array; the DOM is re-rendered on
// structural changes and read back ("synced") before they happen. Saved output is plain Markdown.
import { h } from './dom.js';
import { uid, inlineToHtml, CALLOUTS, numbering, parseBlocks, blocksToMd, esc, safeUrl } from './md.js';

/* ------------------------------------------------------------------ inline DOM -> markdown */

function escText(t) {
  let o = '';
  for (let i = 0; i < t.length; i++) {
    const c = t[i], p = t[i - 1] || '', n = t[i + 1] || '';
    if (c === '\\' && /[\\`*_{}\[\]()#+\-.!|~<>]/.test(n)) o += '\\\\';
    else if (c === '`' || c === '*') o += '\\' + c;
    else if (c === '_' && (!/[\p{L}\p{N}]/u.test(p) || !/[\p{L}\p{N}]/u.test(n))) o += '\\_';
    else if (c === '~' && n === '~') o += '\\~';
    else if ((c === '[' || c === ']') && (t.includes('](') || t.includes('[['))) o += '\\' + c;
    else if (c === '<' && /^<\/?(br|details|summary)/i.test(t.slice(i))) o += '\\<';
    else o += c;
  }
  return o;
}
const wrap = (mark, inner) => {
  const m = inner.match(/^(\s*)([\s\S]*?)(\s*)$/);
  return m[2] ? m[1] + mark + m[2] + mark + m[3] : inner;
};
function codeSpan(text) {
  let run = 1;
  while (text.includes('`'.repeat(run))) run++;
  const f = '`'.repeat(run);
  return run > 1 || text.startsWith('`') || text.endsWith('`') ? `${f} ${text} ${f}` : f + text + f;
}
function domToMd(node) {
  let out = '';
  for (const ch of node.childNodes) {
    if (ch.nodeType === 3) {
      out += escText(ch.nodeValue.replace(/[​﻿]/g, '').replace(/ /g, ' '));
    } else if (ch.nodeType === 1) {
      const t = ch.tagName;
      if (t === 'BR') out += '<br>';
      else if (t === 'B' || t === 'STRONG') out += wrap('**', domToMd(ch));
      else if (t === 'I' || t === 'EM') out += wrap('*', domToMd(ch));
      else if (t === 'S' || t === 'STRIKE' || t === 'DEL') out += wrap('~~', domToMd(ch));
      else if (t === 'CODE') out += ch.textContent ? codeSpan(ch.textContent) : '';
      else if (t === 'A') {
        const label = ch.textContent;
        const wiki = ch.getAttribute('data-wiki');
        if (wiki != null) out += label && label !== wiki ? `[[${wiki}|${label.replace(/[\]|]/g, '')}]]` : `[[${wiki}]]`;
        else {
          const href = ch.getAttribute('href') || '';
          if (!safeUrl(href)) out += domToMd(ch);
          else out += href === label ? href : `[${domToMd(ch)}](${href.replace(/ /g, '%20').replace(/\)/g, '%29')})`;
        }
      } else if (t === 'DIV' || t === 'P') {
        const inner = domToMd(ch);
        out += (out && !out.endsWith('<br>') ? '<br>' : '') + inner;
      } else out += domToMd(ch);
    }
  }
  return out;
}
export function htmlToMd(html) {
  if (!html) return '';
  const doc = new DOMParser().parseFromString(html, 'text/html');
  return domToMd(doc.body);
}
const normalizeHtml = (html) => (html ? inlineToHtml(htmlToMd(html)) : '');
const htmlTextLen = (html) => new DOMParser().parseFromString(html || '', 'text/html').body.textContent.length;

/* ------------------------------------------------------------------ constants */

const TEXTY = new Set(['p', 'h1', 'h2', 'h3', 'bullet', 'numbered', 'todo', 'quote', 'callout']);
const LISTY = new Set(['bullet', 'numbered', 'todo']);
const FOCUSABLE = '.txt[contenteditable], textarea.code, td[contenteditable], th[contenteditable], input[data-f]';
const PLACEHOLDER = {
  p: "Type '/' for commands", h1: 'Heading 1', h2: 'Heading 2', h3: 'Heading 3', bullet: 'List item',
  numbered: 'List item', todo: 'To-do', quote: 'Quote', callout: 'Type something…', toggle: 'Toggle title',
};
const SLASH = [
  { type: 'p', label: 'Text', desc: 'Just start writing', icon: '¶', kw: 'text paragraph plain' },
  { type: 'h1', label: 'Heading 1', desc: 'Big section heading', icon: 'H1', kw: 'title header h1' },
  { type: 'h2', label: 'Heading 2', desc: 'Medium section heading', icon: 'H2', kw: 'subtitle header h2' },
  { type: 'h3', label: 'Heading 3', desc: 'Small section heading', icon: 'H3', kw: 'header h3' },
  { type: 'bullet', label: 'Bulleted list', desc: 'A simple list', icon: '•', kw: 'ul unordered bullet' },
  { type: 'numbered', label: 'Numbered list', desc: 'A list with numbering', icon: '1.', kw: 'ol ordered number' },
  { type: 'todo', label: 'To-do list', desc: 'Track tasks with checkboxes', icon: '☑', kw: 'task checkbox check todo' },
  { type: 'toggle', label: 'Toggle', desc: 'Hide content inside a heading', icon: '▸', kw: 'collapse details expand' },
  { type: 'quote', label: 'Quote', desc: 'Capture a quote', icon: '❝', kw: 'blockquote cite' },
  { type: 'callout', label: 'Callout', desc: 'Make text stand out', icon: '💡', kw: 'note tip info warning alert' },
  { type: 'code', label: 'Code', desc: 'A block of code', icon: '</>', kw: 'snippet pre' },
  { type: 'divider', label: 'Divider', desc: 'Visually separate sections', icon: '—', kw: 'hr line separator' },
  { type: 'table', label: 'Table', desc: 'Rows and columns', icon: '▦', kw: 'grid' },
  { type: 'image', label: 'Image', desc: 'Upload or link a picture', icon: '🖼', kw: 'picture photo img' },
  { wiki: true, label: 'Link to page', desc: 'Link to another wiki page', icon: '[[', kw: 'wiki mention link page' },
];

function makeBlock(type) {
  const b = { id: uid(), type, indent: 0 };
  if (TEXTY.has(type) || type === 'toggle') b.html = '';
  if (type === 'toggle') b.body = '';
  if (type === 'todo') b.checked = false;
  if (type === 'callout') b.variant = 'NOTE';
  if (type === 'code') { b.code = ''; b.lang = ''; }
  if (type === 'image') { b.url = ''; b.alt = ''; }
  if (type === 'table') b.rows = [['', '', ''], ['', '', ''], ['', '', '']];
  return b;
}

/* ------------------------------------------------------------------ selection helpers */

const sel = () => window.getSelection();
function caretRange(el) {
  const s = sel();
  if (!s.rangeCount) return null;
  const r = s.getRangeAt(0);
  return el.contains(r.startContainer) ? r : null;
}
function textBefore(el) {
  const r = caretRange(el);
  if (!r) return '';
  const pre = r.cloneRange();
  pre.selectNodeContents(el);
  pre.setEnd(r.startContainer, r.startOffset);
  return pre.toString();
}
function textAfter(el) {
  const r = caretRange(el);
  if (!r) return '';
  const post = r.cloneRange();
  post.selectNodeContents(el);
  post.setStart(r.endContainer, r.endOffset);
  return post.toString();
}
const isCollapsed = () => sel().rangeCount && sel().getRangeAt(0).collapsed;
function placeCaret(el, atEnd = false) {
  if (el.matches('textarea,input')) {
    el.focus();
    const p = atEnd ? el.value.length : 0;
    el.setSelectionRange(p, p);
    return;
  }
  el.focus();
  const r = document.createRange();
  r.selectNodeContents(el);
  r.collapse(!atEnd);
  const s = sel();
  s.removeAllRanges();
  s.addRange(r);
}
function placeCaretAt(el, offset) {
  el.focus();
  const w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  let n, left = offset;
  while ((n = w.nextNode())) {
    if (left <= n.length) {
      const r = document.createRange();
      r.setStart(n, left);
      r.collapse(true);
      sel().removeAllRanges();
      sel().addRange(r);
      return;
    }
    left -= n.length;
  }
  placeCaret(el, true);
}
function lineRect(range) {
  const rs = range.getClientRects();
  return rs.length ? rs[0] : null;
}
function onFirstLine(el) {
  const r = caretRange(el);
  if (!r || !r.collapsed) return false;
  const c = lineRect(r);
  const z = document.createRange();
  z.selectNodeContents(el);
  z.collapse(true);
  const s = lineRect(z);
  return !c || !s || Math.abs(c.top - s.top) < 4;
}
function onLastLine(el) {
  const r = caretRange(el);
  if (!r || !r.collapsed) return false;
  const c = lineRect(r);
  const z = document.createRange();
  z.selectNodeContents(el);
  z.collapse(false);
  const e = lineRect(z);
  return !c || !e || Math.abs(c.bottom - e.bottom) < 4;
}
const readAsDataURL = (file) =>
  new Promise((res, rej) => {
    const fr = new FileReader();
    fr.onload = () => res(fr.result);
    fr.onerror = rej;
    fr.readAsDataURL(file);
  });

/* ------------------------------------------------------------------ the editor */

export function createEditor(root, opts) {
  let blocks = (opts.blocks || []).map((b) => ({ indent: 0, ...b }));
  let editable = !!opts.editable;
  const uploads = new Map(); // markdown url -> {repoPath, b64, preview}
  const openToggles = new Set();
  const get = (id) => blocks.find((b) => b.id === id);
  const changed = () => opts.onChange && opts.onChange();
  const resolveWiki = opts.resolveWiki || (() => ({ href: '#', exists: true }));
  const resolveUrl = opts.resolveUrl || ((u) => u);

  /* ---------- rendering ---------- */

  function decorate(el) {
    el.querySelectorAll('a[data-wiki]').forEach((a) => {
      const r = resolveWiki(a.dataset.wiki);
      a.setAttribute('href', r.href);
      a.classList.add('wikilink');
      a.classList.toggle('missing', !r.exists);
      a.removeAttribute('target');
    });
  }
  function txt(b, field, ph, cls = '') {
    const t = h('div', { class: 'txt ' + cls, 'data-f': field, 'data-ph': ph });
    t.innerHTML = normalizeHtml(b[field] || '');
    decorate(t);
    if (editable) { t.contentEditable = 'true'; t.spellcheck = true; }
    return t;
  }

  function renderBlock(b, num) {
    const el = h('div', { class: `blk blk-${b.type}`, 'data-id': b.id, id: 'b-' + b.id });
    el.style.setProperty('--indent', b.indent || 0);
    if (editable) {
      el.append(
        h('div', { class: 'blk-gutter' },
          h('button', { class: 'blk-add', title: 'Add a block below', tabindex: '-1', 'aria-label': 'Add block' }, '+'),
          h('span', { class: 'blk-grip', draggable: 'true', title: 'Drag to move, click for options', 'aria-label': 'Block options' }, '⋮⋮'),
        ),
      );
    }
    const body = h('div', { class: 'blk-body' });
    switch (b.type) {
      case 'p': case 'h1': case 'h2': case 'h3': case 'quote':
        body.append(txt(b, 'html', PLACEHOLDER[b.type]));
        break;
      case 'bullet':
        body.append(h('div', { class: 'li' }, h('span', { class: 'mk' }, ['•', '◦', '▪', '▫'][b.indent || 0]), txt(b, 'html', PLACEHOLDER.bullet)));
        break;
      case 'numbered':
        body.append(h('div', { class: 'li' }, h('span', { class: 'mk num' }, num + '.'), txt(b, 'html', PLACEHOLDER.numbered)));
        break;
      case 'todo': {
        const cb = h('input', { type: 'checkbox', class: 'todo-cb', disabled: !editable });
        cb.checked = !!b.checked;
        body.append(h('div', { class: 'li' + (b.checked ? ' done' : '') }, cb, txt(b, 'html', PLACEHOLDER.todo)));
        break;
      }
      case 'callout':
        body.append(h('div', { class: 'callout v-' + (b.variant || 'NOTE') },
          h('button', { class: 'callout-icon', tabindex: '-1', title: editable ? 'Change style' : '' }, (CALLOUTS[b.variant] || CALLOUTS.NOTE).icon),
          txt(b, 'html', PLACEHOLDER.callout)));
        break;
      case 'code':
        if (editable) {
          const ta = h('textarea', { class: 'code', 'data-f': 'code', spellcheck: 'false', rows: '1', placeholder: 'Code…' });
          ta.value = b.code || '';
          body.append(h('div', { class: 'codebox' },
            h('input', { class: 'lang', 'data-f': 'lang', placeholder: 'language', value: b.lang || '', spellcheck: 'false' }), ta));
        } else {
          const code = h('code', {}, b.code || '');
          body.append(h('div', { class: 'codebox view' },
            b.lang ? h('span', { class: 'lang-tag' }, b.lang) : null,
            h('button', { class: 'copy', 'data-act': 'copy' }, 'Copy'),
            h('pre', {}, code)));
        }
        break;
      case 'divider':
        body.append(h('hr'));
        break;
      case 'image': {
        const src = uploads.get(b.url)?.preview || (b.url ? resolveUrl(b.url) : '');
        if (!b.url) {
          if (editable) {
            const fi = h('input', { class: 'img-url', placeholder: 'Paste an image link…', 'data-ignore': '1' });
            body.append(h('div', { class: 'img-empty' },
              h('div', { class: 'img-empty-t' }, '🖼  Add an image'),
              h('div', { class: 'img-empty-row' }, fi,
                h('button', { class: 'btn sm', 'data-act': 'img-url' }, 'Embed'),
                h('button', { class: 'btn sm', 'data-act': 'img-upload' }, 'Upload'))));
          }
        } else {
          body.append(h('figure', {},
            h('img', { src: src, alt: b.alt || '', loading: 'lazy' }),
            editable
              ? h('div', { class: 'cap-row' }, h('input', { class: 'cap', 'data-f': 'alt', value: b.alt || '', placeholder: 'Add a caption…' }),
                h('button', { class: 'btn sm ghost', 'data-act': 'img-clear' }, 'Replace'))
              : b.alt ? h('figcaption', {}, b.alt) : null));
        }
        break;
      }
      case 'table': {
        const tbl = h('table');
        b.rows.forEach((r, ri) => {
          const tr = h('tr');
          r.forEach((c) => {
            const cell = h(ri === 0 ? 'th' : 'td');
            cell.innerHTML = normalizeHtml(c);
            decorate(cell);
            if (editable) cell.contentEditable = 'true';
            tr.append(cell);
          });
          tbl.append(tr);
        });
        body.append(h('div', { class: 'tbl-wrap' }, tbl));
        if (editable) {
          body.append(h('div', { class: 'tbl-ctl' },
            h('button', { class: 'btn sm ghost', 'data-act': 'row+' }, '+ Row'),
            h('button', { class: 'btn sm ghost', 'data-act': 'col+' }, '+ Column'),
            h('button', { class: 'btn sm ghost', 'data-act': 'row-' }, '− Row'),
            h('button', { class: 'btn sm ghost', 'data-act': 'col-' }, '− Column')));
        }
        break;
      }
      case 'toggle': {
        const open = editable || openToggles.has(b.id);
        el.classList.toggle('open', open);
        body.append(
          h('div', { class: 'tg-head' }, h('button', { class: 'tg-caret', tabindex: '-1', 'aria-label': 'Expand' }, '▸'), txt(b, 'html', PLACEHOLDER.toggle, 'tg-title')),
          h('div', { class: 'tg-body' }, txt(b, 'body', 'Empty. Click to add content.', 'tg-content')));
        break;
      }
    }
    el.append(body);
    return el;
  }

  function ensureTrailing() {
    if (!editable) return;
    const last = blocks[blocks.length - 1];
    if (!last || last.type !== 'p' || htmlToMd(last.html).trim()) blocks.push(makeBlock('p'));
  }

  function render() {
    ensureTrailing();
    root.textContent = '';
    root.classList.toggle('editable', editable);
    const nums = numbering(blocks);
    blocks.forEach((b, i) => root.append(renderBlock(b, nums[i])));
    root.querySelectorAll('textarea.code').forEach(autosize);
  }
  function autosize(ta) {
    ta.style.height = 'auto';
    ta.style.height = ta.scrollHeight + 2 + 'px';
  }

  /* ---------- sync / mutate / focus ---------- */

  function syncAll() {
    if (!editable) return;
    root.querySelectorAll('.blk').forEach((el) => {
      const b = get(el.dataset.id);
      if (!b) return;
      el.querySelectorAll('[data-f]').forEach((f) => {
        b[f.dataset.f] = f.matches('textarea,input') ? f.value : f.innerHTML;
      });
      if (b.type === 'table') b.rows = [...el.querySelectorAll('tr')].map((tr) => [...tr.children].map((td) => td.innerHTML));
    });
  }
  function mutate(fn) {
    syncAll();
    const focus = fn();
    render();
    if (focus) focusBlock(focus.id, focus.pos);
    changed();
  }
  function focusBlock(id, pos = 'start') {
    const el = root.querySelector(`.blk[data-id="${id}"]`);
    if (!el) return;
    const all = [...el.querySelectorAll(FOCUSABLE)];
    if (!all.length) return;
    const f = pos === 'end' ? all[all.length - 1] : all[0];
    if (typeof pos === 'number') placeCaretAt(f, pos);
    else placeCaret(f, pos === 'end');
    f.scrollIntoView({ block: 'nearest' });
  }
  const blockOf = (el) => get(el.closest('.blk')?.dataset.id);

  function insertAfter(b, nb, { replaceEmpty = false } = {}) {
    const idx = blocks.indexOf(b);
    if (replaceEmpty && TEXTY.has(b.type) && !htmlToMd(b.html).trim()) blocks.splice(idx, 1, nb);
    else blocks.splice(idx + 1, 0, nb);
  }

  /* ---------- popup menu (slash commands, wiki links, block options) ---------- */

  const menuEl = h('div', { class: 'ed-menu', hidden: true, role: 'listbox' });
  document.body.append(menuEl);
  let menu = null;

  function openMenu(m, rect) {
    menu = { index: 0, ...m };
    menuEl.textContent = '';
    if (!menu.items.length) { closeMenu(); return; }
    menu.items.forEach((it, i) => {
      if (it.heading) { menuEl.append(h('div', { class: 'ed-head' }, it.heading)); return; }
      menuEl.append(h('button', {
        class: 'ed-item' + (i === menu.index ? ' on' : ''), 'data-i': i, role: 'option',
        onmousedown: (e) => { e.preventDefault(); const cur = menu; closeMenu(); cur.pick(it); },
        onmousemove: () => highlight(i),
      }, h('span', { class: 'ed-ic' }, it.icon || ''), h('span', { class: 'ed-tx' }, h('b', {}, it.label), it.desc ? h('small', {}, it.desc) : null)));
    });
    while (menu.items[menu.index]?.heading) menu.index++;
    highlight(menu.index);
    menuEl.hidden = false;
    const mh = menuEl.offsetHeight, mw = menuEl.offsetWidth;
    let top = rect.bottom + 6, left = rect.left;
    if (top + mh > innerHeight - 8) top = Math.max(8, rect.top - mh - 6);
    if (left + mw > innerWidth - 8) left = Math.max(8, innerWidth - mw - 8);
    menuEl.style.top = top + 'px';
    menuEl.style.left = left + 'px';
  }
  function highlight(i) {
    if (!menu) return;
    menu.index = i;
    menuEl.querySelectorAll('.ed-item').forEach((b) => b.classList.toggle('on', +b.dataset.i === i));
    menuEl.querySelector('.ed-item.on')?.scrollIntoView({ block: 'nearest' });
  }
  function closeMenu() {
    menu = null;
    menuEl.hidden = true;
  }
  function menuKey(e) {
    const sels = menu.items.map((it, i) => (it.heading ? -1 : i)).filter((i) => i >= 0);
    const pos = sels.indexOf(menu.index);
    if (e.key === 'ArrowDown') { e.preventDefault(); highlight(sels[(pos + 1) % sels.length]); return true; }
    if (e.key === 'ArrowUp') { e.preventDefault(); highlight(sels[(pos - 1 + sels.length) % sels.length]); return true; }
    if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); const cur = menu; closeMenu(); cur.pick(cur.items[cur.index]); return true; }
    if (e.key === 'Escape') { e.preventDefault(); closeMenu(); return true; }
    return false;
  }
  function caretRectOf(t) {
    const r = caretRange(t);
    return (r && lineRect(r)) || t.getBoundingClientRect();
  }
  function deleteBack(n) {
    const s = sel();
    for (let i = 0; i < n; i++) s.modify('extend', 'backward', 'character');
    s.deleteFromDocument();
  }

  function refreshTriggers(t) {
    const before = textBefore(t);
    let m;
    if ((m = before.match(/\[\[([^\[\]]*)$/))) {
      const q = m[1].trim().toLowerCase();
      const pages = (opts.pages ? opts.pages() : []).filter((p) => !q || p.title.toLowerCase().includes(q) || p.id.includes(q)).slice(0, 8);
      const items = pages.map((p) => ({ icon: p.icon || '📄', label: p.title, desc: p.id, title: p.title }));
      if (m[1].trim() && !pages.some((p) => p.title.toLowerCase() === q)) {
        items.push({ icon: '＋', label: `Link to “${m[1].trim()}”`, desc: 'Page does not exist yet', title: m[1].trim() });
      }
      if (!items.length) return closeMenu();
      openMenu({ kind: 'wiki', items, pick: (it) => pickWiki(it, m[1].length + 2) }, caretRectOf(t));
      return;
    }
    if ((m = before.match(/(?:^|\s)\/([\w-]*)$/)) && !t.closest('td,th')) {
      const q = m[1].toLowerCase();
      const items = SLASH.filter((s) => !q || (s.label + ' ' + s.kw).toLowerCase().includes(q));
      if (!items.length) return closeMenu();
      openMenu({ kind: 'slash', items, pick: (it) => pickSlash(it, m[1].length + 1) }, caretRectOf(t));
      return;
    }
    if (menu && menu.kind !== 'handle') closeMenu();
  }

  function pickWiki(it, delLen) {
    deleteBack(delLen);
    document.execCommand('insertHTML', false, `<a class="wikilink" data-wiki="${esc(it.title)}" href="#">${esc(it.title)}</a>&nbsp;`);
    const t = document.activeElement.closest('.txt');
    if (t) decorate(t);
  }

  function pickSlash(it, delLen) {
    const t = document.activeElement.closest('.txt');
    deleteBack(delLen);
    if (it.wiki) { document.execCommand('insertText', false, '[['); return; }
    const b = blockOf(t);
    const nb = makeBlock(it.type);
    mutate(() => {
      const wasEmpty = !t.textContent.trim();
      if (wasEmpty && TEXTY.has(nb.type) && TEXTY.has(b.type)) {
        nb.html = '';
        nb.indent = LISTY.has(nb.type) ? b.indent : 0;
      }
      const idx = blocks.indexOf(b);
      if (wasEmpty && (TEXTY.has(b.type))) blocks.splice(idx, 1, nb);
      else blocks.splice(idx + 1, 0, nb);
      if (nb.type === 'divider' && !blocks[blocks.indexOf(nb) + 1]) blocks.push(makeBlock('p'));
      if (nb.type === 'divider') return { id: blocks[blocks.indexOf(nb) + 1].id };
      return { id: nb.id };
    });
  }

  function openBlockMenu(grip) {
    const b = get(grip.closest('.blk').dataset.id);
    const idx = blocks.indexOf(b);
    const items = [];
    if (TEXTY.has(b.type)) {
      items.push({ heading: 'Turn into' });
      for (const s of SLASH.filter((s) => s.type && TEXTY.has(s.type))) {
        items.push({ icon: s.icon, label: s.label, run: () => mutate(() => {
          b.type = s.type;
          if (s.type === 'callout' && !b.variant) b.variant = 'NOTE';
          if (!LISTY.has(s.type)) b.indent = 0;
          return { id: b.id, pos: 'end' };
        }) });
      }
      items.push({ heading: 'Block' });
    }
    items.push(
      { icon: '⧉', label: 'Duplicate', run: () => mutate(() => { const c = JSON.parse(JSON.stringify(b)); c.id = uid(); blocks.splice(idx + 1, 0, c); return { id: c.id }; }) },
      { icon: '↑', label: 'Move up', run: () => idx > 0 && mutate(() => { blocks.splice(idx - 1, 0, ...blocks.splice(idx, 1)); return { id: b.id }; }) },
      { icon: '↓', label: 'Move down', run: () => idx < blocks.length - 1 && mutate(() => { blocks.splice(idx + 1, 0, ...blocks.splice(idx, 1)); return { id: b.id }; }) },
      { icon: '🗑', label: 'Delete', run: () => mutate(() => { blocks.splice(idx, 1); const n = blocks[Math.min(idx, blocks.length - 1)]; return n && { id: n.id }; }) },
    );
    openMenu({ kind: 'handle', items, pick: (it) => it.run() }, grip.getBoundingClientRect());
  }

  /* ---------- keyboard ---------- */

  const MD_SHORTCUTS = { '#': 'h1', '##': 'h2', '###': 'h3', '-': 'bullet', '*': 'bullet', '+': 'bullet', '>': 'quote', '[]': 'todo', '[ ]': 'todo' };

  function onKeyDown(e) {
    if (!editable) return;
    const t = e.target;
    if (menu && menuKey(e)) return;
    const mod = e.ctrlKey || e.metaKey;
    if (mod && e.key.toLowerCase() === 's') { e.preventDefault(); opts.onSave && opts.onSave(); return; }
    if (mod && e.key.toLowerCase() === 'k' && t.closest('.txt, td, th') && sel().rangeCount && !sel().isCollapsed) {
      e.preventDefault(); e.stopPropagation(); bar.linkMode(); return;
    }
    if (t.matches('textarea.code')) return codeKeys(e, t);
    if (t.matches('td, th')) return cellKeys(e, t);
    if (t.matches('.txt')) return textKeys(e, t);
  }

  function step(from, dir, atEnd) {
    const all = [...root.querySelectorAll(FOCUSABLE)];
    const n = all[all.indexOf(from) + dir];
    if (n) { placeCaret(n, atEnd); n.scrollIntoView({ block: 'nearest' }); return true; }
    return false;
  }

  function textKeys(e, t) {
    const b = blockOf(t);
    if (!b || e.isComposing) return;
    const inToggleBody = t.dataset.f === 'body';
    const collapsed = isCollapsed();

    if (e.key === 'Enter' && e.shiftKey) { e.preventDefault(); document.execCommand('insertLineBreak'); return; }
    if (e.key === 'Enter') {
      e.preventDefault();
      if (inToggleBody) { document.execCommand('insertLineBreak'); return; }
      if (b.type === 'toggle') { const body = t.closest('.blk').querySelector('.tg-content'); placeCaret(body, false); return; }
      return onEnter(b, t);
    }
    if (e.key === 'Backspace' && collapsed && !textBefore(t)) {
      e.preventDefault();
      return onBackspaceStart(b, t, inToggleBody);
    }
    if (e.key === 'Delete' && collapsed && !textAfter(t) && !inToggleBody && b.type !== 'toggle') {
      const nb = blocks[blocks.indexOf(b) + 1];
      if (nb && TEXTY.has(nb.type) && TEXTY.has(b.type)) {
        e.preventDefault();
        syncAll();
        const off = htmlTextLen(b.html);
        mutate(() => { b.html = b.html + nb.html; blocks.splice(blocks.indexOf(nb), 1); return { id: b.id, pos: off }; });
      }
      return;
    }
    if (e.key === 'Tab' && LISTY.has(b.type)) {
      e.preventDefault();
      const idx = blocks.indexOf(b);
      const prev = blocks[idx - 1];
      mutate(() => {
        if (e.shiftKey) b.indent = Math.max(0, b.indent - 1);
        else if (prev && LISTY.has(prev.type)) b.indent = Math.min(prev.indent + 1, 3, b.indent + 1);
        return { id: b.id, pos: 'end' };
      });
      return;
    }
    if (e.key === ' ' && b.type === 'p' && !mod && collapsed && !textAfter(t)) {
      const s = t.textContent.replace(/ /g, ' ').trim();
      const type = MD_SHORTCUTS[s] || (/^\d+\.$/.test(s) ? 'numbered' : null);
      if (type) {
        e.preventDefault();
        mutate(() => { b.type = type; b.html = ''; b.checked = false; return { id: b.id }; });
      }
      return;
    }
    if (e.shiftKey || mod || e.altKey) return;
    if (e.key === 'ArrowUp' && onFirstLine(t)) { if (step(t, -1, true)) e.preventDefault(); }
    else if (e.key === 'ArrowDown' && onLastLine(t)) { if (step(t, 1, false)) e.preventDefault(); }
    else if (e.key === 'ArrowLeft' && collapsed && !textBefore(t)) { if (step(t, -1, true)) e.preventDefault(); }
    else if (e.key === 'ArrowRight' && collapsed && !textAfter(t)) { if (step(t, 1, false)) e.preventDefault(); }
  }

  function onEnter(b, t) {
    syncAll();
    const text = t.textContent.trim();
    const empty = !text;
    if (b.type === 'p' && text === '---') {
      return mutate(() => { Object.assign(b, makeBlock('divider'), { id: b.id }); delete b.html; if (!blocks[blocks.indexOf(b) + 1]) blocks.push(makeBlock('p')); return { id: blocks[blocks.indexOf(b) + 1].id }; });
    }
    if (b.type === 'p' && text.startsWith('```')) {
      const lang = text.slice(3).trim();
      return mutate(() => { const nb = makeBlock('code'); nb.id = b.id; nb.lang = lang; blocks[blocks.indexOf(b)] = nb; return { id: nb.id }; });
    }
    if ((LISTY.has(b.type) || b.type === 'quote' || b.type === 'callout') && empty) {
      return mutate(() => {
        if (LISTY.has(b.type) && b.indent > 0) b.indent--;
        else { b.type = 'p'; b.indent = 0; }
        return { id: b.id };
      });
    }
    const r = caretRange(t);
    if (r && !r.collapsed) r.deleteContents();
    const atStart = !textBefore(t);
    if (atStart && !empty) {
      return mutate(() => { const nb = makeBlock('p'); blocks.splice(blocks.indexOf(b), 0, nb); return { id: b.id }; });
    }
    const tail = document.createRange();
    tail.selectNodeContents(t);
    const rr = caretRange(t);
    if (rr) tail.setStart(rr.endContainer, rr.endOffset);
    const holder = document.createElement('div');
    holder.append(tail.extractContents());
    b.html = t.innerHTML;
    const nextType = { bullet: 'bullet', numbered: 'numbered', todo: 'todo', quote: 'quote' }[b.type] || 'p';
    const nb = makeBlock(nextType);
    nb.html = holder.innerHTML;
    nb.indent = LISTY.has(nextType) ? b.indent : 0;
    mutate(() => { blocks.splice(blocks.indexOf(b) + 1, 0, nb); return { id: nb.id }; });
  }

  function onBackspaceStart(b, t, inToggleBody) {
    syncAll();
    if (inToggleBody || b.type === 'toggle') {
      const prev = [...root.querySelectorAll(FOCUSABLE)];
      const i = prev.indexOf(t);
      if (i > 0) placeCaret(prev[i - 1], true);
      return;
    }
    if (b.type !== 'p') {
      return mutate(() => {
        if (LISTY.has(b.type) && b.indent > 0) b.indent--;
        else { b.type = 'p'; b.indent = 0; }
        return { id: b.id };
      });
    }
    const idx = blocks.indexOf(b);
    if (idx === 0) return;
    const prev = blocks[idx - 1];
    const empty = !htmlToMd(b.html).trim();
    if (TEXTY.has(prev.type)) {
      const off = htmlTextLen(prev.html);
      mutate(() => { prev.html = prev.html + b.html; blocks.splice(idx, 1); return { id: prev.id, pos: off }; });
    } else if (prev.type === 'divider') {
      mutate(() => { blocks.splice(idx - 1, 1); return { id: b.id }; });
    } else if (empty) {
      mutate(() => { blocks.splice(idx, 1); return { id: prev.id, pos: 'end' }; });
    } else step(t, -1, true);
  }

  function codeKeys(e, ta) {
    const b = blockOf(ta);
    if (e.key === 'Tab') {
      e.preventDefault();
      document.execCommand('insertText', false, '  ');
    } else if (e.key === 'Backspace' && !ta.value && ta.selectionStart === 0) {
      e.preventDefault();
      mutate(() => { b.type = 'p'; b.html = ''; delete b.code; return { id: b.id }; });
    } else if (e.key === 'ArrowUp' && !ta.value.slice(0, ta.selectionStart).includes('\n') && ta.selectionStart === ta.selectionEnd) {
      if (step(ta, -1, true)) e.preventDefault();
    } else if (e.key === 'ArrowDown' && !ta.value.slice(ta.selectionEnd).includes('\n') && ta.selectionStart === ta.selectionEnd) {
      if (step(ta, 1, false)) e.preventDefault();
    }
  }

  function cellKeys(e, cell) {
    const b = blockOf(cell);
    const tr = cell.parentElement;
    const table = tr.parentElement;
    const rows = [...table.children];
    const r = rows.indexOf(tr), c = [...tr.children].indexOf(cell);
    const focusCell = (rr, cc, end) => { const n = rows[rr]?.children[cc]; if (n) { placeCaret(n, end); return true; } return false; };
    const addRow = () => mutate(() => { syncAll(); b.rows.push(b.rows[0].map(() => '')); return null; });
    const refocus = (rr, cc) => { const el = root.querySelector(`.blk[data-id="${b.id}"] table`); const n = el?.rows[rr]?.cells[cc]; if (n) placeCaret(n, false); };

    if (e.key === 'Tab') {
      e.preventDefault();
      if (e.shiftKey) {
        if (!focusCell(r, c - 1, true)) focusCell(r - 1, tr.children.length - 1, true);
      } else if (!focusCell(r, c + 1, false)) {
        if (!focusCell(r + 1, 0, false)) { addRow(); refocus(r + 1, 0); }
      }
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (e.shiftKey) { document.execCommand('insertLineBreak'); return; }
      if (!focusCell(r + 1, c, false)) { addRow(); refocus(r + 1, c); }
    } else if (!e.shiftKey && !e.ctrlKey && !e.metaKey) {
      if (e.key === 'ArrowUp' && onFirstLine(cell)) {
        e.preventDefault();
        if (!focusCell(r - 1, c, true)) {
          const all = [...root.querySelectorAll(FOCUSABLE)];
          const prev = all.slice(0, all.indexOf(cell)).reverse().find((n) => !table.contains(n));
          if (prev) placeCaret(prev, true);
        }
      }
      else if (e.key === 'ArrowDown' && onLastLine(cell)) {
        e.preventDefault();
        if (!focusCell(r + 1, c, false)) {
          const all = [...root.querySelectorAll(FOCUSABLE)];
          const nxt = all.slice(all.indexOf(cell) + 1).find((n) => !table.contains(n));
          if (nxt) placeCaret(nxt, false);
        }
      }
    }
  }

  /* ---------- input / click / paste / drag ---------- */

  function onInput(e) {
    const t = e.target;
    if (!editable) return;
    if (t.matches('.txt, td, th')) {
      if (!t.textContent && t.innerHTML && !t.querySelector('img,a')) t.innerHTML = '';
      const b = blockOf(t);
      if (b && t.dataset.f) b[t.dataset.f] = t.innerHTML;
      if (b && b.type === 'p' && t.dataset.f === 'html' && e.inputType === 'insertText') {
        // markdown-style shortcuts for keyboards that don't send a usable keydown (mobile, IME)
        const m = t.textContent.replace(/ /g, ' ').match(/^(\S+) $/);
        const type = m && (MD_SHORTCUTS[m[1]] || (/^\d+\.$/.test(m[1]) ? 'numbered' : null));
        if (type) {
          mutate(() => { b.type = type; b.html = ''; b.checked = false; return { id: b.id }; });
          return;
        }
      }
      if (t.matches('.txt')) refreshTriggers(t);
    } else if (t.matches('textarea.code')) autosize(t);
    changed();
  }

  function onClick(e) {
    const t = e.target;
    const act = t.closest('[data-act]');
    const blkEl = t.closest('.blk');
    const b = blkEl && get(blkEl.dataset.id);

    if (t.closest('.tg-caret') && b) {
      const open = blkEl.classList.toggle('open');
      open ? openToggles.add(b.id) : openToggles.delete(b.id);
      return;
    }
    if (act && act.dataset.act === 'copy' && b) {
      navigator.clipboard?.writeText(b.code || '');
      act.textContent = 'Copied';
      setTimeout(() => (act.textContent = 'Copy'), 1200);
      return;
    }
    const a = t.closest('a');
    if (a && editable) {
      if (e.ctrlKey || e.metaKey) {
        if (a.dataset.wiki != null) location.hash = a.getAttribute('href');
        else window.open(a.href, '_blank', 'noopener');
      }
      e.preventDefault();
      return;
    }
    if (!editable) return;

    if (t.closest('.blk-add') && b) {
      mutate(() => { const nb = makeBlock('p'); blocks.splice(blocks.indexOf(b) + 1, 0, nb); return { id: nb.id }; });
      document.execCommand('insertText', false, '/');
      return;
    }
    if (t.closest('.blk-grip')) { openBlockMenu(t.closest('.blk-grip')); return; }
    if (t.closest('.callout-icon') && b) {
      const keys = Object.keys(CALLOUTS);
      b.variant = keys[(keys.indexOf(b.variant) + 1) % keys.length];
      blkEl.querySelector('.callout').className = 'callout v-' + b.variant;
      t.closest('.callout-icon').textContent = CALLOUTS[b.variant].icon;
      changed();
      return;
    }
    if (!act || !b) { if (e.target === root) { const l = blocks[blocks.length - 1]; if (l) focusBlock(l.id, 'end'); } return; }

    const kind = act.dataset.act;
    if (kind === 'img-url') {
      const v = blkEl.querySelector('.img-url').value.trim();
      if (v && safeUrl(v)) mutate(() => { b.url = v; return null; });
    } else if (kind === 'img-upload') {
      const fi = h('input', { type: 'file', accept: 'image/*' });
      fi.onchange = () => fi.files[0] && addImageFile(fi.files[0], b);
      fi.click();
    } else if (kind === 'img-clear') mutate(() => { b.url = ''; return null; });
    else if (kind === 'row+') mutate(() => { b.rows.push(b.rows[0].map(() => '')); return { id: b.id, pos: 'end' }; });
    else if (kind === 'col+') mutate(() => { b.rows.forEach((r) => r.push('')); return { id: b.id }; });
    else if (kind === 'row-') mutate(() => { if (b.rows.length > 1) b.rows.pop(); return { id: b.id, pos: 'end' }; });
    else if (kind === 'col-') mutate(() => { if (b.rows[0].length > 1) b.rows.forEach((r) => r.pop()); return { id: b.id }; });
  }

  root.addEventListener('keydown', (e) => {
    if (e.target.matches('.img-url') && e.key === 'Enter') {
      e.preventDefault();
      e.target.closest('.blk').querySelector('[data-act="img-url"]').click();
      return;
    }
    onKeyDown(e);
  });
  root.addEventListener('input', onInput);
  root.addEventListener('click', onClick);
  root.addEventListener('change', (e) => {
    if (e.target.matches('.todo-cb') && editable) {
      const b = blockOf(e.target);
      b.checked = e.target.checked;
      e.target.closest('.li').classList.toggle('done', b.checked);
      changed();
    }
  });
  root.addEventListener('focusout', () => setTimeout(() => {
    if (menu && menu.kind !== 'handle' && !root.contains(document.activeElement)) closeMenu();
  }, 0));
  const onDocDown = (e) => { if (menu && !menuEl.contains(e.target)) closeMenu(); };
  document.addEventListener('mousedown', onDocDown);

  async function addImageFile(file, after) {
    if (file.size > 5 * 1024 * 1024) { opts.toast && opts.toast('That image is over 5 MB — please use a smaller one.'); return; }
    const dataUrl = await readAsDataURL(file);
    const safe = (file.name || 'image.png').toLowerCase().replace(/[^a-z0-9._-]+/g, '-');
    const ext = /\.\w+$/.test(safe) ? '' : '.' + (file.type.split('/')[1] || 'png');
    const { repoPath, mdUrl } = (opts.uploadPath || ((n) => ({ repoPath: 'assets/' + n, mdUrl: 'assets/' + n })))(`${Date.now().toString(36)}-${safe}${ext}`);
    uploads.set(mdUrl, { repoPath, b64: dataUrl.split(',')[1], preview: dataUrl });
    mutate(() => {
      if (after && after.type === 'image' && !after.url) { after.url = mdUrl; return { id: after.id }; }
      const nb = makeBlock('image');
      nb.url = mdUrl;
      if (after) insertAfter(after, nb, { replaceEmpty: true });
      else blocks.push(nb);
      return { id: nb.id };
    });
  }

  root.addEventListener('paste', (e) => {
    if (!editable) return;
    const t = e.target;
    const files = [...(e.clipboardData.files || [])].filter((f) => f.type.startsWith('image/'));
    if (files.length) { e.preventDefault(); addImageFile(files[0], blockOf(t)); return; }
    if (t.matches('textarea,input')) return;
    const text = e.clipboardData.getData('text/plain');
    if (!text) { e.preventDefault(); return; }
    e.preventDefault();
    const multi = text.replace(/\r/g, '').trim().includes('\n');
    if (multi && t.matches('.txt') && t.dataset.f === 'html') {
      const parsed = parseBlocks(text);
      if (parsed.length) {
        syncAll();
        const b = blockOf(t);
        const r = caretRange(t);
        if (r && !r.collapsed) r.deleteContents();
        mutate(() => {
          const idx = blocks.indexOf(b);
          if (!textBefore(t) && !htmlToMd(b.html).trim()) blocks.splice(idx, 1, ...parsed);
          else blocks.splice(idx + 1, 0, ...parsed);
          return { id: parsed[parsed.length - 1].id, pos: 'end' };
        });
        return;
      }
    }
    const flat = text.replace(/\r?\n/g, multi && t.dataset.f === 'body' ? '\n' : ' ').trim();
    if (!sel().isCollapsed && /^https?:\/\/\S+$/.test(flat) && t.matches('.txt')) document.execCommand('createLink', false, flat);
    else if (t.dataset.f === 'body') document.execCommand('insertHTML', false, esc(text.trim()).replace(/\r?\n+/g, '<br>'));
    else document.execCommand('insertText', false, flat);
  });

  // drag & drop reordering
  let dragId = null;
  root.addEventListener('dragstart', (e) => {
    const grip = e.target.closest?.('.blk-grip');
    if (!grip) return;
    dragId = grip.closest('.blk').dataset.id;
    e.dataTransfer.setData('text/plain', 'block');
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setDragImage(grip.closest('.blk'), 0, 0);
  });
  const clearDrop = () => root.querySelectorAll('.drop-before,.drop-after').forEach((n) => n.classList.remove('drop-before', 'drop-after'));
  root.addEventListener('dragover', (e) => {
    if (!editable) return;
    const hasFiles = [...(e.dataTransfer?.types || [])].includes('Files');
    if (!dragId && !hasFiles) return;
    e.preventDefault();
    const el = e.target.closest('.blk');
    clearDrop();
    if (!el) return;
    const r = el.getBoundingClientRect();
    el.classList.add(e.clientY > r.top + r.height / 2 ? 'drop-after' : 'drop-before');
  });
  root.addEventListener('dragleave', (e) => { if (!root.contains(e.relatedTarget)) clearDrop(); });
  root.addEventListener('dragend', () => { dragId = null; clearDrop(); });
  root.addEventListener('drop', (e) => {
    if (!editable) return;
    const el = e.target.closest('.blk');
    const after = el?.classList.contains('drop-after');
    clearDrop();
    const files = [...(e.dataTransfer.files || [])].filter((f) => f.type.startsWith('image/'));
    if (!dragId && files.length) { e.preventDefault(); addImageFile(files[0], el && get(el.dataset.id)); return; }
    if (!dragId || !el) return;
    e.preventDefault();
    const target = get(el.dataset.id);
    const moving = get(dragId);
    dragId = null;
    if (!target || !moving || target === moving) return;
    mutate(() => {
      blocks.splice(blocks.indexOf(moving), 1);
      blocks.splice(blocks.indexOf(target) + (after ? 1 : 0), 0, moving);
      return { id: moving.id };
    });
  });

  /* ---------- floating format bar ---------- */

  const bar = (() => {
    const input = h('input', { class: 'bar-link', placeholder: 'Paste a link and press Enter', spellcheck: 'false' });
    const mk = (label, title, cmd, cls = '') =>
      h('button', { class: 'bar-btn ' + cls, title, 'data-cmd': cmd, onmousedown: (e) => e.preventDefault(), onclick: () => run(cmd) }, label);
    const row = h('div', { class: 'bar-row' },
      mk('B', 'Bold (Ctrl+B)', 'bold', 'b'), mk('I', 'Italic (Ctrl+I)', 'italic', 'i'), mk('S', 'Strikethrough', 'strikeThrough', 's'),
      mk('</>', 'Inline code', 'code', 'c'), mk('🔗', 'Link (Ctrl+K)', 'link'));
    const el = h('div', { class: 'sel-bar', hidden: true }, row, h('div', { class: 'bar-link-row' }, input));
    document.body.append(el);
    let saved = null;
    const closestFrom = (n, tag) => (n.nodeType === 3 ? n.parentElement : n).closest(tag);

    function run(cmd) {
      if (cmd === 'code') return toggleCode();
      if (cmd === 'link') return linkMode();
      document.execCommand(cmd);
      update();
    }
    function toggleCode() {
      const r = sel().getRangeAt(0);
      const c = closestFrom(r.commonAncestorContainer, 'code');
      if (c) {
        const tn = document.createTextNode(c.textContent);
        const host = c.closest('.txt, td, th');
        c.replaceWith(tn);
        host.dispatchEvent(new Event('input', { bubbles: true }));
      } else document.execCommand('insertHTML', false, `<code>${esc(sel().toString())}</code>`);
      update();
    }
    function linkMode() {
      const s = sel();
      if (!s.rangeCount) return;
      const a = closestFrom(s.getRangeAt(0).commonAncestorContainer, 'a');
      if (a && a.dataset.wiki == null) { document.execCommand('unlink'); update(); return; }
      saved = s.getRangeAt(0).cloneRange();
      el.classList.add('link-mode');
      input.value = '';
      input.focus();
    }
    function applyLink() {
      let u = input.value.trim();
      if (u && !/^[a-z][\w+.-]*:/i.test(u) && /^[\w-]+(\.[\w-]+)+/.test(u)) u = 'https://' + u;
      el.classList.remove('link-mode');
      if (!saved) return;
      const s = sel();
      s.removeAllRanges();
      s.addRange(saved);
      if (u && safeUrl(u)) document.execCommand('createLink', false, u);
      saved = null;
      update();
    }
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); applyLink(); }
      if (e.key === 'Escape') { e.preventDefault(); el.classList.remove('link-mode'); if (saved) { sel().removeAllRanges(); sel().addRange(saved); } saved = null; }
    });
    function hide() { el.hidden = true; el.classList.remove('link-mode'); }
    function update() {
      if (!editable) return hide();
      if (el.contains(document.activeElement)) return;
      const s = sel();
      if (!s.rangeCount || s.isCollapsed) return hide();
      const r = s.getRangeAt(0);
      const host = closestFrom(r.commonAncestorContainer, '.txt[contenteditable], td[contenteditable], th[contenteditable]');
      if (!host || !root.contains(host)) return hide();
      const rect = r.getBoundingClientRect();
      if (!rect.width && !rect.height) return hide();
      el.hidden = false;
      for (const b of el.querySelectorAll('[data-cmd]')) {
        const c = b.dataset.cmd;
        let on = false;
        try {
          if (c === 'code') on = !!closestFrom(r.commonAncestorContainer, 'code');
          else if (c === 'link') on = !!closestFrom(r.commonAncestorContainer, 'a');
          else on = document.queryCommandState(c);
        } catch {}
        b.classList.toggle('on', on);
      }
      const w = el.offsetWidth, hgt = el.offsetHeight;
      let top = rect.top - hgt - 8;
      if (top < 8) top = rect.bottom + 8;
      el.style.top = top + 'px';
      el.style.left = Math.max(8, Math.min(innerWidth - w - 8, rect.left + rect.width / 2 - w / 2)) + 'px';
    }
    return { el, update, hide, linkMode };
  })();
  const onSelChange = () => bar.update();
  document.addEventListener('selectionchange', onSelChange);
  const onScroll = () => { if (!bar.el.hidden) bar.update(); };
  window.addEventListener('scroll', onScroll, true);

  /* ---------- public api ---------- */

  render();
  return {
    setEditable(v) { syncAll(); editable = !!v; bar.hide(); closeMenu(); render(); },
    getMarkdown() { syncAll(); return blocksToMd(blocks, htmlToMd); },
    headings() {
      syncAll();
      return blocks.filter((b) => /^h[123]$/.test(b.type)).map((b) => ({ id: b.id, level: +b.type[1], text: htmlToMd(b.html).replace(/\\(.)/g, '$1').replace(/[*~`]|<br>/g, '') })).filter((x) => x.text.trim());
    },
    pendingUploads() {
      syncAll();
      const used = new Set(blocks.filter((b) => b.type === 'image').map((b) => b.url));
      return [...uploads.entries()].filter(([u]) => used.has(u)).map(([, v]) => ({ path: v.repoPath, b64: v.b64 }));
    },
    focusEnd() { const l = blocks[blocks.length - 1]; if (l) focusBlock(l.id, 'end'); },
    focusStart() { if (blocks[0]) focusBlock(blocks[0].id, 'start'); },
    destroy() {
      menuEl.remove();
      bar.el.remove();
      document.removeEventListener('selectionchange', onSelChange);
      document.removeEventListener('mousedown', onDocDown);
      window.removeEventListener('scroll', onScroll, true);
      root.textContent = '';
    },
  };
}
