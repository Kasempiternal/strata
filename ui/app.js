'use strict';
/* Strata UI. Talks to the backend only through the contract in docs/API.md. */
const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;
const appWindow = window.__TAURI__.window.getCurrentWindow();

/* ============================== utils ============================== */
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ESC[c]);
const plural = (n, one, many) => `${fmtInt(n)} ${n === 1 ? one : many}`;
const fmtInt = (n) => Math.round(n).toLocaleString('en-US');
const UNITS = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
function fmtSize(b) {
  if (!(b > 0)) return '0 B';
  let i = 0;
  while (b >= 1024 && i < UNITS.length - 1) { b /= 1024; i++; }
  if (i === 0) return `${Math.round(b)} B`;
  let s = b.toFixed(1);
  if (parseFloat(s) >= 1024 && i < UNITS.length - 1) { b /= 1024; i++; s = b.toFixed(1); }
  return `${s} ${UNITS[i]}`;
}
const fmtCount = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : fmtInt(n));
function fmtDur(ms) {
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)} s`;
  return `${Math.floor(ms / 60000)} m ${Math.round((ms % 60000) / 1000)} s`;
}
function fmtPct(f) {
  const p = f * 100;
  if (p >= 10) return `${p.toFixed(0)}%`;
  if (p >= 0.1) return `${p.toFixed(1)}%`;
  return p > 0 ? '<0.1%' : '0%';
}
const joinPath = (dir, name) => dir + (dir.endsWith('\\') ? '' : '\\') + name;
const dirOf = (p) => { const i = p.lastIndexOf('\\'); return i <= 2 ? p.slice(0, i + 1) : p.slice(0, i); };
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const errMsg = (e) => (typeof e === 'string' ? e : e && e.message ? e.message : JSON.stringify(e));

async function copyText(text) {
  try { await navigator.clipboard.writeText(text); return true; } catch { /* fall through */ }
  const ta = document.createElement('textarea');
  ta.value = text; ta.style.cssText = 'position:fixed;opacity:0';
  document.body.appendChild(ta); ta.select();
  let ok = false;
  try { ok = document.execCommand('copy'); } catch { /* ignore */ }
  ta.remove();
  return ok;
}

/* ---- icons ---- */
const IC = {
  back: '<path d="M13 8H3m4-4L3 8l4 4"/>',
  up: '<path d="M8 13V3m-4 4 4-4 4 4"/>',
  copy: '<rect x="5.5" y="5.5" width="8" height="8" rx="1.6"/><path d="M3 10.5V4.5A1.5 1.5 0 0 1 4.5 3h6"/>',
  chev: '<path d="m6 3.5 4.5 4.5L6 12.5"/>',
  sort: '<path d="m4 6 4 4 4-4"/>',
  trash: '<path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.6 8.5h5.8l.6-8.5M7 7v3.5M9 7v3.5"/>',
  x: '<path d="m4 4 8 8m0-8-8 8"/>',
  reveal: '<path d="M2 5.5A1.5 1.5 0 0 1 3.5 4h2.6l1.3 1.5h5.1A1.5 1.5 0 0 1 14 7v4.5a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 2 11.5v-6Z"/>',
  open: '<path d="M9 3h4v4M13 3 7.5 8.5M11 9.5V12a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1h2.5"/>',
  drive: '<rect x="2" y="9" width="12" height="4.5" rx="1.6"/><path d="M3.5 9 5 3.5h6L12.5 9"/><path d="M11.4 11.25h.01"/>',
  usb: '<rect x="3" y="6" width="10" height="4" rx="1.4"/><path d="M13 7.2h1.5M13 8.8h1.5M5.5 8h.01"/>',
  shield: '<path d="M8 2 3 4v4c0 3 2 5 5 6 3-1 5-3 5-6V4L8 2Z"/><path d="m6 8 1.5 1.5L10.5 6.5"/>',
  user: '<circle cx="8" cy="5.5" r="2.6"/><path d="M3 13.5c.6-2.4 2.6-3.6 5-3.6s4.4 1.2 5 3.6"/>',
  folderPlus: '<path d="M2 5.5A1.5 1.5 0 0 1 3.5 4h2.6l1.3 1.5h5.1A1.5 1.5 0 0 1 14 7v4.5a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 2 11.5v-6Z"/><path d="M8 7.5v3M6.5 9h3"/>',
  warn: '<path d="M8 2.5 1.8 13h12.4L8 2.5ZM8 6.6v3M8 11.3h.01"/>',
  ok: '<circle cx="8" cy="8" r="6"/><path d="m5.5 8 1.8 1.8 3.2-3.4"/>',
  info: '<circle cx="8" cy="8" r="6"/><path d="M8 7.4V11M8 5.1h.01"/>',
  err: '<circle cx="8" cy="8" r="6"/><path d="m6 6 4 4m0-4-4 4"/>',
  refresh: '<path d="M13 8a5 5 0 1 1-1.6-3.7M13 2.5v3h-3"/>',
};
const ico = (n, s = 16, sw = 1.4) =>
  `<svg width="${s}" height="${s}" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="${sw}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${IC[n]}</svg>`;
const folderSvg = (s = 18) =>
  `<svg width="${s}" height="${s}" viewBox="0 0 24 24" aria-hidden="true"><path d="M2 6.6A2.6 2.6 0 0 1 4.6 4h4.1c.5 0 1 .2 1.35.55L11.6 6h7.8A2.6 2.6 0 0 1 22 8.6V9H2V6.6Z" fill="#c98a1f"/><path d="M2 9.4A2.4 2.4 0 0 1 4.4 7h15.2A2.4 2.4 0 0 1 22 9.4v8.2a2.4 2.4 0 0 1-2.4 2.4H4.4A2.4 2.4 0 0 1 2 17.6V9.4Z" fill="#f6c25a"/></svg>`;
const fileSvg = (c, s = 18) =>
  `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M6 2.8h7.6L19.2 8.4V19a2.2 2.2 0 0 1-2.2 2.2H6A2.2 2.2 0 0 1 3.8 19V5A2.2 2.2 0 0 1 6 2.8Z" fill="${c}" fill-opacity=".16" stroke="${c}" stroke-width="1.5"/><path d="M13.4 3v5.6H19" stroke="${c}" stroke-width="1.5" stroke-linejoin="round"/></svg>`;

/* ---- file categories ---- */
const CATS = {
  Image: ['#34d399', 'jpg jpeg png gif webp bmp heic svg ico tif tiff raw arw dng psd avif'],
  Video: ['#f472b6', 'mp4 mkv mov avi wmv webm m4v flv'],
  Audio: ['#fbbf24', 'mp3 flac wav m4a aac ogg wma opus'],
  Archive: ['#fb923c', 'zip rar 7z tar gz tgz bz2 xz cab msu whl vsix nupkg crate psf'],
  Document: ['#60a5fa', 'pdf doc docx xls xlsx ppt pptx txt md rtf csv odt epub'],
  Code: ['#a78bfa', 'js ts jsx tsx json html css rs py go c cpp h cs java lua toml yml yaml xml map pyc rlib rmeta d o inf manifest mum scss ps1 bat'],
  Program: ['#f87171', 'exe dll sys msi msp mui node pyd jar efi cat lnk'],
  'Disk image': ['#22d3ee', 'iso vhd vhdx vmdk img wim pt safetensors npy parquet'],
  Data: ['#2dd4bf', 'db sqlite dat log etl dmp tmp cache pak vpk bdt archive pkg bsp bin file ini vscdb pf ttf otf ttc blend'],
};
const OTHER = ['#8b93a7', 'Other'];
const EXT_CAT = new Map();
for (const [name, [color, list]] of Object.entries(CATS)) for (const e of list.split(' ')) EXT_CAT.set(e, [color, name]);
const extOf = (name) => { const i = name.lastIndexOf('.'); return i > 0 ? name.slice(i + 1).toLowerCase() : ''; };
const catOf = (ext) => EXT_CAT.get(String(ext).replace(/^\./, '').toLowerCase()) || OTHER;
const MUTED = 'hsl(222 10% 40%)';

/* ============================== state ============================== */
const S = {
  admin: false, version: '',
  drives: [], bin: { items: 0, size: 0 },
  view: 'home', tab: 'explore',
  metric: localStorage.getItem('strata.metric') === 'size' ? 'size' : 'alloc',
  root: null,
  cur: null, rows: [], rowIndex: new Map(), nodeById: new Map(), colors: new Map(),
  hist: [], sort: { key: 'metric', dir: 'desc' },
  sel: { explore: new Set(), largest: new Set() },
  lastSel: { explore: -1, largest: -1 },
  focusId: { explore: null, largest: null },
  hoverId: null,
  largest: null, largestById: new Map(), types: null,
  stale: { largest: true, types: true },
  scanning: false, modal: false,
};
const metricOf = (n) => n[S.metric];
const metricName = () => (S.metric === 'alloc' ? 'Size on disk' : 'Logical size');
const backendSort = () => ({ metric: 'metric', name: 'name', files: 'files' }[S.sort.key]);

