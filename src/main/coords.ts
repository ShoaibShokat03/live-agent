import { screen } from 'electron';

/**
 * Every coordinate the model uses is on a 0-1000 normalized grid over the primary display
 * (Gemini's native spatial format). These helpers map it to physical pixels for Win32.
 */
export function toPhysical(nx: number, ny: number) {
  const b = screen.getPrimaryDisplay().bounds;
  const dip = { x: b.x + (nx / 1000) * b.width, y: b.y + (ny / 1000) * b.height };
  return process.platform === 'win32' ? screen.dipToScreenPoint(dip) : dip;
}

export function toNormalized(px: number, py: number) {
  const b = screen.getPrimaryDisplay().bounds;
  const dip = process.platform === 'win32' ? screen.screenToDipPoint({ x: px, y: py }) : { x: px, y: py };
  return {
    x: Math.round(((dip.x - b.x) / b.width) * 1000),
    y: Math.round(((dip.y - b.y) / b.height) * 1000),
  };
}

/** Normalized size (0-1000) to physical pixel size. */
export function sizeToPhysical(nw: number, nh: number) {
  const d = screen.getPrimaryDisplay();
  return {
    w: Math.round((nw / 1000) * d.bounds.width * d.scaleFactor),
    h: Math.round((nh / 1000) * d.bounds.height * d.scaleFactor),
  };
}
