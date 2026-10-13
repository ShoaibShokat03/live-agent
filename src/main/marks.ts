import { nativeImage, type NativeImage } from 'electron';

/**
 * "Set-of-marks" annotation: numbered boxes drawn onto a screenshot so the model can say
 * "click #17" instead of estimating pixels. Pure pixel work on the BGRA bitmap (no deps).
 */

// 3x5 bitmap digits, row-major.
const DIGITS = [
  '111101101101111', '010110010010111', '111001111100111', '111001111001111', '101101111001001',
  '111100111001111', '111100111101111', '111001001001001', '111101111101111', '111101111001111',
];

export interface Mark {
  id: number;
  x: number; y: number; w: number; h: number; // image pixels
}

const COLORS: [number, number, number][] = [[230, 20, 40], [0, 120, 255], [0, 160, 60], [200, 0, 200], [255, 120, 0]];

export function annotate(img: NativeImage, marks: Mark[]): NativeImage {
  const { width: W, height: H } = img.getSize();
  const px = Buffer.from(img.toBitmap()); // BGRA on Windows
  const put = (x: number, y: number, [r, g, b]: [number, number, number]) => {
    if (x < 0 || y < 0 || x >= W || y >= H) return;
    const i = (y * W + x) * 4;
    px[i] = b; px[i + 1] = g; px[i + 2] = r; px[i + 3] = 255;
  };
  const rect = (x: number, y: number, w: number, h: number, c: [number, number, number]) => {
    for (let yy = y; yy < y + h; yy++) for (let xx = x; xx < x + w; xx++) put(xx, yy, c);
  };
  const S = 2; // digit pixel scale → 6x10 glyphs

  for (const m of marks) {
    const c = COLORS[m.id % COLORS.length];
    const x = Math.round(m.x), y = Math.round(m.y), w = Math.round(m.w), h = Math.round(m.h);
    // 2px outline
    rect(x, y, w, 2, c); rect(x, y + h - 2, w, 2, c); rect(x, y, 2, h, c); rect(x + w - 2, y, 2, h, c);
    // label: solid tag with white digits, placed above the box when there is room
    const text = String(m.id);
    const tw = text.length * (3 * S + S) + S, th = 5 * S + 2 * S;
    const lx = Math.min(Math.max(0, x), W - tw);
    const ly = y - th >= 0 ? y - th : y;
    rect(lx, ly, tw, th, c);
    [...text].forEach((d, k) => {
      const glyph = DIGITS[+d];
      for (let gy = 0; gy < 5; gy++)
        for (let gx = 0; gx < 3; gx++)
          if (glyph[gy * 3 + gx] === '1') rect(lx + S + k * 4 * S + gx * S, ly + S + gy * S, S, S, [255, 255, 255]);
    });
  }
  return nativeImage.createFromBitmap(px, { width: W, height: H });
}