/* ============================== toast / modal / menu ============================== */
function toast(kind, text, small = '', ms = 4200) {
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.setAttribute('role', kind === 'err' ? 'alert' : 'status');
  el.innerHTML = `<span class="ti">${ico({ ok: 'ok', err: 'err', warn: 'warn', info: 'info' }[kind], 18)}</span><div class="tt">${esc(text)}${small ? `<small>${esc(small)}</small>` : ''}</div>`;
  $('#toasts').appendChild(el);
  const kill = () => { el.classList.add('out'); setTimeout(() => el.remove(), 260); };
  const t = setTimeout(kill, ms);
  el.addEventListener('click', () => { clearTimeout(t); kill(); });
}

function openModal({ icon, title, intro = '', warn = '', note = '', list = '', danger = false, buttons, focus = 0 }) {
  return new Promise((resolve) => {
    const prev = document.activeElement;
    hideTip();
    const root = $('#modal-root');
    const ov = document.createElement('div');
    ov.className = 'overlay';
    ov.innerHTML = `<div class="modal ${danger ? 'danger' : ''}" role="alertdialog" aria-modal="true" aria-labelledby="m-title">
      <div class="m-head"><div class="m-ico">${ico(icon, 20, 1.5)}</div><div><h3 id="m-title">${esc(title)}</h3>${intro ? `<p>${intro}</p>` : ''}</div></div>
      ${warn ? `<div class="m-warn">${warn}</div>` : ''}${note ? `<div class="m-note">${note}</div>` : ''}${list}
      <div class="m-foot">${buttons.map((b, i) => `<button class="btn ${b.cls || 'btn-outline'}" data-i="${i}">${esc(b.label)}</button>`).join('')}</div></div>`;
    root.appendChild(ov);
    S.modal = true;
    const btns = $$('.m-foot .btn', ov);
    const close = (v) => {
      document.removeEventListener('keydown', onKey, true);
      ov.remove(); S.modal = false;
      if (prev && prev.focus) prev.focus({ preventScroll: true });
      resolve(v);
    };
    function onKey(e) {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(null); }
      else if (e.key === 'Tab') {
        e.preventDefault();
        const i = btns.indexOf(document.activeElement);
        btns[(i + (e.shiftKey ? -1 : 1) + btns.length) % btns.length].focus();
      } else if (e.key === 'Enter' && !(document.activeElement && document.activeElement.tagName === 'BUTTON')) {
        e.preventDefault(); btns[focus].click();
      }
    }
    document.addEventListener('keydown', onKey, true);
    btns.forEach((b) => b.addEventListener('click', () => close(buttons[+b.dataset.i].value)));
    ov.addEventListener('mousedown', (e) => { if (e.target === ov) close(null); });
    btns[focus].focus();
  });
}

const pathRow = (p, size) => `<div class="m-item"><span class="p"><bdo dir="ltr">${esc(p)}</bdo></span>${size != null ? `<span class="s">${fmtSize(size)}</span>` : ''}</div>`;

async function confirmDelete(items, total, permanent) {
  const n = items.length;
  const shown = items.slice(0, 60);
  const list = `<div class="m-list">${shown.map((i) => pathRow(i.path, i.size)).join('')}${n > shown.length ? `<div class="m-more">and ${fmtInt(n - shown.length)} more</div>` : ''}</div>`;
  const what = plural(n, 'item', 'items');
  return openModal(permanent
    ? {
      icon: 'warn', danger: true, title: `Permanently delete ${what}?`,
      intro: `<b>${fmtSize(total)}</b> will be erased immediately and will skip the Recycle Bin.`,
      warn: 'This cannot be undone.', list, focus: 0,
      buttons: [{ label: 'Cancel', value: false }, { label: 'Delete permanently', value: true, cls: 'btn-danger' }],
    }
    : {
      icon: 'trash', title: `Move ${what} to the Recycle Bin?`,
      intro: `<b>${fmtSize(total)}</b> will be moved to the Recycle Bin.`,
      note: 'Recycling does not free disk space. The space comes back only after you empty the Recycle Bin.', list, focus: 1,
      buttons: [{ label: 'Cancel', value: false }, { label: 'Move to Recycle Bin', value: true, cls: 'btn-accent' }],
    });
}

const menuEl = $('#menu');
function closeMenu() { menuEl.hidden = true; menuEl.innerHTML = ''; }
function showMenu(x, y, entries) {
  menuEl.innerHTML = entries.map((e, i) => (e === '-' ? '<div class="msep"></div>'
    : `<button class="mi ${e.danger ? 'danger' : ''}" role="menuitem" data-i="${i}" ${e.disabled ? 'disabled' : ''}>${ico(e.icon, 15)}<span>${esc(e.label)}</span></button>`)).join('');
  menuEl.hidden = false;
  const r = menuEl.getBoundingClientRect();
  menuEl.style.left = `${clamp(x, 6, innerWidth - r.width - 6)}px`;
  menuEl.style.top = `${clamp(y, 6, innerHeight - r.height - 6)}px`;
  $$('.mi', menuEl).forEach((b) => b.addEventListener('click', () => { const e = entries[+b.dataset.i]; closeMenu(); e.run(); }));
}
document.addEventListener('mousedown', (e) => { if (!menuEl.hidden && !menuEl.contains(e.target)) closeMenu(); }, true);
window.addEventListener('blur', closeMenu);
document.addEventListener('contextmenu', (e) => e.preventDefault());

/* ============================== virtual list ============================== */
class VList {
  constructor(scroller, sizer, { rowH, render, pad = 0 }) {
    Object.assign(this, { scroller, sizer, rowH, render, pad, items: [], f: -1, l: -1, raf: 0 });
    scroller.addEventListener('scroll', () => { if (!this.raf) this.raf = requestAnimationFrame(() => { this.raf = 0; this.draw(); }); }, { passive: true });
    new ResizeObserver(() => this.draw(true)).observe(scroller);
  }
  set(items, keepScroll = false) {
    this.items = items;
    this.sizer.style.height = `${items.length * this.rowH + this.pad}px`;
    if (!keepScroll) this.scroller.scrollTop = 0;
    this.draw(true);
  }
  draw(force) {
    const h = this.scroller.clientHeight;
    if (!h) return;
    const top = this.scroller.scrollTop;
    const f = Math.max(0, Math.floor(top / this.rowH) - 6);
    const l = Math.min(this.items.length - 1, Math.ceil((top + h) / this.rowH) + 6);
    if (!force && f === this.f && l === this.l) return;
    this.f = f; this.l = l;
    let html = '';
    for (let i = f; i <= l; i++) html += this.render(this.items[i], i, i * this.rowH);
    this.sizer.innerHTML = html;
  }
  reveal(i) {
    const t = i * this.rowH;
    const { scrollTop: s, clientHeight: h } = this.scroller;
    if (t < s) this.scroller.scrollTop = t;
    else if (t + this.rowH > s + h) this.scroller.scrollTop = t + this.rowH - h;
  }
}

/* ============================== sunburst ============================== */
const TAU = Math.PI * 2;
const DEPTH = 4;
const HUES = [262, 188, 28, 330, 215, 150, 48, 296, 8, 172, 240, 100];
const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
const lerp = (a, b, t) => a + (b - a) * t;

