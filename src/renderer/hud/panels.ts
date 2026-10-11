import { $, esc, h, hud, nh, nw, nx, ny, toGH, toGW, toGX, toGY } from '../bridge';
import { Chart, type ChartData } from './chart';
import { lockHit } from './hit';
import { icon, iconEl } from './icons';
import { markdown } from './markdown';
import { accentColor } from './theme';
import { mountMonitor } from './monitor';

export type PanelKind = 'text' | 'markdown' | 'code' | 'list' | 'table' | 'image' | 'chart' | 'stats' | 'visual' | 'monitor';

export interface StatItem {
  label: string;
  value: string;
  percent?: number;
  trend?: 'up' | 'down' | 'flat';
}

export interface PanelSpec {
  id: string;
  title: string;
  kind: PanelKind;
  accent?: string;
  content?: string;
  items?: string[];
  columns?: string[];
  rows?: string[][];
  image_url?: string;
  chart?: ChartData;
  stats?: StatItem[];
  html?: string;
  /** Normalized 0-1000 box; omitted → auto-placed. */
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  ttl_seconds?: number;
}

interface Panel {
  spec: PanelSpec;
  el: HTMLDivElement;
  body: HTMLDivElement;
  cleanup: (() => void)[];
  ttl?: number;
}

const panels = new Map<string, Panel>();
let layer: HTMLElement;
let zTop = 10;
let seq = 0;

export function initPanels() {
  layer = $('#panels');
  window.addEventListener('resize', () => panels.forEach((p) => clampIntoView(p.el)));
}

export const newId = (prefix = 'p') => `${prefix}${(++seq).toString(36)}`;

// ---------- placement ----------
const DEFAULT_W = 400, DEFAULT_H = 300;

interface Box { x: number; y: number; w: number; h: number }

const GAP = 10;
const overlap = (a: Box, b: Box) =>
  Math.max(0, Math.min(a.x + a.w, b.x + b.w + GAP) - Math.max(a.x, b.x - GAP)) *
  Math.max(0, Math.min(a.y + a.h, b.y + b.h + GAP) - Math.max(a.y, b.y - GAP));

/** Untransformed layout box (ignores open/close scale animations). */
const boxOf = (el: HTMLElement): Box => ({ x: el.offsetLeft, y: el.offsetTop, w: el.offsetWidth, h: el.offsetHeight });

/**
 * Finds a free spot: scans from the screen edges inward, treating other panels and the
 * fixed HUD chrome (top bar, core/orb, log) as obstacles. If the screen is full,
 * picks the spot with the least overlap instead of stacking blindly.
 */
function autoPlace(self: HTMLElement, w: number, hgt: number) {
  const W = innerWidth, H = innerHeight;
  // Covering HUD chrome (orb, top bar, log) is 4x worse than overlapping another panel.
  const blocked: (Box & { weight: number })[] = [...panels.values()]
    .filter((p) => p.el !== self && !p.el.classList.contains('closing'))
    .map((p) => ({ ...boxOf(p.el), weight: 1 }));
  for (const sel of ['#topbar', '#core', '#log']) {
    const el = document.querySelector<HTMLElement>(sel);
    const r = el?.getBoundingClientRect();
    if (r && r.width && getComputedStyle(el!).opacity !== '0') blocked.push({ x: r.left, y: r.top, w: r.width, h: r.height, weight: 4 });
  }
  const xs: number[] = [];
  for (let x = 16; x + w <= W - 16; x += 24) xs.push(x);
  xs.sort((a, b) => Math.min(a, W - a - w) - Math.min(b, W - b - w));
  const ys: number[] = [];
  for (let y = 66; y + hgt <= H - 12; y += 24) ys.push(y);
  if (!xs.length) xs.push(16);
  if (!ys.length) ys.push(66);

  let best = { x: xs[0], y: ys[0], cost: Infinity };
  for (const y of ys) {
    for (const x of xs) {
      const cand = { x, y, w, h: hgt };
      const cost = blocked.reduce((s, b) => s + overlap(cand, b) * b.weight, 0);
      if (cost === 0) return { x, y };
      if (cost < best.cost) best = { x, y, cost };
    }
  }
  return best;
}

function clampIntoView(el: HTMLElement) {
  const r = el.getBoundingClientRect();
  el.style.left = `${Math.max(0, Math.min(innerWidth - 80, r.left))}px`;
  el.style.top = `${Math.max(0, Math.min(innerHeight - 40, r.top))}px`;
}

