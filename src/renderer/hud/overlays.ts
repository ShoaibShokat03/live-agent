import { $, esc, h, nh, nw, nx, ny } from '../bridge';
import { iconEl } from './icons';

// ---------------- Toasts ----------------
export type Level = 'info' | 'success' | 'warning' | 'error';

export function toast(title: string, message = '', level: Level = 'info', seconds = 5) {
  const el = h(
    'div',
    { class: `toast ${level}`, 'data-hit': true },
    h('span', { class: 'toast-icon' }, iconEl(level, 20)),
    h('div', { class: 'toast-text' }, h('b', {}, title), message ? h('p', {}, message) : null),
    h('i', { class: 'toast-bar' }),
  );
  (el.querySelector('.toast-bar') as HTMLElement).style.animationDuration = `${seconds}s`;
  $('#toasts').prepend(el);
  const close = () => {
    el.classList.add('out');
    setTimeout(() => el.remove(), 300);
  };
  el.onclick = close;
  setTimeout(close, seconds * 1000);
}

// ---------------- Activity log ----------------
const MAX_LOG = 40;

export function logStart(id: string, name: string, args: unknown) {
  const summary = summarize(args);
  const el = h(
    'div',
    { class: 'log-row run', 'data-call': id },
    h('span', { class: 'log-time' }, new Date().toLocaleTimeString([], { hour12: false })),
    h('span', { class: 'log-name' }, name),
    h('span', { class: 'log-args', title: summary }, summary),
    h('span', { class: 'log-status' }, '…'),
  );
  const list = $('#log-list');
  list.prepend(el);
  while (list.childElementCount > MAX_LOG) list.lastElementChild?.remove();
  $('#log').classList.add('active');
}

export function logEnd(id: string, ok: boolean, ms: number, detail?: string) {
  const el = document.querySelector<HTMLElement>(`[data-call="${CSS.escape(id)}"]`);
  if (!el) return;
  el.classList.remove('run');
  el.classList.add(ok ? 'ok' : 'err');
  el.querySelector('.log-status')!.textContent = ok ? `${ms}ms` : 'FAIL';
  if (detail) el.title = detail;
  if (!document.querySelector('.log-row.run')) $('#log').classList.remove('active');
}

function summarize(args: unknown) {
  if (!args || typeof args !== 'object') return '';
  return Object.entries(args as Record<string, unknown>)
    .map(([k, v]) => `${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`)
    .join(' ')
    .slice(0, 120);
}

// ---------------- Screen FX ----------------
export function rippleAt(x: number, y: number, kind: 'click' | 'move' = 'click') {
  const el = h('div', { class: `fx-ripple ${kind}` });
  el.style.left = `${nx(x)}px`;
  el.style.top = `${ny(y)}px`;
  $('#fx').append(el);
  setTimeout(() => el.remove(), 900);
}

export function markRegion(box: { x: number; y: number; width: number; height: number }, label = '', seconds = 6, color?: string) {
  const el = h('div', { class: 'fx-mark' }, label ? h('span', {}, label) : null);
  Object.assign(el.style, {
    left: `${nx(box.x)}px`,
    top: `${ny(box.y)}px`,
    width: `${nw(box.width)}px`,
    height: `${nh(box.height)}px`,
  });
  if (color) el.style.setProperty('--accent', color);
  $('#fx').append(el);
  setTimeout(() => {
    el.classList.add('out');
    setTimeout(() => el.remove(), 400);
  }, seconds * 1000);
}

export function pointAt(x: number, y: number, label = '', seconds = 5) {
  const el = h('div', { class: 'fx-reticle' }, h('i'), h('i'), label ? h('span', {}, label) : null);
  el.style.left = `${nx(x)}px`;
  el.style.top = `${ny(y)}px`;
  $('#fx').append(el);
  setTimeout(() => {
    el.classList.add('out');
    setTimeout(() => el.remove(), 400);
  }, seconds * 1000);
}

export function typingFx(text: string) {
  const el = h('div', { class: 'fx-typing' }, iconEl('keyboard', 14), ` ${text.length > 60 ? text.slice(0, 60) + '…' : text}`);
  $('#fx').append(el);
  setTimeout(() => el.remove(), 1800);
}

// ---------------- Confirmation ----------------
let pending: Promise<unknown> = Promise.resolve();

/** Serialized approve/deny dialog. Auto-denies after 60 s. */
export function confirmAction(title: string, detail: string): Promise<boolean> {
  const run = () =>
    new Promise<boolean>((resolve) => {
      const approve = h('button', { class: 'btn approve' }, 'APPROVE');
      const deny = h('button', { class: 'btn deny' }, 'DENY');
      const el = h(
        'div',
        { class: 'confirm', 'data-hit': true },
        h('div', { class: 'confirm-head' }, iconEl('shield', 14), ' AUTHORIZATION REQUIRED'),
        h('div', { class: 'confirm-title' }, title),
        h('pre', { class: 'confirm-detail' }, detail),
        h('div', { class: 'confirm-actions' }, deny, approve),
        h('i', { class: 'confirm-timer' }),
      );
      $('#modal').append(el);
      const done = (ok: boolean) => {
        clearTimeout(t);
        el.classList.add('out');
        setTimeout(() => el.remove(), 250);
        resolve(ok);
      };
      const t = setTimeout(() => done(false), 60000);
      approve.onclick = () => done(true);
      deny.onclick = () => done(false);
    });
  const p = pending.then(run);
  pending = p.catch(() => {});
  return p;
}

// ---------------- Subtitles ----------------
let userLine = '', aiLine = '';
let fadeTimer = 0;

export function subtitle(who: 'user' | 'ai', text: string, append = true) {
  if (who === 'user') userLine = append ? userLine + text : text;
  else aiLine = append ? aiLine + text : text;
  const el = $('#subs');
  el.innerHTML = `${userLine ? `<div class="sub-user">› ${esc(userLine.slice(-160))}</div>` : ''}${aiLine ? `<div class="sub-ai">${esc(aiLine.slice(-260))}</div>` : ''}`;
  el.classList.add('show');
  clearTimeout(fadeTimer);
}

export function subtitleTurnEnd() {
  clearTimeout(fadeTimer);
  fadeTimer = window.setTimeout(() => {
    $('#subs').classList.remove('show');
    userLine = aiLine = '';
  }, 7000);
}

export function subtitleNewUserTurn() {
  if (aiLine) {
    userLine = '';
    aiLine = '';
  }
}