class Sunburst {
  constructor(canvas, cb) {
    this.cv = canvas; this.ctx = canvas.getContext('2d'); this.cb = cb;
    this.layout = null; this.anim = null; this.out = []; this.prevRoot = null;
    this.hoverNode = null; this.hoverCenter = false; this.chain = new Set(); this.hv = 0; this.hvTarget = 0;
    this.w = 0; this.h = 0; this.dpr = 1; this.raf = 0; this.canUp = false; this.last = 0;
    new ResizeObserver(() => this.resize()).observe(canvas);
    canvas.addEventListener('pointermove', (e) => this.onMove(e));
    canvas.addEventListener('pointerleave', () => this.setHover(null, false, null));
    canvas.addEventListener('click', (e) => this.onClick(e));
  }
  resize() {
    const r = this.cv.getBoundingClientRect();
    if (!r.width || !r.height) return;
    this.dpr = window.devicePixelRatio || 1;
    this.w = r.width; this.h = r.height;
    this.cv.width = Math.round(r.width * this.dpr);
    this.cv.height = Math.round(r.height * this.dpr);
    this.kick();
  }
  geom() {
    const R = Math.max(40, Math.min(this.w, this.h) / 2 - 10);
    const rc = R * 0.3;
    return { cx: this.w / 2, cy: this.h / 2, R, rc, wr: (R - rc) / DEPTH };
  }
  static color(hue, depth, isDir = true, hl = false) {
    const s = 72 - (depth - 1) * 6 - (isDir ? 0 : 6);
    const l = 55 + (depth - 1) * 3.5 + (isDir ? 0 : 3) + (hl ? 11 : 0);
    return `hsl(${hue} ${s}% ${l}%)`;
  }
  fillOf(n, hl) {
    return n.agg ? `hsl(222 9% ${hl ? 48 : 34 + n.depth * 2}%)` : Sunburst.color(n.hue, n.depth, n.isDir, hl);
  }
  build(b) {
    const nodes = []; const byKey = new Map(); const rings = Array.from({ length: DEPTH + 1 }, () => []);
    const mk = (n, parent, depth) => ({
      key: n.id >= 0 ? String(n.id) : `agg:${parent.key}`, id: n.id, name: n.name, v: n.v, isDir: n.isDir,
      depth, parent, a0: 0, a1: 0, d0: depth - 1, d1: depth, hue: 0, agg: n.id === -1, kids: [],
    });
    const root = mk(b, null, 0);
    root.a1 = TAU;
    byKey.set(root.key, root);
    let rank = 0;
    const place = (node, src) => {
      if (!src.children) return;
      const sum = src.children.reduce((s, c) => s + c.v, 0);
      const base = Math.max(src.v, sum) || 1;
      const span = node.a1 - node.a0;
      let a = node.a0;
      for (const c of src.children) {
        const ch = mk(c, node, node.depth + 1);
        ch.a0 = a; a += (span * c.v) / base; ch.a1 = a;
        ch.hue = node.depth === 0 ? (c.id === -1 ? 0 : HUES[rank++ % HUES.length]) : node.hue;
        node.kids.push(ch); nodes.push(ch); byKey.set(ch.key, ch); rings[ch.depth].push(ch);
        place(ch, c);
      }
    };
    place(root, b);
    return { root, nodes, byKey, rings };
  }
  clear() { this.layout = null; this.anim = null; this.out = []; this.setHover(null, false, undefined, true); this.kick(); }
  setData(b, canUp, animate) {
    const prev = this.layout;
    const next = this.build(b);
    this.canUp = canUp;
    if (animate && prev && this.w) {
      for (const n of next.nodes) {
        const o = prev.byKey.get(n.key);
        n.from = o && o.depth > 0 ? { a0: o.a0, a1: o.a1, d0: o.d0, d1: o.d1, al: 1 } : { a0: n.a0, a1: n.a1, d0: n.d0, d1: n.d0, al: 0 };
      }
      this.out = prev.nodes.filter((o) => !next.byKey.has(o.key));
      this.prevRoot = prev.root;
      this.anim = { t0: performance.now(), dur: 260 };
    } else { this.anim = null; this.out = []; this.prevRoot = null; }
    this.layout = next;
    this.setHover(null, false, undefined, true);
    this.kick();
  }
  nodeByKey(id) { return this.layout && this.layout.byKey.get(String(id)); }
  hoverById(id) {
    const n = id == null ? null : this.nodeByKey(id);
    this.setHover(n && n.depth > 0 ? n : null, false);
  }
  /* ev: pointer event = notify with position, null = notify without, undefined = silent (driven from the list) */
  setHover(n, center, ev, instant) {
    if (n === this.hoverNode && center === this.hoverCenter) { if (ev) this.cb.hover(n, ev); return; }
    this.hoverNode = n; this.hoverCenter = center;
    if (n) { this.chain = new Set(); for (let p = n; p && p.depth > 0; p = p.parent) this.chain.add(p.key); this.hvTarget = 1; }
    else { this.hvTarget = 0; if (instant) { this.chain = new Set(); this.hv = 0; } }
    this.cv.style.cursor = (n && n.isDir && !n.agg) || (center && this.canUp) ? 'pointer' : 'default';
    if (ev !== undefined) this.cb.hover(n, ev);
    this.kick();
  }
  hit(e) {
    if (!this.layout) return null;
    const r = this.cv.getBoundingClientRect();
    const g = this.geom();
    const dx = e.clientX - r.left - g.cx; const dy = e.clientY - r.top - g.cy;
    const d = Math.hypot(dx, dy);
    if (d <= g.rc) return { center: true };
    if (d > g.R) return null;
    const ring = Math.floor((d - g.rc) / g.wr) + 1;
    let a = Math.atan2(dy, dx) + Math.PI / 2;
    if (a < 0) a += TAU;
    for (const n of this.layout.rings[Math.min(ring, DEPTH)]) if (a >= n.a0 && a < n.a1) return { node: n };
    return null;
  }
  onMove(e) {
    const h = this.hit(e);
    if (h && h.node) this.setHover(h.node, false, e);
    else { this.setHover(null, !!(h && h.center), null); this.cb.hover(null); }
  }
  onClick(e) {
    const h = this.hit(e);
    if (!h) return;
    if (h.center) { if (this.canUp) this.cb.up(); return; }
    if (h.node.agg) return;
    if (h.node.isDir) this.cb.drill(h.node.id); else this.cb.file(h.node);
  }
  kick() { if (!this.raf) this.raf = requestAnimationFrame((t) => this.frame(t)); }
  frame(t) {
    this.raf = 0;
    const dt = this.last ? Math.min(50, t - this.last) : 16;
    this.last = t;
    if (this.hv !== this.hvTarget) {
      const step = dt / 140;
      this.hv = this.hvTarget > this.hv ? Math.min(1, this.hv + step) : Math.max(0, this.hv - step);
      if (this.hv === 0 && !this.hoverNode) this.chain = new Set();
    }
    this.draw();
    const animating = this.anim && performance.now() - this.anim.t0 < this.anim.dur;
    if (this.anim && !animating) { this.anim = null; this.out = []; this.prevRoot = null; this.draw(); }
    if (animating || this.hv !== this.hvTarget) this.kick(); else this.last = 0;
  }
  rad(d, g) { return d <= 0 ? g.rc * (1 + d) : g.rc + d * g.wr; }
  arc(ctx, g, a0, a1, d0, d1) {
    const r0 = this.rad(d0, g); const r1 = this.rad(d1, g);
    if (r1 - r0 < 0.4 || (a1 - a0) * r1 < 0.5) return false;
    ctx.beginPath();
    ctx.arc(g.cx, g.cy, r1, a0 - Math.PI / 2, a1 - Math.PI / 2);
    ctx.arc(g.cx, g.cy, Math.max(0, r0), a1 - Math.PI / 2, a0 - Math.PI / 2, true);
    ctx.closePath();
    return true;
  }
  draw() {
    const { ctx } = this;
    if (!this.w || !this.layout) { if (this.w) { ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0); ctx.clearRect(0, 0, this.w, this.h); } return; }
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, this.w, this.h);
    const g = this.geom();
    const k = this.anim ? ease(Math.min(1, (performance.now() - this.anim.t0) / this.anim.dur)) : 1;
    const dimmed = this.chain.size ? lerp(1, 0.4, this.hv) : 1;
    ctx.lineWidth = 1; ctx.strokeStyle = 'rgba(14,17,24,0.9)'; ctx.lineJoin = 'round';

    for (const o of this.out) {
      if (o.depth === 0) continue;
      ctx.globalAlpha = (1 - k) * 0.9;
      if (this.arc(ctx, g, o.a0, o.a1, o.d0, o.d1)) { ctx.fillStyle = this.fillOf(o, false); ctx.fill(); ctx.stroke(); }
    }
    for (const n of this.layout.nodes) {
      let a0 = n.a0, a1 = n.a1, d0 = n.d0, d1 = n.d1, al = 1;
      if (this.anim && n.from) {
        const f = n.from;
        a0 = lerp(f.a0, n.a0, k); a1 = lerp(f.a1, n.a1, k); d0 = lerp(f.d0, n.d0, k); d1 = lerp(f.d1, n.d1, k); al = lerp(f.al, 1, k);
      }
      if (al < 0.01) continue;
      ctx.globalAlpha = al * (this.chain.has(n.key) ? 1 : dimmed);
      if (this.arc(ctx, g, a0, a1, d0, d1)) { ctx.fillStyle = this.fillOf(n, false); ctx.fill(); ctx.stroke(); }
    }
    if (this.chain.size && this.hv > 0 && !this.anim) {
      ctx.globalAlpha = 1;
      for (const key of this.chain) {
        const n = this.layout.byKey.get(key);
        if (!n || !this.arc(ctx, g, n.a0, n.a1, n.d0, n.d1)) continue;
        ctx.fillStyle = this.fillOf(n, true); ctx.fill();
        ctx.strokeStyle = `rgba(255,255,255,${0.85 * this.hv})`; ctx.lineWidth = 1.6; ctx.stroke();
      }
    }
    ctx.globalAlpha = 1;
    this.drawCenter(g, k);
  }
  drawCenter(g, k) {
    const { ctx } = this;
    const grad = ctx.createRadialGradient(g.cx, g.cy - g.rc * 0.3, g.rc * 0.1, g.cx, g.cy, g.rc);
    grad.addColorStop(0, '#222838'); grad.addColorStop(1, '#171b26');
    ctx.beginPath(); ctx.arc(g.cx, g.cy, g.rc - 1, 0, TAU);
    ctx.fillStyle = grad; ctx.fill();
    ctx.lineWidth = 1.5; ctx.strokeStyle = this.hoverCenter && this.canUp ? 'rgba(157,139,255,0.9)' : 'rgba(255,255,255,0.1)'; ctx.stroke();
    const draw = (root, alpha) => {
      if (!root) return;
      ctx.globalAlpha = alpha; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      const maxW = g.rc * 1.7;
      const nf = clamp(g.rc * 0.19, 11, 17); const sf = clamp(g.rc * 0.3, 14, 27);
      ctx.font = `600 ${nf}px "Segoe UI Variable Display","Segoe UI",sans-serif`;
      let name = root.name;
      while (name.length > 3 && ctx.measureText(name).width > maxW) name = name.slice(0, -2);
      if (name !== root.name) name = `${name.trimEnd()}…`;
      const showUp = this.hoverCenter && this.canUp;
      ctx.fillStyle = '#e8eaf0';
      ctx.fillText(showUp ? 'Go up' : name, g.cx, g.cy - sf * 0.55);
      ctx.font = `600 ${sf}px "Segoe UI Variable Display","Segoe UI",sans-serif`;
      const gr = ctx.createLinearGradient(g.cx - g.rc * 0.6, 0, g.cx + g.rc * 0.6, 0);
      gr.addColorStop(0, '#a78bfa'); gr.addColorStop(1, '#60a5fa');
      ctx.fillStyle = showUp ? '#b9a8ff' : gr;
      ctx.fillText(showUp ? '↑' : fmtSize(root.v), g.cx, g.cy + sf * 0.62);
      ctx.globalAlpha = 1;
    };
    if (this.prevRoot && k < 1) { draw(this.prevRoot, 1 - k); draw(this.layout.root, k); } else draw(this.layout.root, 1);
  }
}

