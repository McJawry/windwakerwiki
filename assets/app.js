// app.js — routing, sidebar, search, page view, editing session and the save / pull-request flow.
import { h, $, $$ } from './dom.js';
import { createEditor } from './editor.js';
import { parseBlocks, parseFrontMatter, stringifyFrontMatter, plainText, extractLinks, slugify } from './md.js';
import { tokenStore, getUser, getRepo, publish } from './github.js';

/* ------------------------------------------------------------------ state */

let cfg = {};
let index = [];            // [{id,file,title,icon,tags,order,text,links}]
let byId = new Map();
let backlinks = new Map(); // id -> [page ids linking here]
let tree = null;
const mdCache = new Map(); // id -> markdown source
const pendingNew = new Map(); // id -> {file, title}
let cur = null;            // the page currently on screen
let me = null;             // GitHub user
let repoInfo = null;
let lastHash = '';
const toggleKey = 'wiki:expanded';

const store = {
  get(k, d = null) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
  del(k) { try { localStorage.removeItem(k); } catch {} },
};

/* ------------------------------------------------------------------ boot */

async function loadConfig() {
  let c = {};
  try { c = await (await fetch('config.json', { cache: 'no-cache' })).json(); } catch {}
  c = { title: 'Wiki', icon: '📚', contentDir: 'wiki', repo: '', branch: '', directCommit: true, ...c };
  c.contentDir = c.contentDir.replace(/^\/+|\/+$/g, '');
  if (!c.repo) {
    const m = location.hostname.match(/^([^.]+)\.github\.io$/i);
    if (m) {
      const seg = location.pathname.split('/').filter(Boolean)[0];
      c.repo = `${m[1]}/${seg && seg !== 'index.html' ? seg : m[1] + '.github.io'}`;
    }
  }
  return c;
}

async function loadIndex() {
  try {
    const r = await fetch(`${cfg.contentDir}/_index.json?v=${Date.now()}`, { cache: 'no-cache' });
    const j = await r.json();
    index = j.pages || [];
  } catch { index = []; }
  applyOverlay();
  rebuild();
}

function rebuild() {
  byId = new Map(index.map((p) => [p.id, p]));
  backlinks = new Map();
  for (const p of index) {
    for (const t of p.links || []) {
      const target = resolvePage(t);
      if (target && target.id !== p.id) {
        if (!backlinks.has(target.id)) backlinks.set(target.id, new Set());
        backlinks.get(target.id).add(p.id);
      }
    }
  }
  tree = buildTree();
}

/* Recent saves are remembered locally for a while so edits show up before GitHub Pages redeploys. */
function applyOverlay() {
  const ov = store.get('wiki:overlay', {});
  const now = Date.now();
  let dirty = false;
  for (const [id, o] of Object.entries(ov)) {
    if (now - o.ts > 15 * 60 * 1000) { delete ov[id]; dirty = true; continue; }
    if (o.deleted) { index = index.filter((p) => p.id !== id); continue; }
    mdCache.set(id, o.md);
    upsertIndex(id, o.file, o.md);
  }
  if (dirty) store.set('wiki:overlay', ov);
}
function setOverlay(id, o) {
  const ov = store.get('wiki:overlay', {});
  ov[id] = { ...o, ts: Date.now() };
  store.set('wiki:overlay', ov);
}
function upsertIndex(id, file, md) {
  const { meta, body } = parseFrontMatter(md);
  const entry = {
    id, file,
    title: meta.title || titleFromId(id),
    icon: meta.icon || '',
    tags: Array.isArray(meta.tags) ? meta.tags : meta.tags ? [meta.tags] : [],
    order: meta.order != null && meta.order !== '' ? Number(meta.order) : null,
    text: plainText(body).slice(0, 5000),
    links: extractLinks(body),
  };
  const i = index.findIndex((p) => p.id === id);
  if (i >= 0) index[i] = entry; else index.push(entry);
}

/* ------------------------------------------------------------------ helpers */

const titleFromId = (id) => {
  const last = id.split('/').pop().replace(/[-_]+/g, ' ');
  return last.charAt(0).toUpperCase() + last.slice(1);
};
const hrefFor = (id) => '#/' + (id === 'index' ? '' : id.split('/').map(encodeURIComponent).join('/'));
const parentOf = (id) => (id.includes('/') ? id.slice(0, id.lastIndexOf('/')) : null);
const nodeTitle = (id) => byId.get(id)?.title || titleFromId(id);

function resolvePage(target) {
  const t = String(target).trim().toLowerCase();
  if (!t) return null;
  if (byId.has(t)) return byId.get(t);
  const direct = index.find((p) => p.id.toLowerCase() === t);
  if (direct) return direct;
  const byTitle = index.find((p) => p.title.toLowerCase() === t);
  if (byTitle) return byTitle;
  return byId.get(slugify(target)) || null;
}
function resolveWiki(target) {
  const p = resolvePage(target);
  return p ? { href: hrefFor(p.id), exists: true } : { href: '#/' + (slugify(target) || 'new-page'), exists: false };
}
function resolveUrl(url) {
  if (!cur || /^(https?:|data:|blob:|\/\/)/i.test(url)) return url;
  return new URL(url, new URL(`${cfg.contentDir}/${cur.file}`, location.href)).href;
}
function uploadPath(name) {
  const depth = cur.file.split('/').length - 1;
  return { repoPath: `${cfg.contentDir}/assets/${name}`, mdUrl: '../'.repeat(depth) + 'assets/' + name };
}

