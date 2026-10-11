import { hud } from '../bridge';

/**
 * Click-through control. The overlay ignores the mouse except over elements marked [data-hit].
 *
 * The renderer only *publishes* where those elements are; the main process polls the real
 * cursor and toggles click-through. (Relying on Chromium's forwarded mouse-moves fails
 * whenever another app has focus, so clicks would fall through to the window behind.)
 */
let locks = 0;
let lastRects = '';

function publish() {
  const rects: number[][] = [];
  document.querySelectorAll<HTMLElement>('[data-hit]').forEach((el) => {
    if (!el.checkVisibility({ opacityProperty: true, visibilityProperty: true })) return;
    if (getComputedStyle(el).pointerEvents === 'none') return;
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return;
    rects.push([Math.floor(r.left), Math.floor(r.top), Math.ceil(r.width), Math.ceil(r.height)]);
  });
  const key = JSON.stringify(rects);
  if (key !== lastRects) {
    lastRects = key;
    hud.setHitRects(rects);
  }
}

export function initHitTest() {
  // Cheap (a few dozen elements) and catches every layout change: drags, animations, new panels.
  setInterval(publish, 80);
  publish();

  // Typing needs the overlay to own the mouse and be the real foreground window.
  let releaseEdit: (() => void) | null = null;
  const isEditable = (el: EventTarget | null) =>
    el instanceof HTMLElement && (el.matches('input, textarea') || el.isContentEditable);

  // Clicking a text field claims the foreground (focus events can be deferred while inactive).
  document.addEventListener('pointerdown', (e) => isEditable(e.target) && hud.focus(), true);
  document.addEventListener('focusin', (e) => {
    if (!isEditable(e.target) || releaseEdit) return;
    releaseEdit = lockHit();
    hud.focus();
  });
  document.addEventListener('focusout', (e) => {
    if (!isEditable(e.target)) return;
    releaseEdit?.();
    releaseEdit = null;
  });
  // While editing, a click on empty space ends editing so click-through resumes.
  document.addEventListener('mousedown', (e) => {
    if (releaseEdit && !(e.target as HTMLElement).closest('[data-hit]')) (document.activeElement as HTMLElement)?.blur();
  });
}

/** Keep mouse capture during drags/resizes/editing even when the pointer leaves the element. */
export function lockHit() {
  if (locks++ === 0) hud.setHitLock(true);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    if (--locks === 0) hud.setHitLock(false);
  };
}