/* ============================== views ============================== */
function showView(v) {
  S.view = v;
  for (const id of ['home', 'scan', 'explore']) $(`#view-${id}`).hidden = id !== v;
  $('#tb-sub').textContent = v === 'explore' && S.root ? `· ${S.root.path}` : '';
  updateSelBar();
  if (v === 'explore') { placeInks(); sb.resize(); }
  renderDrives();
}

function placeInks() {
  const t = $('.tab.on');
  const ink = $('#tab-ink');
  if (t && t.offsetWidth) { ink.style.left = `${t.offsetLeft + 12}px`; ink.style.width = `${t.offsetWidth - 24}px`; }
  const m = $('#metric-seg button.on');
  const th = $('.seg-thumb');
  if (m && m.offsetWidth) { th.style.left = `${m.offsetLeft}px`; th.style.width = `${m.offsetWidth}px`; }
}

/* ---- sidebar / home ---- */
const driveIcon = (d, s = 18) => ico(d.removable ? 'usb' : 'drive', s, 1.5);
const driveTitle = (d) => `${d.label || 'Local Disk'} (${d.path.replace(/\\$/, '')})`;

function renderDrives() {
  const root = $('#drives');
  root.innerHTML = S.drives.map((d, i) => {
    const used = d.total - d.free; const f = d.total ? used / d.total : 0;
    const on = S.view === 'explore' && S.root && S.root.path.toLowerCase() === d.path.toLowerCase();
    return `<button class="drive ${on ? 'on' : ''}" data-i="${i}" ${S.scanning ? 'disabled' : ''} title="Scan ${esc(d.path)}">
      <div class="drive-top"><span class="drive-ico">${driveIcon(d)}</span><div><div class="drive-name">${esc(driveTitle(d))}</div><div class="drive-sub">${esc(d.fs)}${d.removable ? ' · Removable' : ''}</div></div><span class="drive-go">Scan</span></div>
      <div class="meter ${f > 0.9 ? 'hot' : ''}"><i style="width:${(f * 100).toFixed(1)}%"></i></div>
      <div class="drive-free"><b>${fmtSize(d.free)}</b> free of ${fmtSize(d.total)}</div></button>`;
  }).join('');
  $('#bin-card').innerHTML = `<span class="bin-ico">${ico('trash', 18, 1.5)}</span><div class="bin-info"><div class="bin-size">${fmtSize(S.bin.size)}</div><div class="bin-sub">${plural(S.bin.items, 'item', 'items')}</div></div>
    <button class="btn btn-outline small" id="btn-empty" ${S.bin.items === 0 ? 'disabled' : ''}>Empty</button>`;
}

function renderHome() {
  const rings = [];
  const seed = (i) => { const x = Math.sin(i * 91.7) * 10000; return x - Math.floor(x); };
  let n = 0;
  const arcP = (r0, r1, a0, a1) => {
    const p = (r, a) => `${(380 + r * Math.cos(a - Math.PI / 2)).toFixed(1)} ${(380 + r * Math.sin(a - Math.PI / 2)).toFixed(1)}`;
    const big = a1 - a0 > Math.PI ? 1 : 0;
    return `M${p(r1, a0)}A${r1} ${r1} 0 ${big} 1 ${p(r1, a1)}L${p(r0, a1)}A${r0} ${r0} 0 ${big} 0 ${p(r0, a0)}Z`;
  };
  for (let ring = 0; ring < 5; ring++) {
    const r0 = 112 + ring * 52; const r1 = r0 + 46;
    let a = seed(ring) * TAU; const end = a + TAU; let paths = '';
    while (a < end - 0.05) {
      const span = Math.min(end - a, 0.25 + seed(++n) * (1.6 - ring * 0.18));
      const hue = HUES[Math.floor(seed(n + 50) * HUES.length)];
      paths += `<path d="${arcP(r0, r1 - 1.5, a + 0.012, a + span - 0.012)}" fill="${Sunburst.color(hue, ring + 1)}" fill-opacity="${(0.22 - ring * 0.02).toFixed(2)}"/>`;
      a += span;
    }
    rings.push(`<g style="transform-origin:380px 380px;animation:spin ${90 + ring * 40}s linear infinite ${ring % 2 ? 'reverse' : ''}">${paths}</g>`);
  }
  $('#view-home').innerHTML = `<svg class="ghost" viewBox="0 0 760 760" style="-webkit-mask-image:radial-gradient(circle,#000 35%,transparent 68%);mask-image:radial-gradient(circle,#000 35%,transparent 68%)" aria-hidden="true">${rings.join('')}</svg>
    <div class="home-body"><img class="home-logo" src="logo.png" alt="" draggable="false">
    <h1>Where did your <span>disk space</span> go?</h1>
    <p>Pick a drive and Strata maps every folder in layers, so the biggest space hogs are easy to spot, open and clean up.</p>
    <div class="home-drives" id="home-drives"></div>
    <button class="btn btn-outline" id="home-folder">${ico('folderPlus', 16, 1.5)}Scan a folder…</button>
    <div class="home-hint">${S.admin ? 'Administrator mode: drives are read straight from the MFT in seconds.' : 'Tip: restart as administrator for near-instant whole-drive scans.'}</div></div>`;
  renderHomeDrives();
}
function renderHomeDrives() {
  const el = $('#home-drives');
  if (!el) return;
  el.innerHTML = S.drives.map((d, i) => `<button class="hd" data-i="${i}"><span class="drive-ico">${driveIcon(d)}</span><div class="t">${esc(driveTitle(d))}</div>
    <div class="meter ${(d.total - d.free) / d.total > 0.9 ? 'hot' : ''}"><i style="width:${(((d.total - d.free) / d.total) * 100).toFixed(1)}%"></i></div><div class="s">${fmtSize(d.free)} free of ${fmtSize(d.total)}</div></button>`).join('');
}

function renderAdmin() {
  $('#admin-banner').hidden = S.admin;
  const b = $('#admin-badge');
  b.className = `badge ${S.admin ? 'admin' : ''}`;
  b.innerHTML = `${ico(S.admin ? 'shield' : 'user', 14, 1.5)}${S.admin ? 'Administrator' : 'Standard user'}`;
  $('#ver').textContent = S.version ? `v${S.version}` : '';
}

async function refreshSide() {
  try {
    const [drives, bin] = await Promise.all([invoke('list_drives'), invoke('recycle_bin')]);
    S.drives = drives; S.bin = bin;
    renderDrives(); renderHomeDrives();
  } catch (e) { console.error(e); }
}