function buildTree() {
  const nodes = new Map();
  const ensure = (id) => {
    if (nodes.has(id)) return nodes.get(id);
    const n = { id, children: [], page: null };
    nodes.set(id, n);
    const pid = parentOf(id);
    if (pid) ensure(pid).children.push(n);
    return n;
  };
  for (const p of index) ensure(p.id).page = p;
  const sort = (n) => {
    n.children.sort((a, b) => {
      const ao = a.page?.order ?? 1e9, bo = b.page?.order ?? 1e9;
      return ao - bo || nodeTitle(a.id).localeCompare(nodeTitle(b.id), undefined, { sensitivity: 'base' });
    });
    n.children.forEach(sort);
  };
  const roots = [...nodes.values()].filter((n) => !parentOf(n.id) && n.id !== 'index');
  const top = { id: '', children: roots };
  sort(top);
  return { nodes, top };
}

function dirFor(parentId) {
  if (!parentId || parentId === 'index') return '';
  const p = byId.get(parentId);
  if (!p) return parentId;
  return p.file.endsWith('/index.md') ? p.file.slice(0, -'/index.md'.length) : p.file.replace(/\.md$/, '');
}

/* ------------------------------------------------------------------ toast / modal */

let toastTimer;
function toast(msg, ms = 3500) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('on');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('on'), ms);
}

function modal({ title, body, actions = [], wide = false, onClose }) {
  const ov = $('#overlay');
  ov.hidden = false;
  const close = () => { ov.hidden = true; ov.textContent = ''; document.removeEventListener('keydown', esc_); onClose && onClose(); };
  const esc_ = (e) => { if (e.key === 'Escape') close(); };
  document.addEventListener('keydown', esc_);
  const box = h('div', { class: 'modal' + (wide ? ' wide' : ''), role: 'dialog', 'aria-modal': 'true', 'aria-label': title },
    title ? h('h2', {}, title) : null,
    h('div', { class: 'modal-body' }, body),
    actions.length ? h('div', { class: 'modal-actions' }, actions.map((a) => h('button', {
      class: 'btn ' + (a.primary ? 'primary' : a.danger ? 'danger' : ''), type: 'button',
      onclick: () => a.onClick ? a.onClick({ close, btn: box }) : close(),
    }, a.label))) : null);
  ov.textContent = '';
  ov.append(h('div', { class: 'modal-bg', onmousedown: (e) => { if (e.target === e.currentTarget) close(); } }, box));
  setTimeout(() => box.querySelector('input,textarea,button.primary')?.focus(), 30);
  return { close, box };
}

/* ------------------------------------------------------------------ sidebar */

function renderTree() {
  const el = $('#tree');
  el.textContent = '';
  const expanded = new Set(store.get(toggleKey, []));
  const activeChain = new Set();
  if (cur) { let p = cur.id; while (p) { activeChain.add(p); p = parentOf(p); } }

  const item = (node, depth) => {
    const open = expanded.has(node.id) || (activeChain.has(node.id) && node.id !== cur?.id) || (node.id === cur?.id && expanded.has(node.id));
    const title = nodeTitle(node.id);
    const icon = node.page?.icon || (node.children.length ? '📁' : '📄');
    const row = h('div', { class: 'tr' + (cur?.id === node.id ? ' active' : '') + (node.page ? '' : ' virtual'), style: `--d:${depth}` },
      node.children.length
        ? h('button', { class: 'caret' + (open ? ' open' : ''), 'aria-label': open ? 'Collapse' : 'Expand', onclick: (e) => {
            e.preventDefault();
            const s = new Set(store.get(toggleKey, []));
            const isOpen = $$('.tr', el).length && e.currentTarget.classList.contains('open');
            isOpen ? s.delete(node.id) : s.add(node.id);
            activeChain.delete(node.id);
            store.set(toggleKey, [...s]);
            renderTree();
          } }, '▸')
        : h('span', { class: 'caret empty' }),
      h('a', { class: 'tr-link', href: hrefFor(node.id), title, onclick: () => $('#app').classList.remove('side-open') },
        h('span', { class: 'tr-ic' }, icon), h('span', { class: 'tr-tx' }, title)),
      h('button', { class: 'tr-add', title: 'Add a page inside', 'aria-label': 'Add subpage', onclick: (e) => { e.preventDefault(); startNewPage(node.id); } }, '+'));
    const wrap = h('div', { class: 'tn' }, row);
    if (node.children.length && open) wrap.append(h('div', { class: 'tc' }, node.children.map((c) => item(c, depth + 1))));
    return wrap;
  };

  const home = byId.get('index');
  el.append(item({ id: 'index', page: home || { title: 'Home', icon: '🏠' }, children: [] }, 0));
  tree.top.children.forEach((n) => el.append(item(n, 0)));
  if (!index.length) el.append(h('p', { class: 'muted pad' }, 'No pages yet.'));
}

/* ------------------------------------------------------------------ search */