// ---------- rendering ----------
function renderBody(p: Panel) {
  p.cleanup.forEach((f) => f());
  p.cleanup = [];
  const s = p.spec;
  const b = p.body;
  b.className = `panel-body kind-${s.kind}`;
  switch (s.kind) {
    case 'text':
      b.innerHTML = `<div class="text">${esc(s.content)}</div>`;
      break;
    case 'markdown':
      b.innerHTML = `<div class="md">${markdown(s.content ?? '')}</div>`;
      break;
    case 'code': {
      b.innerHTML = `<pre class="code"><code>${esc(s.content)}</code></pre>`;
      const copy = h('button', { class: 'chip copy', 'data-hit': true }, iconEl('copy', 11), ' COPY');
      copy.onclick = () => navigator.clipboard.writeText(s.content ?? '').then(() => (copy.textContent = 'COPIED'));
      b.prepend(copy);
      break;
    }
    case 'list':
      b.innerHTML = `<ul class="list">${(s.items ?? []).map((i, n) => `<li style="animation-delay:${n * 40}ms"><span class="idx">${String(n + 1).padStart(2, '0')}</span>${esc(i)}</li>`).join('')}</ul>`;
      break;
    case 'table':
      b.innerHTML = `<table class="tbl"><thead><tr>${(s.columns ?? []).map((c) => `<th>${esc(c)}</th>`).join('')}</tr></thead><tbody>${(s.rows ?? [])
        .map((r, n) => `<tr style="animation-delay:${n * 30}ms">${r.map((c) => `<td>${esc(c)}</td>`).join('')}</tr>`)
        .join('')}</tbody></table>`;
      break;
    case 'image':
      b.innerHTML = '';
      b.append(h('img', { src: s.image_url ?? '', alt: s.title, class: 'img' }));
      break;
    case 'chart': {
      b.innerHTML = '';
      const canvas = h('canvas', { class: 'chart' });
      b.append(canvas);
      if (s.chart) {
        const chart = new Chart(canvas, s.chart);
        p.cleanup.push(() => chart.destroy());
      }
      break;
    }
    case 'stats':
      b.innerHTML = `<div class="stats">${(s.stats ?? [])
        .map((st, n) => {
          const pct = st.percent !== undefined ? Math.max(0, Math.min(100, st.percent)) : null;
          const trend = st.trend ? `<span class="trend ${st.trend}">${icon(st.trend === 'up' ? 'trend-up' : st.trend === 'down' ? 'trend-down' : 'minus', 14)}</span>` : '';
          return `<div class="stat" style="animation-delay:${n * 60}ms"><div class="stat-label">${esc(st.label)}</div><div class="stat-value">${esc(st.value)}${trend}</div>${
            pct !== null ? `<div class="bar"><i style="width:${pct}%"></i></div>` : ''
          }</div>`;
        })
        .join('')}</div>`;
      break;
    case 'visual': {
      b.innerHTML = '';
      const frame = h('iframe', { class: 'visual', sandbox: 'allow-scripts', referrerpolicy: 'no-referrer' });
      b.append(frame);
      hud.putVisual(s.id, wrapVisual(s.html ?? '')).then((url) => (frame.src = url));
      break;
    }
    case 'monitor':
      b.innerHTML = '';
      p.cleanup.push(mountMonitor(b));
      break;
  }
}

/** Gives generated visuals the HUD look by default: transparent background, gold text. */
function wrapVisual(html: string) {
  if (/<html[\s>]/i.test(html)) return html;
  return `<!doctype html><html><head><meta charset="utf-8"><style>
html,body{margin:0;height:100%;background:transparent;color:#fff1dc;font:13px "Segoe UI",system-ui,sans-serif;overflow:auto}
*{box-sizing:border-box}::-webkit-scrollbar{width:6px}::-webkit-scrollbar-thumb{background:#ffc23d55}
</style></head><body>${html}</body></html>`;
}

function applyBox(p: Panel, animate: boolean) {
  const s = p.spec;
  const el = p.el;
  const w = s.width !== undefined ? nw(s.width) : el.offsetWidth || DEFAULT_W;
  const hh = s.height !== undefined ? nh(s.height) : el.offsetHeight || DEFAULT_H;
  const pos = s.x !== undefined && s.y !== undefined ? { x: nx(s.x), y: ny(s.y) } : null;
  el.classList.toggle('moving', animate);
  if (s.width !== undefined) el.style.width = `${w}px`;
  if (s.height !== undefined) el.style.height = `${hh}px`;
  if (pos) {
    el.style.left = `${pos.x}px`;
    el.style.top = `${pos.y}px`;
  }
  if (animate) setTimeout(() => el.classList.remove('moving'), 450);
}