/* ---- scanning ---- */
const PHASES = { mft: 'Reading the Master File Table', walk: 'Walking folders', build: 'Building the tree' };
async function startScan(path) {
  if (S.scanning || !path) return;
  closeMenu();
  S.scanning = true; S.root = null; S.cur = null; sb.clear();
  S.sel.explore.clear(); S.sel.largest.clear();
  S.hist = []; S.stale = { largest: true, types: true };
  $('#scan-path').textContent = path; $('#scan-phase').textContent = 'Starting scan…';
  $('#st-files').textContent = '0'; $('#st-bytes').textContent = '0 B'; $('#st-time').textContent = '0.0 s';
  $('#scan-bar').classList.add('indet'); $('#scan-bar i').style.width = '';
  showView('scan');
  try { await invoke('start_scan', { path }); } catch (e) { scanFailed(errMsg(e)); }
}
function scanFailed(msg) {
  S.scanning = false; showView('home');
  toast('err', 'Scan failed', msg, 7000);
}
function onProgress(p) {
  if (!S.scanning) return;
  const pct = p.total > 0 ? clamp(p.done / p.total, 0, 1) : null;
  $('#scan-phase').textContent = (PHASES[p.phase] || 'Scanning') + (pct != null ? ` · ${Math.floor(pct * 100)}%` : '…');
  const bar = $('#scan-bar');
  bar.classList.toggle('indet', pct == null);
  if (pct != null) $('i', bar).style.width = `${pct * 100}%`;
  $('#st-files').textContent = fmtInt(p.files); $('#st-bytes').textContent = fmtSize(p.bytes); $('#st-time').textContent = fmtDur(p.elapsedMs);
}
async function onScanDone(d) {
  S.scanning = false;
  S.root = { id: d.rootId, path: d.path, mode: d.mode };
  S.sort = { key: 'metric', dir: 'desc' };
  toast('ok', `Scanned ${fmtCount(d.files)} files in ${fmtDur(d.elapsedMs)} (${d.mode === 'mft' ? 'MFT' : 'walk'})`, `${fmtSize(d.alloc)} on disk`);
  setTab('explore', true);
  showView('explore');
  await navigate(d.rootId, { push: false, animate: false });
  refreshSide();
}

/* ---- explore: data ---- */
let navSeq = 0;
async function navigate(id, { push = true, animate = true, focus = null } = {}) {
  const seq = ++navSeq;
  let cur; let burst;
  try {
    [cur, burst] = await Promise.all([
      invoke('list_children', { id, metric: S.metric, sort: backendSort(), limit: 2000 }),
      invoke('sunburst', { id, metric: S.metric, depth: DEPTH, minFraction: 0.004 }),
    ]);
  } catch (e) {
    if (seq !== navSeq) return;
    if (S.root && id !== S.root.id) { toast('warn', 'That folder is no longer available', errMsg(e)); return navigate(S.root.id, { push: false, animate }); }
    toast('err', 'Could not read this folder', errMsg(e), 6000);
    return;
  }
  if (seq !== navSeq) return;
  const same = S.cur && S.cur.node.id === id;
  if (push && S.cur && !same) S.hist.push(S.cur.node.id);
  S.cur = cur;
  if (!same) { S.sel.explore.clear(); S.lastSel.explore = -1; S.focusId.explore = focus; closeMenu(); hideTip(); }
  S.stale = { largest: true, types: true };
  applyCur(burst, { animate, keepScroll: same });
  if (S.tab !== 'explore') loadTab(S.tab);
}

function applyCur(burst, { animate = true, keepScroll = false } = {}) {
  const c = S.cur;
  S.nodeById = new Map(c.children.map((n) => [n.id, n]));
  for (const id of [...S.sel.explore]) if (!S.nodeById.has(id)) S.sel.explore.delete(id);
  sb.setData(burst, c.crumbs.length > 1, animate);
  S.colors = new Map();
  for (const k of sb.layout.root.kids) if (!k.agg) S.colors.set(k.id, Sunburst.color(k.hue, 1));
  buildRows(keepScroll);
  renderCrumbs(); renderHead();
  if (S.focusId.explore != null && S.rowIndex.has(S.focusId.explore)) listVL.reveal(S.rowIndex.get(S.focusId.explore));
  updateSelBar();
}