function searchPages(q) {
  q = q.trim().toLowerCase();
  if (!q) return index.slice().sort((a, b) => a.title.localeCompare(b.title)).slice(0, 30).map((p) => ({ p, score: 0 }));
  const tagOnly = q.startsWith('#');
  const terms = q.replace(/^#/, '').split(/\s+/).filter(Boolean);
  const out = [];
  for (const p of index) {
    const title = p.title.toLowerCase(), text = (p.text || '').toLowerCase(), tags = (p.tags || []).map((t) => t.toLowerCase());
    let score = 0, ok = true;
    for (const t of terms) {
      let s = 0;
      if (title.includes(t)) s += title.startsWith(t) ? 15 : 10;
      if (tags.some((x) => x.includes(t))) s += 6;
      if (!tagOnly && text.includes(t)) s += 2;
      if (p.id.includes(t)) s += 1;
      if (!s || (tagOnly && !tags.some((x) => x.includes(t)))) { ok = false; break; }
      score += s;
    }
    if (ok) out.push({ p, score, terms });
  }
  return out.sort((a, b) => b.score - a.score).slice(0, 30);
}
function snippet(p, terms) {
  const text = p.text || '';
  if (!terms || !terms.length) return text.slice(0, 110);
  const lower = text.toLowerCase();
  let at = -1;
  for (const t of terms) { at = lower.indexOf(t); if (at >= 0) break; }
  if (at < 0) return text.slice(0, 110);
  const s = Math.max(0, at - 35);
  return (s ? '…' : '') + text.slice(s, s + 130);
}
function openSearch(initial = '') {
  let results = [], sel = 0;
  const input = h('input', { class: 'search-input', placeholder: 'Search pages…  (try #tag)', value: initial, autocomplete: 'off', spellcheck: 'false' });
  const list = h('div', { class: 'search-list', role: 'listbox' });
  const { close } = modal({ body: [input, list], wide: false });
  const go = (r) => { close(); location.hash = hrefFor(r.p.id); };
  const draw = () => {
    results = searchPages(input.value);
    sel = Math.min(sel, Math.max(0, results.length - 1));
    list.textContent = '';
    if (!results.length) list.append(h('p', { class: 'muted pad' }, 'No matching pages.'));
    results.forEach((r, i) => list.append(h('a', {
      class: 'search-item' + (i === sel ? ' on' : ''), href: hrefFor(r.p.id), onclick: (e) => { e.preventDefault(); go(r); },
      onmousemove: () => { sel = i; $$('.search-item', list).forEach((n, k) => n.classList.toggle('on', k === i)); },
    }, h('span', { class: 'tr-ic' }, r.p.icon || '📄'), h('span', { class: 'si-tx' }, h('b', {}, r.p.title),
      h('small', {}, parentOf(r.p.id) ? parentOf(r.p.id).split('/').map(titleFromId).join(' / ') + (input.value ? ' — ' : '') : '', input.value ? snippet(r.p, r.terms) : '')))));
  };
  input.addEventListener('input', () => { sel = 0; draw(); });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); sel = Math.min(results.length - 1, sel + 1); draw(); list.querySelector('.on')?.scrollIntoView({ block: 'nearest' }); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); sel = Math.max(0, sel - 1); draw(); list.querySelector('.on')?.scrollIntoView({ block: 'nearest' }); }
    else if (e.key === 'Enter' && results[sel]) { e.preventDefault(); go(results[sel]); }
  });
  draw();
}

/* ------------------------------------------------------------------ routing + page view */

