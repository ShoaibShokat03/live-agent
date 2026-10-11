import { hud } from '../bridge';

/**
 * The overlay is click-through by default. When the pointer is over any element marked
 * [data-hit], we capture the mouse; otherwise clicks fall through to the desktop.
 */
let ignoring = true;
let locks = 0;

function set(ignore: boolean) {
  if (ignore === ignoring) return;
  ignoring = ignore;
  hud.setIgnoreMouse(ignore);
}

export function initHitTest() {
  document.addEventListener('mousemove', (e) => {
    if (locks) return;
    const el = document.elementFromPoint(e.clientX, e.clientY);
    set(!el?.closest('[data-hit]'));
  });
  document.addEventListener('mouseleave', () => !locks && set(true));
}

/** Hold mouse capture during drags/resizes even if the pointer leaves the element. */
export function lockHit() {
  locks++;
  set(false);
  return () => {
    locks = Math.max(0, locks - 1);
  };
}
