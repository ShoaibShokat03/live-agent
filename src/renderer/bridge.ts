import type { HudBridge } from '../shared/types';

export const hud = (window as unknown as { hud: HudBridge }).hud;

export const $ = <T extends HTMLElement = HTMLElement>(sel: string, root: ParentNode = document) =>
  root.querySelector(sel) as T;

export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, string | boolean> = {},
  ...children: (Node | string | null | undefined)[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === false) continue;
    if (k === 'class') el.className = String(v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children) if (c != null) el.append(c);
  return el;
}

export const esc = (s: unknown) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

/**
 * Normalized 0-1000 screen grid → CSS pixels inside the overlay. Maps against the physical
 * display (not the window), so marks land exactly on screen targets even if the window is offset.
 */
export const nx = (v: number) => (v / 1000) * screen.width - window.screenX;
export const ny = (v: number) => (v / 1000) * screen.height - window.screenY;
/** Normalized size → CSS pixels. */
export const nw = (v: number) => (v / 1000) * screen.width;
export const nh = (v: number) => (v / 1000) * screen.height;

/** CSS pixels inside the overlay → normalized 0-1000 screen grid. */
export const toGX = (px: number) => ((px + window.screenX) / screen.width) * 1000;
export const toGY = (px: number) => ((px + window.screenY) / screen.height) * 1000;
export const toGW = (px: number) => (px / screen.width) * 1000;
export const toGH = (px: number) => (px / screen.height) * 1000;