const routeId = () => {
  const raw = location.hash.replace(/^#\/?/, '').replace(/\/+$/, '');
  if (!raw) return 'index';
  try { return decodeURIComponent(raw); } catch { return raw; }
};

async function fetchMd(p) {
  if (mdCache.has(p.id)) return mdCache.get(p.id);
  const r = await fetch(`${cfg.contentDir}/${p.file.split('/').map(encodeURIComponent).join('/')}?v=${Date.now()}`, { cache: 'no-cache' });
  if (!r.ok) throw new Error(`Could not load ${p.file} (${r.status})`);
  const md = await r.text();
  mdCache.set(p.id, md);
  return md;
}

let renderToken = 0;
async function route() {
  const id = routeId();
  const token = ++renderToken;
  teardown();
  window.scrollTo(0, 0);
  $('#scroll').scrollTop = 0;
  lastHash = location.hash;

  const p = byId.get(id);
  const pending = pendingNew.get(id);
  if (p) {
    let md;
    try { md = await fetchMd(p); } catch (e) { if (token === renderToken) showMessage('😕', 'This page could not be loaded', e.message); return; }
    if (token !== renderToken) return;
    mount({ id, file: p.file, md, isNew: false });
  } else if (pending) {
    mount({ id, file: pending.file, md: stringifyFrontMatter({ title: pending.title }), isNew: true });
    setMode('edit');
  } else {
    renderMissing(id);
  }
}

function showMessage(icon, title, text, extra) {
  $('#page').textContent = '';
  $('#page').append(h('div', { class: 'nopage' }, h('div', { class: 'big' }, icon), h('h1', {}, title), h('p', { class: 'muted' }, text), extra));
  $('#toc').textContent = '';
  $('#actions').textContent = '';
  $('#crumbs').textContent = '';
  renderTree();
}

function renderMissing(id) {
  cur = null;
  const isFolder = tree.nodes.has(id);
  if (isFolder) {
    const node = tree.nodes.get(id);
    showMessage('📁', titleFromId(id), 'This is a folder of pages.', h('div', { class: 'cards' }, node.children.map((c) => childCard(c))));
    document.title = `${titleFromId(id)} · ${cfg.title}`;
    renderCrumbs(id);
    return;
  }
  showMessage('🫥', "This page doesn't exist yet", `Nothing lives at “${id}”. You can create it now.`,
    h('button', { class: 'btn primary', onclick: () => createPending(id, titleFromId(id)) }, `Create “${titleFromId(id)}”`));
  document.title = `Not found · ${cfg.title}`;
  renderCrumbs(id);
}

function childCard(n) {
  const p = n.page;
  return h('a', { class: 'card', href: hrefFor(n.id) },
    h('span', { class: 'card-ic' }, p?.icon || (n.children.length ? '📁' : '📄')),
    h('span', { class: 'card-tx' }, h('b', {}, nodeTitle(n.id)), h('small', {}, p ? (p.text || '').slice(0, 90) : `${n.children.length} page${n.children.length === 1 ? '' : 's'}`)));
}

function renderCrumbs(id) {
  const c = $('#crumbs');
  c.textContent = '';
  const parts = [];
  let p = parentOf(id);
  while (p) { parts.unshift(p); p = parentOf(p); }
  c.append(h('a', { href: '#/' }, cfg.icon + ' ' + cfg.title));
  parts.forEach((x) => c.append(h('span', { class: 'sep' }, '/'), h('a', { href: hrefFor(x) }, nodeTitle(x))));
  if (id !== 'index') c.append(h('span', { class: 'sep' }, '/'), h('span', { class: 'here' }, cur?.meta?.title || nodeTitle(id)));
}

function teardown() {
  if (cur?.editor) cur.editor.destroy();
  cur = null;
}

function mount({ id, file, md, isNew }) {
  const { meta, body } = parseFrontMatter(md);
  cur = {
    id, file, isNew, mode: 'view', dirty: false, md0: md,
    meta: { ...meta, tags: Array.isArray(meta.tags) ? [...meta.tags] : meta.tags ? [meta.tags] : [] },
    editor: null,
  };
  const blocks = parseBlocks(body);
  cur.editorHost = h('div', { class: 'editor' });
  cur.editor = createEditor(cur.editorHost, {
    blocks, editable: false, onChange: markDirty, onSave: startSave, toast, resolveWiki, resolveUrl, uploadPath,
    pages: () => index.map((p) => ({ id: p.id, title: p.title, icon: p.icon })),
  });
  drawPage();
  document.title = `${cur.meta.title || titleFromId(id)} · ${cfg.title}`;
}

/* The editor host element lives for the whole page; everything around it is redrawn on mode changes. */
function drawPage() {
  const page = $('#page');
  const edit = cur.mode === 'edit';
  page.textContent = '';
  const title = cur.meta.title || '';

  const iconBtn = h('button', { class: 'page-icon' + (cur.meta.icon ? '' : ' none'), type: 'button', disabled: !edit, 'aria-label': 'Page icon',
    onclick: (e) => edit && pickIcon(e.currentTarget) }, cur.meta.icon || (edit ? '☺ Add icon' : ''));
  const titleEl = h('h1', { class: 'page-title', 'data-ph': 'Untitled' }, title);
  if (edit) {
    titleEl.contentEditable = 'true';
    titleEl.spellcheck = true;
    titleEl.addEventListener('input', () => { cur.meta.title = titleEl.textContent.replace(/\s+/g, ' '); markDirty(); });
    titleEl.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); cur.editor.focusStart(); } });
    titleEl.addEventListener('paste', (e) => { e.preventDefault(); document.execCommand('insertText', false, e.clipboardData.getData('text/plain').replace(/\s+/g, ' ')); });
  }
  const tags = h('div', { class: 'tags' });
  drawTags(tags, edit);

  page.append(iconBtn, titleEl, tags, cur.editorHost);
  if (!edit) {
    const kids = tree.nodes.get(cur.id)?.children || [];
    if (kids.length) page.append(h('section', { class: 'rel' }, h('h3', {}, 'Pages inside'), h('div', { class: 'cards' }, kids.map(childCard))));
    const bl = [...(backlinks.get(cur.id) || [])].map((x) => byId.get(x)).filter(Boolean);
    if (bl.length) page.append(h('section', { class: 'rel' }, h('h3', {}, 'Linked from'), h('div', { class: 'chips' },
      bl.map((p) => h('a', { class: 'chip', href: hrefFor(p.id) }, (p.icon || '📄') + ' ' + p.title)))));
  }
  renderActions();
  renderCrumbs(cur.id);
  renderTree();
  renderToc();
  if (edit && cur.isNew) setTimeout(() => (cur.meta.title ? cur.editor.focusStart() : titleEl.focus()), 20);
}

function drawTags(box, edit) {
  box.textContent = '';
  const tags = cur.meta.tags;
  tags.forEach((t) => box.append(edit
    ? h('span', { class: 'tag' }, '#' + t, h('button', { class: 'x', 'aria-label': 'Remove tag ' + t, onclick: () => { tags.splice(tags.indexOf(t), 1); markDirty(); drawTags(box, edit); } }, '×'))
    : h('a', { class: 'tag', href: '#', onclick: (e) => { e.preventDefault(); openSearch('#' + t); } }, '#' + t)));
  if (edit) {
    const inp = h('input', { class: 'tag-in', placeholder: tags.length ? '' : 'Add tags…', 'aria-label': 'Add tag' });
    const add = () => {
      const v = inp.value.split(',').map((s) => s.trim().replace(/^#/, '').replace(/[\[\]"]/g, '')).filter(Boolean);
      v.forEach((x) => !tags.includes(x) && tags.push(x));
      if (v.length) { markDirty(); drawTags(box, edit); box.querySelector('.tag-in').focus(); }
    };
    inp.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); add(); }
      else if (e.key === 'Backspace' && !inp.value && tags.length) { tags.pop(); markDirty(); drawTags(box, edit); box.querySelector('.tag-in').focus(); }
    });
    inp.addEventListener('blur', add);
    box.append(inp);
  }
}