function buildRows(keepScroll) {
  const c = S.cur; const { key, dir } = S.sort; const m = S.metric;
  const kids = c.children.slice();
  const cmp = key === 'name' ? (a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' })
    : key === 'files' ? (a, b) => (a.files + a.dirs) - (b.files + b.dirs) || a[m] - b[m]
      : (a, b) => a[m] - b[m];
  kids.sort(cmp);
  if (dir === 'desc') kids.reverse();
  S.rows = kids.map((n) => ({ t: 'n', n }));
  if (!S.rows.length) S.rows.push({ t: 'empty' });
  if (c.more > 0) S.rows.push({ t: 'more' });
  S.rowIndex = new Map(); S.rows.forEach((r, i) => { if (r.t === 'n') S.rowIndex.set(r.n.id, i); });
  listVL.set(S.rows, keepScroll);
  renderListHead();
}

async function reloadList() {
  const seq = ++navSeq;
  try {
    const cur = await invoke('list_children', { id: S.cur.node.id, metric: S.metric, sort: backendSort(), limit: 2000 });
    if (seq !== navSeq) return;
    S.cur = cur;
    S.nodeById = new Map(cur.children.map((n) => [n.id, n]));
    buildRows(false);
  } catch (e) { toast('err', 'Could not sort', errMsg(e)); }
}

function goUp() {
  const cr = S.cur && S.cur.crumbs;
  if (cr && cr.length > 1) navigate(cr[cr.length - 2].id, { focus: S.cur.node.id });
}
async function goBack() {
  while (S.hist.length) {
    const id = S.hist.pop();
    const from = S.cur.node.id;
    await navigate(id, { push: false, focus: from });
    return;
  }
}

/* ---- explore: rendering ---- */
function renderCrumbs() {
  const cr = S.cur.crumbs;
  $('#crumbs').innerHTML = cr.map((c, i) => {
    const last = i === cr.length - 1;
    return `${i ? `<span class="crumb-sep">${ico('chev', 12, 1.6)}</span>` : ''}<button class="crumb ${last ? 'last' : ''}" data-id="${c.id}" title="${esc(c.name)}" ${last ? 'aria-current="page" tabindex="-1"' : ''}>${esc(c.name.replace(/\\$/, '') || c.name)}</button>`;
  }).join('');
  $('#btn-up').disabled = cr.length < 2;
  $('#btn-back').disabled = S.hist.length === 0;
  const last = $('#crumbs .crumb.last');
  if (last) last.scrollIntoView({ inline: 'end' });
}

function renderHead() {
  const { node } = S.cur;
  const other = S.metric === 'alloc' ? ['Logical size', node.size] : ['Size on disk', node.alloc];
  $('#head').innerHTML = `<div class="head-l"><div class="head-name">${folderSvg(26)}<span title="${esc(S.cur.path)}">${esc(node.name)}</span></div>
    <div class="head-meta">${plural(node.files, 'file', 'files')} · ${plural(node.dirs, 'folder', 'folders')}</div></div>
    <div class="head-size"><b>${fmtSize(metricOf(node))}</b><span>${metricName()} · ${other[0]} ${fmtSize(other[1])}</span></div>`;
}

function renderListHead() {
  const { key, dir } = S.sort;
  const b = (k, label, cls = '', quiet = false) => `<button class="${cls} ${key === k && !quiet ? 'on' : ''} ${key === k && dir === 'asc' ? 'asc' : ''}" data-sort="${k}">${label}${ico('sort', 12, 1.8)}</button>`;
  const all = S.sel.explore.size;
  const n = S.rows.filter((r) => r.t === 'n').length;
  $('#lhead').className = 'lhead ex-cols';
  $('#lhead').innerHTML = `<input type="checkbox" class="chk" id="chk-all" tabindex="-1" aria-label="Select all" ${all && all === n ? 'checked' : ''}>${b('name', 'Name')}<span class="c-bar"></span>${b('metric', 'Size', 'r')}${b('metric', '%', 'r c-pct', true)}${b('files', 'Items', 'r c-items')}`;
  const chk = $('#chk-all'); chk.indeterminate = all > 0 && all < n;
}

function rowHtmlExplore(r, i, top) {
  if (r.t === 'empty') return `<div class="lrow dim" style="top:${top}px;display:flex;justify-content:center"><span>This folder is empty</span></div>`;
  if (r.t === 'more') {
    const c = S.cur;
    return `<div class="lrow ex-cols dim" data-i="${i}" style="top:${top}px"><span></span><div class="c-name" style="grid-column:2 / -1"><span class="n">+${fmtInt(c.more)} more items (${fmtSize(c.moreValue)})</span></div></div>`;
  }
  const n = r.n; const v = metricOf(n); const total = metricOf(S.cur.node) || 1;
  const color = S.colors.get(n.id) || MUTED;
  const sel = S.sel.explore.has(n.id);
  const cls = `lrow ex-cols${sel ? ' sel' : ''}${S.focusId.explore === n.id ? ' foc' : ''}${S.hoverId === n.id ? ' hl' : ''}`;
  const icon = n.isDir ? folderSvg() : fileSvg(catOf(extOf(n.name))[0]);
  return `<div class="${cls}" data-i="${i}" data-id="${n.id}" style="top:${top}px;--c:${color}"><input type="checkbox" class="chk" tabindex="-1" aria-label="Select ${esc(n.name)}" ${sel ? 'checked' : ''}>
    <div class="c-name" title="${esc(n.name)}">${icon}<span class="n" ${n.isDir ? 'style="font-weight:500"' : ''}>${esc(n.name)}</span></div>
    <div class="c-bar"><div class="bar"><i style="width:${Math.min(100, (v / total) * 100).toFixed(2)}%"></i></div></div>
    <div class="r c-size">${fmtSize(v)}</div><div class="r c-pct">${fmtPct(v / total)}</div><div class="r c-items">${n.isDir ? fmtInt(n.files + n.dirs) : '—'}</div></div>`;
}

const listVL = new VList($('#list-scroll'), $('#list-sizer'), { rowH: 38, pad: 76, render: rowHtmlExplore });

/* ---- selection ---- */
const selKey = () => (S.tab === 'largest' ? 'largest' : 'explore');
function selectedItems(kind = selKey()) {
  const out = [];
  for (const id of S.sel[kind]) {
    const it = kind === 'largest' ? S.largestById.get(id) : S.nodeById.get(id);
    if (!it) continue;
    out.push({ id, name: it.name, size: metricOf(it), path: kind === 'largest' ? it.path : joinPath(S.cur.path, it.name) });
  }
  return out;
}
function updateSelBar() {
  const bar = $('#selbar');
  const show = S.view === 'explore' && S.tab !== 'types' && S.sel[selKey()].size > 0;
  bar.classList.toggle('show', show);
  document.body.classList.toggle('has-selbar', show);
  bar.setAttribute('aria-hidden', String(!show));
  bar.querySelectorAll('button').forEach((b) => { b.tabIndex = show ? 0 : -1; });
  if (!show) return;
  const items = selectedItems();
  $('#sb-n').textContent = plural(items.length, 'item', 'items');
  $('#sb-size').textContent = fmtSize(items.reduce((s, i) => s + i.size, 0)) + (S.metric === 'alloc' ? ' on disk' : '');
}
function redrawSel() {
  if (S.tab === 'largest') lgVL.draw(true); else { listVL.draw(true); renderListHead(); }
  updateSelBar();
}
function toggleSel(kind, id, idx, shift) {
  const set = S.sel[kind];
  const rows = kind === 'largest' ? S.largest : S.rows;
  const on = !set.has(id);
  if (shift && S.lastSel[kind] >= 0) {
    const [a, b] = [S.lastSel[kind], idx].sort((x, y) => x - y);
    for (let i = a; i <= b; i++) { const r = rows[i]; const rid = kind === 'largest' ? r.id : r.t === 'n' ? r.n.id : null; if (rid != null) (on ? set.add(rid) : set.delete(rid)); }
  } else on ? set.add(id) : set.delete(id);
  S.lastSel[kind] = idx;
  redrawSel();
}
function clearSel() { S.sel[selKey()].clear(); redrawSel(); }

/* ---- actions ---- */
async function doReveal(id) { try { await invoke('reveal', { id }); } catch (e) { toast('err', 'Could not reveal item', errMsg(e)); } }
async function doOpen(id) { try { await invoke('open_item', { id }); } catch (e) { toast('err', 'Could not open item', errMsg(e)); } }
async function doCopyPath(id) {
  try { const p = await invoke('node_path', { id }); const ok = await copyText(p); toast(ok ? 'ok' : 'err', ok ? 'Path copied' : 'Could not copy', p, 2600); }
  catch (e) { toast('err', 'Could not copy path', errMsg(e)); }
}

async function deleteFlow(items, permanent) {
  if (!items.length || S.modal) return;
  const total = items.reduce((s, i) => s + i.size, 0);
  if (!(await confirmDelete(items, total, permanent))) return;
  let res;
  try { res = await invoke('delete_items', { ids: items.map((i) => i.id), permanent }); }
  catch (e) { toast('err', 'Delete failed', errMsg(e), 7000); return; }
  const nd = res.deleted.length;
  for (const k of ['explore', 'largest']) for (const id of res.deleted) S.sel[k].delete(id);
  if (nd) {
    toast('ok', permanent ? `Permanently deleted ${plural(nd, 'item', 'items')}` : `Moved ${plural(nd, 'item', 'items')} to the Recycle Bin`,
      permanent ? `Freed ${fmtSize(res.freed)}` : 'Disk space is freed once you empty the Recycle Bin.', permanent ? 4500 : 6500);
  }
  const refresh = (async () => {
    await navigate(S.cur.node.id, { push: false });
    refreshSide();
  })();
  if (res.failed.length) {
    const rows = res.failed.map((f) => `<div class="m-item fail"><span class="p"><bdo dir="ltr">${esc(f.path)}</bdo></span><span class="e">${esc(f.error)}</span></div>`).join('');
    await openModal({
      icon: 'warn', danger: true, title: nd ? `${plural(res.failed.length, 'item', 'items')} could not be deleted` : 'Nothing was deleted',
      intro: nd ? `${plural(nd, 'item was', 'items were')} removed. These were skipped:` : 'These items were skipped:', list: `<div class="m-list">${rows}</div>`,
      buttons: [{ label: 'OK', value: true, cls: 'btn-outline' }],
    });
  }
  await refresh;
}

async function emptyBin() {
  if (S.modal || S.bin.items === 0) return;
  const ok = await openModal({
    icon: 'warn', danger: true, title: 'Empty the Recycle Bin?',
    intro: `<b>${plural(S.bin.items, 'item', 'items')}</b> (${fmtSize(S.bin.size)}) from all drives will be erased permanently.`, warn: 'This cannot be undone.',
    buttons: [{ label: 'Cancel', value: false }, { label: 'Empty Recycle Bin', value: true, cls: 'btn-danger' }],
  });
  if (!ok) return;
  const was = S.bin.size;
  try { await invoke('empty_recycle_bin'); toast('ok', 'Recycle Bin emptied', `Freed ${fmtSize(was)}`); }
  catch (e) { toast('err', 'Could not empty the Recycle Bin', errMsg(e), 7000); }
  refreshSide();
}

function rowMenu(e, kind, id) {
  e.preventDefault();
  const sel = S.sel[kind];
  const multi = sel.has(id) && sel.size > 1;
  const items = multi ? selectedItems(kind) : selectedItemsFor(kind, id);
  const isDir = kind === 'explore' && S.nodeById.get(id) && S.nodeById.get(id).isDir;
  const sfx = multi ? ` (${items.length})` : '';
  showMenu(e.clientX, e.clientY, [
    { label: 'Open', icon: 'open', run: () => (isDir ? navigate(id, { focus: null }) : doOpen(id)) },
    { label: 'Reveal in Explorer', icon: 'reveal', run: () => doReveal(id) },
    { label: 'Copy path', icon: 'copy', run: () => doCopyPath(id) },
    '-',
    { label: `Move to Recycle Bin${sfx}`, icon: 'trash', run: () => deleteFlow(items, false) },
    { label: `Delete permanently${sfx}`, icon: 'x', danger: true, run: () => deleteFlow(items, true) },
  ]);
}
function selectedItemsFor(kind, id) {
  const it = kind === 'largest' ? S.largestById.get(id) : S.nodeById.get(id);
  return it ? [{ id, name: it.name, size: metricOf(it), path: kind === 'largest' ? it.path : joinPath(S.cur.path, it.name) }] : [];
}

/* ---- list interaction (explore) ---- */
function setHoverRow(id) {
  if (S.hoverId === id) return;
  S.hoverId = id;
  for (const el of $$('#list-sizer .hl')) el.classList.remove('hl');
  if (id != null) { const el = $(`#list-sizer [data-id="${id}"]`); if (el) el.classList.add('hl'); }
}
function setFocusRow(kind, id, reveal = true) {
  const prev = S.focusId[kind];
  S.focusId[kind] = id;
  const sizer = kind === 'largest' ? $('#lg-sizer') : $('#list-sizer');
  if (prev != null) { const p = sizer.querySelector(`[data-id="${prev}"]`); if (p) p.classList.remove('foc'); }
  const el = sizer.querySelector(`[data-id="${id}"]`);
  if (el) el.classList.add('foc');
  if (reveal) {
    const idx = kind === 'largest' ? S.largest.findIndex((x) => x.id === id) : S.rowIndex.get(id);
    if (idx >= 0) (kind === 'largest' ? lgVL : listVL).reveal(idx);
  }
}

$('#list-sizer').addEventListener('click', (e) => {
  const row = e.target.closest('.lrow');
  if (!row || row.dataset.id == null) return;
  const id = +row.dataset.id; const i = +row.dataset.i;
  if (e.target.classList.contains('chk')) { toggleSel('explore', id, i, e.shiftKey); return; }
  if (e.ctrlKey || e.metaKey) { toggleSel('explore', id, i, false); return; }
  setFocusRow('explore', id, false);
});
$('#list-sizer').addEventListener('dblclick', (e) => {
  const row = e.target.closest('.lrow');
  if (row && row.dataset.id != null && !e.target.classList.contains('chk')) openRow(+row.dataset.id);
});
$('#list-sizer').addEventListener('contextmenu', (e) => {
  const row = e.target.closest('.lrow');
  if (row && row.dataset.id != null) { setFocusRow('explore', +row.dataset.id, false); rowMenu(e, 'explore', +row.dataset.id); }
});
$('#list-sizer').addEventListener('mouseover', (e) => {
  const row = e.target.closest('.lrow');
  const id = row && row.dataset.id != null ? +row.dataset.id : null;
  if (id !== S.hoverId) { setHoverRow(id); sb.hoverById(id); }
});
$('#list-sizer').addEventListener('mouseleave', () => { setHoverRow(null); sb.hoverById(null); });
function openRow(id) {
  const n = S.nodeById.get(id);
  if (!n) return;
  if (n.isDir) navigate(id, { focus: null }); else doOpen(id);
}
$('#lhead').addEventListener('click', (e) => {
  if (e.target.id === 'chk-all') {
    const ids = S.rows.filter((r) => r.t === 'n').map((r) => r.n.id);
    const all = ids.length && ids.every((id) => S.sel.explore.has(id));
    ids.forEach((id) => (all ? S.sel.explore.delete(id) : S.sel.explore.add(id)));
    redrawSel(); return;
  }
  const b = e.target.closest('button[data-sort]');
  if (!b) return;
  const k = b.dataset.sort;
  S.sort = S.sort.key === k ? { key: k, dir: S.sort.dir === 'desc' ? 'asc' : 'desc' } : { key: k, dir: k === 'name' ? 'asc' : 'desc' };
  reloadList();
});

/* ---- sunburst callbacks ---- */
const tip = $('#tip');
function hideTip() { tip.hidden = true; }
const sb = new Sunburst($('#burst'), {
  hover(n, ev) {
    if (!n) { hideTip(); setHoverRow(null); return; }
    let top = n; while (top.depth > 1) top = top.parent;
    setHoverRow(top.agg ? null : top.id);
    const root = sb.layout.root;
    const color = n.agg ? 'hsl(222 9% 44%)' : Sunburst.color(n.hue, n.depth, n.isDir);
    tip.innerHTML = `<div class="tn"><i style="--c:${color}"></i>${esc(n.name)}</div><div class="ts"><b>${fmtSize(n.v)}</b> · ${fmtPct(n.v / (root.v || 1))} of ${esc(S.cur.node.name)}${n.isDir && !n.agg ? ' · click to open' : ''}</div>`;
    tip.hidden = false;
    if (ev) {
      const r = tip.getBoundingClientRect();
      tip.style.left = `${clamp(ev.clientX + 16, 6, innerWidth - r.width - 6)}px`;
      tip.style.top = `${clamp(ev.clientY + 18, 6, innerHeight - r.height - 6)}px`;
    }
  },
  drill: (id) => navigate(id, { focus: null }),
  up: () => goUp(),
  file(n) {
    let top = n; while (top.depth > 1) top = top.parent;
    if (!top.agg && S.rowIndex.has(top.id)) setFocusRow('explore', top.id);
  },
});

/* ============================== tabs ============================== */
function setTab(t, silent) {
  S.tab = t;
  $$('.tab').forEach((b) => { const on = b.dataset.tab === t; b.classList.toggle('on', on); b.setAttribute('aria-selected', on); });
  for (const p of ['explore', 'largest', 'types']) $(`#pane-${p}`).hidden = p !== t;
  placeInks();
  closeMenu(); hideTip();
  if (!silent) { updateSelBar(); loadTab(t); if (t === 'explore') sb.resize(); }
}

async function loadTab(t) {
  if (!S.cur || !S.stale[t]) return;
  const id = S.cur.node.id;
  const scope = `<span>in <b>${esc(S.cur.path)}</b></span>`;
  try {
    if (t === 'largest') {
      const list = await invoke('largest_files', { id, metric: S.metric, limit: 500 });
      if (S.cur.node.id !== id) return;
      S.largest = list; S.largestById = new Map(list.map((x) => [x.id, x]));
      for (const sid of [...S.sel.largest]) if (!S.largestById.has(sid)) S.sel.largest.delete(sid);
      $('#scope-largest').innerHTML = `Top ${fmtInt(list.length)} largest files ${scope}`;
      lgVL.set(list, false);
    } else if (t === 'types') {
      const list = await invoke('file_types', { id, metric: S.metric, limit: 80 });
      if (S.cur.node.id !== id) return;
      S.types = list;
      $('#scope-types').innerHTML = `${plural(list.length, 'file type', 'file types')} ${scope}`;
      renderTypes();
    }
    S.stale[t] = false;
    updateSelBar();
  } catch (e) { toast('err', 'Could not load data', errMsg(e), 6000); }
}

/* ---- largest files ---- */
function rowHtmlLargest(f, i, top) {
  const max = metricOf(S.largest[0]) || 1;
  const [color] = catOf(extOf(f.name));
  const sel = S.sel.largest.has(f.id);
  const cls = `lrow lg-row${sel ? ' sel' : ''}${S.focusId.largest === f.id ? ' foc' : ''}`;
  return `<div class="${cls}" data-i="${i}" data-id="${f.id}" style="top:${top}px;--c:${color}"><div class="fill" style="width:${((metricOf(f) / max) * 100).toFixed(1)}%"></div>
    <input type="checkbox" class="chk" tabindex="-1" aria-label="Select ${esc(f.name)}" ${sel ? 'checked' : ''}>
    <div class="info"><div class="name-line">${fileSvg(color, 16)}<span class="nm" title="${esc(f.name)}">${esc(f.name)}</span></div><div class="p" title="${esc(f.path)}"><bdo dir="ltr">${esc(dirOf(f.path))}</bdo></div></div>
    <div class="r c-size">${fmtSize(metricOf(f))}</div>
    <div class="acts"><button class="icon-btn" data-act="reveal" title="Reveal in Explorer" aria-label="Reveal in Explorer">${ico('reveal', 16)}</button>
    <button class="icon-btn danger" data-act="trash" title="Move to Recycle Bin (Shift: delete permanently)" aria-label="Move to Recycle Bin">${ico('trash', 16)}</button></div></div>`;
}
const lgVL = new VList($('#lg-scroll'), $('#lg-sizer'), { rowH: 46, pad: 76, render: rowHtmlLargest });
$('#lg-sizer').addEventListener('click', (e) => {
  const row = e.target.closest('.lrow');
  if (!row) return;
  const id = +row.dataset.id; const i = +row.dataset.i;
  const act = e.target.closest('[data-act]');
  if (act) {
    if (act.dataset.act === 'reveal') doReveal(id);
    else deleteFlow(selectedItemsFor('largest', id), e.shiftKey);
    return;
  }
  if (e.target.classList.contains('chk')) { toggleSel('largest', id, i, e.shiftKey); return; }
  if (e.ctrlKey || e.metaKey) { toggleSel('largest', id, i, false); return; }
  setFocusRow('largest', id, false);
});
$('#lg-sizer').addEventListener('dblclick', (e) => {
  const row = e.target.closest('.lrow');
  if (row && !e.target.closest('.chk,[data-act]')) doReveal(+row.dataset.id);
});
$('#lg-sizer').addEventListener('contextmenu', (e) => {
  const row = e.target.closest('.lrow');
  if (row) { setFocusRow('largest', +row.dataset.id, false); rowMenu(e, 'largest', +row.dataset.id); }
});

/* ---- file types ---- */
function renderTypes() {
  const list = S.types || [];
  const total = metricOf(S.cur.node) || 1;
  const max = list.length ? list[0][S.metric] || 1 : 1;
  $('#types').innerHTML = `<div class="trow th"><span>Type</span><span></span><span class="r">Files</span><span class="r">Size</span><span class="r">%</span></div>` + list.map((t) => {
    const [color, cat] = catOf(t.ext);
    const ext = String(t.ext).replace(/^\./, '');
    const v = t[S.metric];
    return `<div class="trow" style="--c:${color}"><div class="t-ext"><span class="t-dot"></span>${ext ? `.${esc(ext)}` : '(no extension)'}<small>${cat}</small></div>
      <div class="t-bar"><i style="width:${Math.max(1, (v / max) * 100).toFixed(2)}%"></i></div>
      <div class="r t-count">${fmtInt(t.count)}</div><div class="r t-size">${fmtSize(v)}</div><div class="r t-pct">${fmtPct(v / total)}</div></div>`;
  }).join('');
}

/* ============================== wiring ============================== */
$('#tabs').addEventListener('click', (e) => { const b = e.target.closest('.tab'); if (b && b.dataset.tab !== S.tab) setTab(b.dataset.tab); });
$('#metric-seg').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-metric]');
  if (!b || b.dataset.metric === S.metric) return;
  S.metric = b.dataset.metric;
  localStorage.setItem('strata.metric', S.metric);
  $$('#metric-seg button').forEach((x) => x.classList.toggle('on', x === b));
  placeInks();
  if (S.cur) navigate(S.cur.node.id, { push: false });
});
$$('#metric-seg button').forEach((b) => b.classList.toggle('on', b.dataset.metric === S.metric));

