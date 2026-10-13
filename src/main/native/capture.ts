/**
 * Fast GDI screen capture that leaves out the JARVIS HUD.
 *
 * The HUD is a transparent *layered* window. Windows refuses to exclude layered windows from
 * capture via SetWindowDisplayAffinity, but a BitBlt from the screen DC *without* CAPTUREBLT
 * never includes layered windows — so the AI sees your real desktop, not JARVIS's widgets.
 * Also ~10x faster than Electron's desktopCapturer.
 */
import koffi from 'koffi';
import { nativeImage, type NativeImage } from 'electron';

let g: ReturnType<typeof bind> | null = null;

function bind() {
  const user32 = koffi.load('user32.dll');
  const gdi32 = koffi.load('gdi32.dll');
  return {
    GetDC: user32.func('intptr_t __stdcall GetDC(intptr_t hwnd)'),
    ReleaseDC: user32.func('int __stdcall ReleaseDC(intptr_t hwnd, intptr_t hdc)'),
    CreateCompatibleDC: gdi32.func('intptr_t __stdcall CreateCompatibleDC(intptr_t hdc)'),
    CreateCompatibleBitmap: gdi32.func('intptr_t __stdcall CreateCompatibleBitmap(intptr_t hdc, int w, int h)'),
    SelectObject: gdi32.func('intptr_t __stdcall SelectObject(intptr_t hdc, intptr_t obj)'),
    BitBlt: gdi32.func('bool __stdcall BitBlt(intptr_t dst, int x, int y, int w, int h, intptr_t src, int sx, int sy, uint32_t rop)'),
    GetDIBits: gdi32.func('int __stdcall GetDIBits(intptr_t hdc, intptr_t hbm, uint32_t start, uint32_t lines, void *bits, void *bmi, uint32_t usage)'),
    DeleteObject: gdi32.func('bool __stdcall DeleteObject(intptr_t obj)'),
    DeleteDC: gdi32.func('bool __stdcall DeleteDC(intptr_t hdc)'),
  };
}

const SRCCOPY = 0x00cc0020; // deliberately NOT | CAPTUREBLT (0x40000000)

/** Capture a physical-pixel rectangle of the screen (HUD excluded) as a NativeImage. */
export function gdiCapture(x: number, y: number, w: number, h: number): NativeImage {
  if (process.platform !== 'win32') throw new Error('GDI capture is Windows-only');
  g ??= bind();
  const screenDC = g.GetDC(0);
  const memDC = g.CreateCompatibleDC(screenDC);
  const bmp = g.CreateCompatibleBitmap(screenDC, w, h);
  const old = g.SelectObject(memDC, bmp);
  try {
    if (!g.BitBlt(memDC, 0, 0, w, h, screenDC, x, y, SRCCOPY)) throw new Error('BitBlt failed');
    const bmi = Buffer.alloc(44);
    bmi.writeUInt32LE(40, 0); // biSize
    bmi.writeInt32LE(w, 4);
    bmi.writeInt32LE(-h, 8); // top-down rows
    bmi.writeUInt16LE(1, 12); // planes
    bmi.writeUInt16LE(32, 14); // BGRA
    const px = Buffer.alloc(w * h * 4);
    if (!g.GetDIBits(memDC, bmp, 0, h, px, bmi, 0)) throw new Error('GetDIBits failed');
    for (let i = 3; i < px.length; i += 4) px[i] = 255; // GDI leaves alpha at 0
    return nativeImage.createFromBitmap(px, { width: w, height: h });
  } finally {
    g.SelectObject(memDC, old);
    g.DeleteObject(bmp);
    g.DeleteDC(memDC);
    g.ReleaseDC(0, screenDC);
  }
}