const EMOJI = '📄 📚 📖 📝 📌 📎 🗂️ 📁 🏠 💡 ✅ ⚠️ 🔥 ⭐ 🎯 🚀 🛠️ ⚙️ 🔒 🔑 🧭 🗺️ 📅 ⏰ 👥 💬 📣 🎨 🎮 🧪 🔬 💻 🌐 🍎 🌱 🐛 ❓ ❤️ 🏆 📊 📈 🧩 🪄 🎓 🏗️ 🧰 📦 🔗 ✨'.split(' ');
function pickIcon(anchor) {
  const { close } = modal({
    title: 'Choose an icon',
    body: h('div', { class: 'emoji-grid' },
      EMOJI.map((e) => h('button', { type: 'button', onclick: () => { cur.meta.icon = e; markDirty(); close(); drawPage(); } }, e)),
      h('input', { class: 'emoji-in', placeholder: 'Or type any emoji', maxlength: '8', onkeydown: (ev) => { if (ev.key === 'Enter' && ev.target.value.trim()) { cur.meta.icon = ev.target.value.trim(); markDirty(); close(); drawPage(); } } })),
    actions: [cur.meta.icon ? { label: 'Remove icon', onClick: ({ close }) => { delete cur.meta.icon; markDirty(); close(); drawPage(); } } : null, { label: 'Close' }].filter(Boolean),
  });
}

function renderToc() {
  const toc = $('#toc');
  toc.textContent = '';
  if (!cur) return;
  const hs = cur.editor.headings();
  if (hs.length < 2) return;
  toc.append(h('div', { class: 'toc-t' }, 'On this page'));
  hs.forEach((x) => toc.append(h('a', { class: 'toc-i l' + x.level, href: '#', onclick: (e) => { e.preventDefault(); document.getElementById('b-' + x.id)?.scrollIntoView({ behavior: 'smooth', block: 'start' }); } }, x.text)));
}

function renderActions() {
  const a = $('#actions');
  a.textContent = '';
  if (!cur) return;
  if (cur.mode === 'edit') {
    a.append(
      h('button', { class: 'btn', type: 'button', onclick: discard }, 'Discard'),
      h('button', { class: 'btn primary', type: 'button', onclick: startSave }, 'Save…'));
    return;
  }
  a.append(
    h('button', { class: 'btn', type: 'button', onclick: () => setMode('edit') }, '✎ Edit'),
    h('button', { class: 'btn icon', type: 'button', 'aria-label': 'More', title: 'More', onclick: (e) => moreMenu(e.currentTarget) }, '⋯'));
}

function moreMenu(anchor) {
  const items = [
    ['＋  New page inside this one', () => startNewPage(cur.id)],
    ['🔗  Copy link', () => navigator.clipboard?.writeText(location.href).then(() => toast('Link copied'))],
    cfg.repo ? ['↗  View source on GitHub', () => window.open(`https://github.com/${cfg.repo}/blob/${cfg.branch || 'HEAD'}/${cfg.contentDir}/${cur.file}`, '_blank', 'noopener')] : null,
    cur.id !== 'index' ? ['🗑  Delete page…', () => deletePage(), true] : null,
  ].filter(Boolean);
  const r = anchor.getBoundingClientRect();
  const menu = h('div', { class: 'pop', style: `top:${r.bottom + 6}px;right:${Math.max(8, innerWidth - r.right)}px` },
    items.map(([label, fn, danger]) => h('button', { class: danger ? 'danger' : '', onclick: () => { closePop(); fn(); } }, label)));
  const closePop = () => { menu.remove(); document.removeEventListener('mousedown', away, true); };
  const away = (e) => { if (!menu.contains(e.target)) closePop(); };
  document.body.append(menu);
  setTimeout(() => document.addEventListener('mousedown', away, true), 0);
}

/* ------------------------------------------------------------------ edit session */

function currentMd() {
  const meta = {};
  if (cur.meta.title) meta.title = cur.meta.title.trim();
  if (cur.meta.icon) meta.icon = cur.meta.icon;
  if (cur.meta.tags.length) meta.tags = cur.meta.tags;
  if (cur.meta.order != null && cur.meta.order !== '') meta.order = cur.meta.order;
  return stringifyFrontMatter(meta) + cur.editor.getMarkdown().trim() + '\n';
}

let draftTimer;
function markDirty() {
  if (!cur || cur.mode !== 'edit') return;
  cur.dirty = true;
  clearTimeout(draftTimer);
  draftTimer = setTimeout(() => cur && cur.mode === 'edit' && store.set('wiki:draft:' + cur.id, { md: currentMd(), ts: Date.now() }), 900);
  clearTimeout(markDirty.t);
  markDirty.t = setTimeout(renderToc, 600);
}

function setMode(mode) {
  if (!cur) return;
  cur.mode = mode;
  cur.editor.setEditable(mode === 'edit');
  document.body.classList.toggle('editing', mode === 'edit');
  if (mode === 'edit' && !cur.isNew) {
    const d = store.get('wiki:draft:' + cur.id);
    if (d && d.md !== cur.md0 && confirm(`You have an unsaved draft of this page from ${new Date(d.ts).toLocaleString()}.\n\nRestore it?`)) {
      remount(d.md, true);
      return;
    }
  }
  drawPage();
}