// ---------- public API ----------
export function openPanel(spec: PanelSpec): string {
  const existing = panels.get(spec.id);
  if (existing) {
    updatePanel(spec.id, spec);
    return spec.id;
  }
  const el = h('div', { class: 'panel opening', 'data-hit': true, 'data-id': spec.id });
  const accent = accentColor(spec.accent);
  if (accent) el.style.setProperty('--accent', accent);
  const title = h('span', { class: 'panel-title' }, spec.title);
  const minBtn = h('button', { class: 'pbtn', title: 'Collapse' }, iconEl('minus', 12));
  const closeBtn = h('button', { class: 'pbtn close', title: 'Close' }, iconEl('x', 12));
  const head = h('header', { class: 'panel-head' }, h('span', { class: 'panel-dot' }), title, h('span', { class: 'panel-id' }, `#${spec.id}`), minBtn, closeBtn);
  const body = h('div', { class: 'panel-body' });
  const grip = h('div', { class: 'panel-grip' });
  el.append(h('i', { class: 'corner tl' }), h('i', { class: 'corner br' }), head, body, grip, h('div', { class: 'scan' }));
  el.style.width = `${spec.width !== undefined ? nw(spec.width) : spec.kind === 'visual' ? 560 : DEFAULT_W}px`;
  if (spec.height !== undefined) el.style.height = `${nh(spec.height)}px`;
  else if (spec.kind === 'chart' || spec.kind === 'visual') el.style.height = `${spec.kind === 'visual' ? 420 : 280}px`;
  el.style.zIndex = String(++zTop);
  layer.append(el);

  const p: Panel = { spec, el, body, cleanup: [] };
  panels.set(spec.id, p);
  renderBody(p);

  if (spec.x === undefined || spec.y === undefined) {
    const { x, y } = autoPlace(el, el.offsetWidth, el.offsetHeight || DEFAULT_H);
    el.style.left = `${x}px`;
    el.style.top = `${y}px`;
  }
  applyBox(p, false);
  requestAnimationFrame(() => el.classList.remove('opening'));

  // interactions
  el.addEventListener('pointerdown', () => (el.style.zIndex = String(++zTop)));
  closeBtn.onclick = () => closePanel(spec.id);
  minBtn.onclick = () => el.classList.toggle('collapsed');
  drag(head, (dx, dy, start) => {
    el.style.left = `${start.left + dx}px`;
    el.style.top = `${start.top + dy}px`;
  }, el);
  drag(grip, (dx, dy, start) => {
    el.style.width = `${Math.max(220, start.width + dx)}px`;
    el.style.height = `${Math.max(120, start.height + dy)}px`;
  }, el);

  setTtl(p);
  return spec.id;
}

function setTtl(p: Panel) {
  clearTimeout(p.ttl);
  if (p.spec.ttl_seconds) p.ttl = window.setTimeout(() => closePanel(p.spec.id), p.spec.ttl_seconds * 1000);
}

function drag(handle: HTMLElement, onMove: (dx: number, dy: number, start: DOMRect) => void, el: HTMLElement) {
  handle.addEventListener('pointerdown', (e) => {
    if ((e.target as HTMLElement).closest('button')) return;
    e.preventDefault();
    const start = el.getBoundingClientRect();
    const sx = e.clientX, sy = e.clientY;
    const release = lockHit();
    el.classList.add('dragging');
    handle.setPointerCapture(e.pointerId);
    const move = (ev: PointerEvent) => onMove(ev.clientX - sx, ev.clientY - sy, start);
    const up = () => {
      release();
      el.classList.remove('dragging');
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', up);
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', up);
  });
}

export function updatePanel(id: string, patch: Partial<PanelSpec>) {
  const p = panels.get(id);
  if (!p) throw new Error(`No panel "${id}"`);
  const prevKind = p.spec.kind;
  const prevChart = p.spec.chart;
  p.spec = { ...p.spec, ...patch, id, chart: patch.chart ? { ...(prevChart ?? ({} as ChartData)), ...patch.chart } : prevChart };
  if (patch.title) $('.panel-title', p.el).textContent = patch.title;
  if (patch.accent) p.el.style.setProperty('--accent', accentColor(patch.accent)!);
  const contentKeys: (keyof PanelSpec)[] = ['content', 'items', 'rows', 'columns', 'image_url', 'chart', 'stats', 'html', 'kind'];
  if (contentKeys.some((k) => patch[k] !== undefined) || prevKind !== p.spec.kind) {
    renderBody(p);
    p.el.classList.remove('flash');
    void p.el.offsetWidth;
    p.el.classList.add('flash');
  }
  if (['x', 'y', 'width', 'height'].some((k) => k in patch)) applyBox(p, true);
  if (patch.ttl_seconds !== undefined) setTtl(p);
}

export function movePanel(id: string, box: { x?: number; y?: number; width?: number; height?: number }) {
  const p = panels.get(id);
  if (!p) throw new Error(`No panel "${id}"`);
  const r = p.el.getBoundingClientRect();
  p.spec = {
    ...p.spec,
    x: box.x ?? toGX(r.left),
    y: box.y ?? toGY(r.top),
    width: box.width ?? toGW(r.width),
    height: box.height ?? p.spec.height,
  };
  applyBox(p, true);
  p.el.style.zIndex = String(++zTop);
}

export function closePanel(id: string) {
  const p = panels.get(id);
  if (!p) return false;
  panels.delete(id);
  clearTimeout(p.ttl);
  p.cleanup.forEach((f) => f());
  p.el.classList.add('closing');
  setTimeout(() => p.el.remove(), 320);
  return true;
}

export function closeAllPanels() {
  const n = panels.size;
  [...panels.keys()].forEach(closePanel);
  return n;
}

export function listPanels() {
  return [...panels.values()].map((p) => {
    const r = p.el.getBoundingClientRect();
    return {
      id: p.spec.id,
      title: p.spec.title,
      kind: p.spec.kind,
      box: {
        x: Math.round(toGX(r.left)),
        y: Math.round(toGY(r.top)),
        width: Math.round(toGW(r.width)),
        height: Math.round(toGH(r.height)),
      },
    };
  });
}

export const hasPanel = (id: string) => panels.has(id);