$('#crumbs').addEventListener('click', (e) => { const b = e.target.closest('.crumb'); if (b && !b.classList.contains('last')) navigate(+b.dataset.id, { focus: S.cur.node.id }); });
$('#btn-back').innerHTML = ico('back', 16, 1.5); $('#btn-up').innerHTML = ico('up', 16, 1.5); $('#btn-copy-path').innerHTML = ico('copy', 16, 1.5);
$('#btn-back').addEventListener('click', goBack);
$('#btn-up').addEventListener('click', goUp);
$('#btn-copy-path').addEventListener('click', async () => { if (S.cur && (await copyText(S.cur.path))) toast('ok', 'Path copied', S.cur.path, 2600); });

async function pickAndScan() {
  if (S.scanning) return;
  try { const p = await invoke('pick_folder'); if (p) startScan(p); } catch (e) { toast('err', 'Could not open folder picker', errMsg(e)); }
}
$('#btn-scan-folder').innerHTML = `${ico('folderPlus', 16, 1.5)}Scan folder…`;
$('#btn-scan-folder').addEventListener('click', pickAndScan);
$('#btn-admin').textContent = 'Restart as admin';
$('#btn-admin').addEventListener('click', async () => { try { await invoke('relaunch_admin'); } catch (e) { toast('err', 'Could not restart as administrator', errMsg(e), 6000); } });
$('#btn-cancel').addEventListener('click', () => invoke('cancel_scan').catch(() => {}));
$('#drives').addEventListener('click', (e) => { const b = e.target.closest('.drive'); if (b && !b.disabled) startScan(S.drives[+b.dataset.i].path); });
$('#view-home').addEventListener('click', (e) => {
  const b = e.target.closest('.hd'); if (b) startScan(S.drives[+b.dataset.i].path);
  if (e.target.closest('#home-folder')) pickAndScan();
});
$('#bin-card').addEventListener('click', (e) => { if (e.target.closest('#btn-empty')) emptyBin(); });
$('#sb-clear').addEventListener('click', clearSel);
$('#sb-recycle').innerHTML = `${ico('trash', 15)}Move to Recycle Bin`;
$('#sb-delete').innerHTML = `${ico('x', 15, 1.6)}Delete permanently`;
$('#sb-recycle').addEventListener('click', () => deleteFlow(selectedItems(), false));
$('#sb-delete').addEventListener('click', () => deleteFlow(selectedItems(), true));