function remount(md, edit) {
  const { id, file, isNew, md0 } = cur;
  teardown();
  mount({ id, file, md, isNew });
  cur.md0 = md0;
  cur.dirty = true;
  if (edit) { cur.mode = 'edit'; cur.editor.setEditable(true); document.body.classList.add('editing'); drawPage(); }
}

function leaveEdit() {
  document.body.classList.remove('editing');
  clearTimeout(draftTimer);
}

function discard() {
  if (cur.dirty && !confirm('Discard your changes to this page?')) return;
  store.del('wiki:draft:' + cur.id);
  leaveEdit();
  if (cur.isNew) { pendingNew.delete(cur.id); location.hash = '#/'; return; }
  const { id, file, md0 } = cur;
  teardown();
  mount({ id, file, md: md0, isNew: false });
}

function createPending(id, title) {
  if (byId.has(id) || pendingNew.has(id)) { location.hash = hrefFor(id); return; }
  const pid = parentOf(id);
  const slug = id.split('/').pop();
  const dir = pid ? dirFor(pid) : '';
  pendingNew.set(id, { file: (dir ? dir + '/' : '') + slug + '.md', title });
  if (location.hash === hrefFor(id)) route(); else location.hash = hrefFor(id);
}

function startNewPage(parentId) {
  const input = h('input', { class: 'text-in', placeholder: 'Page title', autocomplete: 'off' });
  const where = parentId && parentId !== 'index' ? `inside “${nodeTitle(parentId)}”` : 'at the top level';
  const err = h('p', { class: 'err', hidden: true });
  const go = (close) => {
    const title = input.value.trim();
    const slug = slugify(title) || 'page-' + Date.now().toString(36);
    if (slug === 'index' || slug === 'new') { err.textContent = 'Please pick a different title.'; err.hidden = false; return; }
    const id = (parentId && parentId !== 'index' ? parentId + '/' : '') + slug;
    if (byId.has(id)) { err.textContent = 'A page with that name already exists here.'; err.hidden = false; return; }
    close();
    createPending(id, title);
  };
  const m = modal({
    title: 'New page', body: [h('p', { class: 'muted' }, `It will be created ${where}.`), input, err],
    actions: [{ label: 'Cancel' }, { label: 'Create', primary: true, onClick: ({ close }) => go(close) }],
  });
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(m.close); });
}

/* ------------------------------------------------------------------ sign in + save */

async function refreshUser() {
  const token = tokenStore.get();
  me = null;
  if (token) { try { me = await getUser(token); } catch (e) { if (e.status === 401) tokenStore.clear(); } }
  drawAccount();
}
function drawAccount() {
  const b = $('#accountBtn');
  b.textContent = me ? '@' + me.login : tokenStore.get() ? 'Signed in' : 'Sign in';
  b.title = me ? 'Signed in to GitHub' : 'Sign in with a GitHub token to edit';
}

function signInModal(then) {
  const input = h('input', { class: 'text-in', type: 'password', placeholder: 'Paste your GitHub token', autocomplete: 'off', spellcheck: 'false' });
  const err = h('p', { class: 'err', hidden: true });
  const repoUrl = cfg.repo ? `https://github.com/${cfg.repo}` : '';
  const verify = async ({ close, btn }) => {
    const t = input.value.trim();
    if (!t) return;
    err.hidden = true;
    btn.querySelector('.primary').textContent = 'Checking…';
    try {
      const u = await getUser(t);
      tokenStore.set(t);
      me = u;
      repoInfo = null;
      drawAccount();
      close();
      toast(`Signed in as @${u.login}`);
      then && then();
    } catch (e) {
      err.textContent = e.status === 401 ? 'GitHub rejected that token. Check it was copied completely.' : 'Could not reach GitHub: ' + e.message;
      err.hidden = false;
      btn.querySelector('.primary').textContent = 'Sign in';
    }
  };
  const m = modal({
    title: 'Sign in to edit',
    body: [
      h('p', {}, 'Edits are saved to GitHub, so you need a personal access token. It stays in this browser and is only ever sent to GitHub.'),
      h('details', { class: 'how', open: true },
        h('summary', {}, 'How do I get a token?'),
        h('ol', {},
          h('li', {}, h('b', {}, 'I can edit this repository: '), h('a', { href: 'https://github.com/settings/personal-access-tokens/new', target: '_blank', rel: 'noopener' }, 'create a fine-grained token'),
            ' limited to this repo, with ', h('b', {}, 'Contents: read & write'), ' and ', h('b', {}, 'Pull requests: read & write'), '.'),
          h('li', {}, h('b', {}, 'I\'m suggesting changes: '), h('a', { href: 'https://github.com/settings/tokens/new?scopes=public_repo&description=Wiki%20editor', target: '_blank', rel: 'noopener' }, 'create a classic token'),
            ' with the ', h('code', {}, 'public_repo'), ' scope. Your edits are sent as a pull request for the owners to review.'))),
      input, err,
      repoUrl ? h('p', { class: 'muted small' }, 'Wiki repository: ', h('a', { href: repoUrl, target: '_blank', rel: 'noopener' }, cfg.repo)) : null,
    ],
    actions: [{ label: 'Cancel' }, { label: 'Sign in', primary: true, onClick: verify }],
  });
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') verify({ close: m.close, btn: m.box }); });
}

function accountModal() {
  if (!tokenStore.get()) return signInModal();
  modal({
    title: me ? `Signed in as @${me.login}` : 'Signed in',
    body: [h('p', { class: 'muted' }, 'Your token is stored in this browser only.'),
      repoInfo ? h('p', {}, repoInfo.permissions?.push ? '✅ You can edit this wiki directly.' : '🔀 You can suggest changes — they’ll be sent as pull requests.') : null],
    actions: [{ label: 'Close' }, { label: 'Sign out', danger: true, onClick: ({ close }) => { tokenStore.clear(); me = null; repoInfo = null; drawAccount(); close(); toast('Signed out'); } }],
  });
}

async function ensureRepo() {
  if (repoInfo) return repoInfo;
  repoInfo = await getRepo(cfg.repo, tokenStore.get());
  if (!cfg.branch) cfg.branch = repoInfo.default_branch;
  return repoInfo;
}

function startSave() {
  if (!cur || cur.mode !== 'edit') return;
  const md = currentMd();
  if (!cur.meta.title || !cur.meta.title.trim()) { toast('Give the page a title first'); $('.page-title')?.focus(); return; }
  if (md === cur.md0 && !cur.isNew) { toast('No changes to save'); leaveEdit(); store.del('wiki:draft:' + cur.id); const { id, file } = cur; teardown(); mount({ id, file, md: cur ? cur.md0 : md, isNew: false }); return; }
  if (!cfg.repo) {
    return modal({
      title: 'This wiki isn’t connected to GitHub yet',
      body: h('p', {}, 'Set ', h('code', {}, '"repo": "owner/name"'), ' in ', h('code', {}, 'config.json'), ' (it is detected automatically on github.io) so edits know where to go. Your draft is kept in this browser meanwhile.'),
      actions: [{ label: 'OK', primary: true }],
    });
  }
  if (!tokenStore.get()) return signInModal(startSave);
  saveDialog(md);
}

async function saveDialog(md) {
  const loading = modal({ title: 'Checking access…', body: h('p', { class: 'muted' }, 'Talking to GitHub…') });
  let info;
  try { info = await ensureRepo(); } catch (e) {
    loading.close();
    if (e.status === 401) { tokenStore.clear(); me = null; drawAccount(); return signInModal(startSave); }
    return modal({ title: 'Could not reach the repository', body: h('p', { class: 'err' }, e.message + (e.status === 404 ? ' — the token may not have access to ' + cfg.repo + '.' : '')), actions: [{ label: 'Close', primary: true }] });
  }
  loading.close();
  const canPush = !!info.permissions?.push;
  const allowDirect = canPush && cfg.directCommit !== false;
  const summary = h('input', { class: 'text-in', placeholder: cur.isNew ? `Add “${cur.meta.title}”` : `Update “${cur.meta.title}”`, autocomplete: 'off' });
  const err = h('p', { class: 'err', hidden: true });
  let mode = allowDirect ? 'direct' : 'pr';
  const radio = (val, label, hint) => h('label', { class: 'radio' }, h('input', { type: 'radio', name: 'mode', value: val, checked: mode === val, onchange: () => (mode = val) }), h('span', {}, h('b', {}, label), h('small', {}, hint)));
  const body = [
    h('label', { class: 'lbl' }, 'Describe your change (optional)'), summary,
    allowDirect
      ? h('div', { class: 'radios' }, radio('direct', `Publish now to ${cfg.branch}`, 'Goes live after the site rebuilds (about a minute).'), radio('pr', 'Open a pull request instead', 'Lets someone review it before it goes live.'))
      : h('p', { class: 'note' }, canPush ? 'This wiki asks everyone to go through review. ' : 'You don’t have write access, so your edit will be sent as a ', canPush ? '' : h('b', {}, 'pull request'), canPush ? 'Your change will be sent as a pull request.' : ' for the maintainers to review.'),
    err,
  ];
  const run = async ({ close, btn }) => {
    const b = btn.querySelector('.primary');
    const label = summary.value.trim() || summary.placeholder;
    b.disabled = true;
    b.textContent = mode === 'pr' ? 'Sending…' : 'Publishing…';
    err.hidden = true;
    try {
      const ops = [{ path: `${cfg.contentDir}/${cur.file}`, content: md }, ...cur.editor.pendingUploads()];
      const res = await publish({
        repo: cfg.repo, baseBranch: cfg.branch, token: tokenStore.get(), user: me, canPush, mode, ops, message: label,
        prTitle: label, prBody: `Edited from the wiki editor${me ? ` by @${me.login}` : ''}.\n\nPage: \`${cfg.contentDir}/${cur.file}\``,
      });
      close();
      afterSave(md, res);
    } catch (e) {
      b.disabled = false;
      b.textContent = 'Try again';
      err.textContent = 'Saving failed: ' + e.message;
      err.hidden = false;
    }
  };
  const m = modal({ title: 'Save changes', body, actions: [{ label: 'Cancel' }, { label: 'Save', primary: true, onClick: run }] });
  summary.addEventListener('keydown', (e) => { if (e.key === 'Enter') run({ close: m.close, btn: m.box }); });
}