/* ---- keyboard ---- */
document.addEventListener('keydown', (e) => {
  if (S.modal) return;
  const tag = e.target.tagName;
  if (tag === 'INPUT' && e.target.type !== 'checkbox') return;
  if (e.key === 'Escape') {
    if (!menuEl.hidden) { closeMenu(); return; }
    if (S.view === 'explore' && S.sel[selKey()].size) clearSel();
    return;
  }
  if (!menuEl.hidden) {
    const items = $$('.mi:not(:disabled)', menuEl);
    const i = items.indexOf(document.activeElement);
    if (e.key === 'ArrowDown') { e.preventDefault(); items[(i + 1) % items.length].focus(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); items[(i - 1 + items.length) % items.length].focus(); }
    return;
  }
  if (S.view !== 'explore' || S.tab === 'types') return;
  const kind = selKey();
  const onBtn = tag === 'BUTTON' || (tag === 'INPUT');
  if (e.key === 'Delete') {
    e.preventDefault();
    let items = selectedItems(kind);
    if (!items.length && S.focusId[kind] != null) items = selectedItemsFor(kind, S.focusId[kind]);
    deleteFlow(items, e.shiftKey);
    return;
  }
  if (kind === 'explore') {
    if (e.key === 'Backspace') { e.preventDefault(); goUp(); return; }
    if (e.altKey && e.key === 'ArrowLeft') { e.preventDefault(); goBack(); return; }
  }
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a') {
    e.preventDefault();
    const ids = kind === 'largest' ? S.largest.map((x) => x.id) : S.rows.filter((r) => r.t === 'n').map((r) => r.n.id);
    ids.forEach((id) => S.sel[kind].add(id)); redrawSel(); return;
  }
  const ids = kind === 'largest' ? (S.largest || []).map((x) => x.id) : S.rows.filter((r) => r.t === 'n').map((r) => r.n.id);
  if (!ids.length) return;
  const cur = ids.indexOf(S.focusId[kind]);
  const move = { ArrowDown: 1, ArrowUp: -1, PageDown: 10, PageUp: -10 }[e.key];
  if (move != null) { e.preventDefault(); setFocusRow(kind, ids[clamp(cur < 0 ? (move > 0 ? 0 : ids.length - 1) : cur + move, 0, ids.length - 1)]); return; }
  if (e.key === 'Home') { e.preventDefault(); setFocusRow(kind, ids[0]); return; }
  if (e.key === 'End') { e.preventDefault(); setFocusRow(kind, ids[ids.length - 1]); return; }
  if (onBtn) return;
  if (e.key === ' ' && cur >= 0) { e.preventDefault(); const id = ids[cur]; toggleSel(kind, id, kind === 'largest' ? cur : S.rowIndex.get(id), false); return; }
  if (e.key === 'Enter' && cur >= 0) {
    e.preventDefault();
    if (kind === 'largest') doReveal(ids[cur]); else openRow(ids[cur]);
  }
});

/* ---- window controls ---- */
const WIN = {
  min: '<svg width="10" height="10" viewBox="0 0 10 10"><path d="M0 5.5h10" stroke="currentColor"/></svg>',
  max: '<svg width="10" height="10" viewBox="0 0 10 10"><rect x=".5" y=".5" width="9" height="9" rx="1.2" fill="none" stroke="currentColor"/></svg>',
  restore: '<svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor"><rect x=".5" y="2.5" width="7" height="7" rx="1.1"/><path d="M2.5 2.5v-1a1 1 0 0 1 1-1h5a1 1 0 0 1 1 1v5a1 1 0 0 1-1 1h-1"/></svg>',
  close: '<svg width="10" height="10" viewBox="0 0 10 10"><path d="m0 0 10 10M10 0 0 10" stroke="currentColor"/></svg>',
};
async function syncMax() {
  try { const m = await appWindow.isMaximized(); $('#win-max').innerHTML = m ? WIN.restore : WIN.max; $('#win-max').setAttribute('aria-label', m ? 'Restore' : 'Maximize'); } catch { /* ignore */ }
}
$('#win-min').innerHTML = WIN.min; $('#win-max').innerHTML = WIN.max; $('#win-close').innerHTML = WIN.close;
$('#win-min').addEventListener('click', () => appWindow.minimize());
$('#win-max').addEventListener('click', async () => { await appWindow.toggleMaximize(); syncMax(); });
$('#win-close').addEventListener('click', () => appWindow.close());
try { Promise.resolve(appWindow.onResized(syncMax)).catch(() => {}); } catch { /* optional */ }
window.addEventListener('resize', placeInks);
window.addEventListener('focus', () => { if (!S.scanning) refreshSide(); });

/* ============================== boot ============================== */
(async function boot() {
  renderDrives(); renderHome(); renderAdmin();
  await listen('scan-progress', (e) => onProgress(e.payload));
  await listen('scan-done', (e) => onScanDone(e.payload));
  await listen('scan-error', (e) => scanFailed(e.payload.message));
  await listen('scan-cancelled', () => { S.scanning = false; showView('home'); toast('info', 'Scan cancelled'); });
  try {
    const [st, drives, bin] = await Promise.all([invoke('app_status'), invoke('list_drives'), invoke('recycle_bin')]);
    S.admin = st.admin; S.version = st.version; S.drives = drives; S.bin = bin;
  } catch (e) { toast('err', 'Could not talk to the Strata backend', errMsg(e), 8000); }
  renderAdmin(); renderDrives(); renderHome();
  syncMax();
  const auto = new URLSearchParams(location.search).get('scan');
  if (auto && window.__MOCK__) startScan(auto);
})();