function afterSave(md, res) {
  const { id, file, isNew } = cur;
  store.del('wiki:draft:' + id);
  leaveEdit();
  if (res.kind === 'commit') {
    mdCache.set(id, md);
    setOverlay(id, { file, md });
    upsertIndex(id, file, md);
    pendingNew.delete(id);
    rebuild();
    teardown();
    mount({ id, file, md, isNew: false });
    toast('Saved ✓ — the live site updates in about a minute.', 5000);
  } else {
    const original = isNew ? null : cur.md0;
    teardown();
    if (isNew) { pendingNew.delete(id); location.hash = '#/'; }
    else mount({ id, file, md: original, isNew: false });
    modal({
      title: 'Pull request opened 🎉',
      body: [h('p', {}, 'Your changes were sent for review. They will appear on the wiki once a maintainer merges them.'),
        h('p', {}, h('a', { href: res.url, target: '_blank', rel: 'noopener' }, 'View pull request #' + res.number + ' on GitHub ↗'))],
      actions: [{ label: 'Done', primary: true }],
    });
  }
}

function deletePage() {
  const kids = tree.nodes.get(cur.id)?.children.length;
  modal({
    title: `Delete “${cur.meta.title || cur.id}”?`,
    body: [h('p', {}, 'This removes the page file from the repository. It can be recovered from Git history.'),
      kids ? h('p', { class: 'note' }, `Its ${kids} sub-page${kids === 1 ? '' : 's'} will not be deleted.`) : null, h('p', { class: 'err', id: 'delErr', hidden: true })],
    actions: [{ label: 'Cancel' }, { label: 'Delete', danger: true, onClick: async ({ close, btn }) => {
      if (!cfg.repo) return;
      if (!tokenStore.get()) { close(); return signInModal(deletePage); }
      const b = btn.querySelector('.danger');
      b.textContent = 'Deleting…';
      try {
        const info = await ensureRepo();
        const canPush = !!info.permissions?.push;
        const mode = canPush && cfg.directCommit !== false ? 'direct' : 'pr';
        const msg = `Delete “${cur.meta.title || cur.id}”`;
        const res = await publish({ repo: cfg.repo, baseBranch: cfg.branch, token: tokenStore.get(), user: me, canPush, mode, ops: [{ path: `${cfg.contentDir}/${cur.file}`, delete: true }], message: msg, prTitle: msg, prBody: 'Deleted from the wiki editor.' });
        close();
        if (res.kind === 'commit') {
          const id = cur.id;
          setOverlay(id, { file: cur.file, md: '', deleted: true });
          index = index.filter((p) => p.id !== id);
          mdCache.delete(id);
          rebuild();
          toast('Page deleted');
          location.hash = '#/';
          route();
        } else modal({ title: 'Deletion proposed', body: h('p', {}, h('a', { href: res.url, target: '_blank', rel: 'noopener' }, 'View pull request ↗')), actions: [{ label: 'Done', primary: true }] });
      } catch (e) { b.textContent = 'Delete'; const el = $('#delErr'); el.textContent = e.message; el.hidden = false; }
    } }],
  });
}

/* ------------------------------------------------------------------ chrome */

function applyTheme(t) {
  if (t) document.documentElement.dataset.theme = t; else delete document.documentElement.dataset.theme;
  try { t ? localStorage.setItem('wiki:theme', t) : localStorage.removeItem('wiki:theme'); } catch {}
}

function wireChrome() {
  $('#brandIcon').textContent = cfg.icon;
  $('#brandTitle').textContent = cfg.title;
  $('#kbd').textContent = /Mac|iP(hone|ad)/.test(navigator.platform) ? '⌘ K' : 'Ctrl K';
  $('#searchBtn').onclick = () => openSearch();
  $('#newRoot').onclick = () => startNewPage(null);
  $('#accountBtn').onclick = accountModal;
  $('#menuBtn').onclick = () => $('#app').classList.toggle('side-open');
  $('#scrim').onclick = () => $('#app').classList.remove('side-open');
  $('#themeBtn').onclick = () => {
    const dark = document.documentElement.dataset.theme ? document.documentElement.dataset.theme === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches;
    applyTheme(dark ? 'light' : 'dark');
  };
  document.addEventListener('keydown', (e) => {
    const mod = e.ctrlKey || e.metaKey;
    if (mod && e.key.toLowerCase() === 'k') { e.preventDefault(); if ($('#overlay').hidden) openSearch(); }
    else if (mod && e.key.toLowerCase() === 's' && cur?.mode === 'edit') { e.preventDefault(); startSave(); }
    else if (e.key === 'e' && !mod && cur?.mode === 'view' && !/INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName) && $('#overlay').hidden) setMode('edit');
  });
  window.addEventListener('beforeunload', (e) => { if (cur?.mode === 'edit' && cur.dirty) { e.preventDefault(); e.returnValue = ''; } });
  window.addEventListener('hashchange', () => {
    if (cur?.mode === 'edit' && cur.dirty && routeId() !== cur.id) {
      if (!confirm('You have unsaved changes on this page. Leave without saving?\n\n(A draft is kept in this browser.)')) {
        history.replaceState(null, '', lastHash || location.pathname + location.search);
        return;
      }
      leaveEdit();
    } else if (cur?.mode === 'edit') leaveEdit();
    route();
  });
  document.addEventListener('click', (e) => {
    const a = e.target.closest('#page a.wikilink');
    if (a && a.getAttribute('href') === '#') e.preventDefault();
  });
}

async function main() {
  cfg = await loadConfig();
  wireChrome();
  await loadIndex();
  refreshUser();
  await route();
}

main();
