/**
 * Direct Win32 bindings via koffi (N-API FFI, prebuilt — no node-gyp).
 * Calls take microseconds, far faster than shelling out to PowerShell.
 */
import koffi from 'koffi';

export const isWindows = process.platform === 'win32';

function bind() {
  const user32 = koffi.load('user32.dll');
  const kernel32 = koffi.load('kernel32.dll');
  const dwmapi = koffi.load('dwmapi.dll');

  koffi.struct('RECT', { left: 'int32', top: 'int32', right: 'int32', bottom: 'int32' });
  koffi.struct('POINT', { x: 'int32', y: 'int32' });
  const EnumWindowsProc = koffi.proto('bool __stdcall EnumWindowsProc(intptr_t hwnd, intptr_t lParam)');

  return {
    EnumWindowsProc,
    SetCursorPos: user32.func('bool __stdcall SetCursorPos(int x, int y)'),
    GetCursorPos: user32.func('bool __stdcall GetCursorPos(_Out_ POINT *p)'),
    mouse_event: user32.func('void __stdcall mouse_event(uint32_t flags, uint32_t dx, uint32_t dy, int32_t data, uintptr_t extra)'),
    keybd_event: user32.func('void __stdcall keybd_event(uint8_t vk, uint8_t scan, uint32_t flags, uintptr_t extra)'),
    EnumWindows: user32.func('bool __stdcall EnumWindows(EnumWindowsProc *cb, intptr_t lParam)'),
    GetWindowTextW: user32.func('int __stdcall GetWindowTextW(intptr_t hwnd, void *buf, int max)'),
    GetWindowTextLengthW: user32.func('int __stdcall GetWindowTextLengthW(intptr_t hwnd)'),
    IsWindowVisible: user32.func('bool __stdcall IsWindowVisible(intptr_t hwnd)'),
    IsIconic: user32.func('bool __stdcall IsIconic(intptr_t hwnd)'),
    IsZoomed: user32.func('bool __stdcall IsZoomed(intptr_t hwnd)'),
    GetWindowRect: user32.func('bool __stdcall GetWindowRect(intptr_t hwnd, _Out_ RECT *r)'),
    GetWindowThreadProcessId: user32.func('uint32_t __stdcall GetWindowThreadProcessId(intptr_t hwnd, _Out_ uint32_t *pid)'),
    GetForegroundWindow: user32.func('intptr_t __stdcall GetForegroundWindow()'),
    SetForegroundWindow: user32.func('bool __stdcall SetForegroundWindow(intptr_t hwnd)'),
    ShowWindow: user32.func('bool __stdcall ShowWindow(intptr_t hwnd, int cmd)'),
    MoveWindow: user32.func('bool __stdcall MoveWindow(intptr_t hwnd, int x, int y, int w, int h, bool repaint)'),
    PostMessageW: user32.func('bool __stdcall PostMessageW(intptr_t hwnd, uint32_t msg, uintptr_t w, intptr_t l)'),
    GetWindowLongW: user32.func('int32_t __stdcall GetWindowLongW(intptr_t hwnd, int index)'),
    OpenProcess: kernel32.func('intptr_t __stdcall OpenProcess(uint32_t access, bool inherit, uint32_t pid)'),
    QueryFullProcessImageNameW: kernel32.func('bool __stdcall QueryFullProcessImageNameW(intptr_t h, uint32_t flags, void *buf, _Inout_ uint32_t *size)'),
    CloseHandle: kernel32.func('bool __stdcall CloseHandle(intptr_t h)'),
    DwmGetWindowAttribute: dwmapi.func('int32_t __stdcall DwmGetWindowAttribute(intptr_t hwnd, uint32_t attr, _Out_ uint32_t *val, uint32_t size)'),
  };
}

let api: ReturnType<typeof bind> | null = null;
export function w32() {
  if (!isWindows) throw new Error('This tool is only supported on Windows');
  return (api ??= bind());
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---------- Mouse ----------
const MOUSE = {
  left: [0x0002, 0x0004],
  right: [0x0008, 0x0010],
  middle: [0x0020, 0x0040],
} as const;

export type Button = keyof typeof MOUSE;

export function cursorPos(): { x: number; y: number } {
  const p: any = {};
  w32().GetCursorPos(p);
  return { x: p.x, y: p.y };
}

export function setCursor(x: number, y: number) {
  w32().SetCursorPos(Math.round(x), Math.round(y));
}

/** Eased cursor glide — fast (~120ms) but visible, like a human hand. */
export async function glide(x: number, y: number, ms = 120) {
  const from = cursorPos();
  const steps = Math.max(1, Math.round(ms / 10));
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    const e = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
    setCursor(from.x + (x - from.x) * e, from.y + (y - from.y) * e);
    if (i < steps) await sleep(10);
  }
}

export function mouseDown(b: Button = 'left') {
  w32().mouse_event(MOUSE[b][0], 0, 0, 0, 0);
}
export function mouseUp(b: Button = 'left') {
  w32().mouse_event(MOUSE[b][1], 0, 0, 0, 0);
}
export async function click(b: Button = 'left', count = 1) {
  for (let i = 0; i < count; i++) {
    mouseDown(b);
    await sleep(15);
    mouseUp(b);
    if (i < count - 1) await sleep(40);
  }
}
export function wheel(notches: number, horizontal = false) {
  w32().mouse_event(horizontal ? 0x1000 : 0x0800, 0, 0, Math.round(notches * 120), 0);
}

// ---------- Keyboard ----------
const VK: Record<string, number> = {
  backspace: 0x08, tab: 0x09, enter: 0x0d, return: 0x0d, shift: 0x10, ctrl: 0x11, control: 0x11,
  alt: 0x12, pause: 0x13, capslock: 0x14, esc: 0x1b, escape: 0x1b, space: 0x20,
  pageup: 0x21, pagedown: 0x22, end: 0x23, home: 0x24, left: 0x25, up: 0x26, right: 0x27, down: 0x28,
  printscreen: 0x2c, insert: 0x2d, delete: 0x2e, del: 0x2e, win: 0x5b, windows: 0x5b, meta: 0x5b,
  cmd: 0x5b, apps: 0x5d, numlock: 0x90, scrolllock: 0x91,
  volumemute: 0xad, volumedown: 0xae, volumeup: 0xaf, medianext: 0xb0, mediaprev: 0xb1,
  mediastop: 0xb2, mediaplaypause: 0xb3,
  ';': 0xba, '=': 0xbb, ',': 0xbc, '-': 0xbd, '.': 0xbe, '/': 0xbf, '`': 0xc0,
  '[': 0xdb, '\\': 0xdc, ']': 0xdd, "'": 0xde,
};
for (let i = 0; i < 26; i++) VK[String.fromCharCode(97 + i)] = 0x41 + i;
for (let i = 0; i < 10; i++) VK[String(i)] = 0x30 + i;
for (let i = 1; i <= 24; i++) VK[`f${i}`] = 0x6f + i;
const EXTENDED = new Set([0x21, 0x22, 0x23, 0x24, 0x25, 0x26, 0x27, 0x28, 0x2d, 0x2e, 0x5b, 0x5d]);

export function vk(key: string): number {
  const k = key.trim().toLowerCase();
  const code = VK[k];
  if (code === undefined) throw new Error(`Unknown key "${key}"`);
  return code;
}

export function keyDown(code: number) {
  w32().keybd_event(code, 0, EXTENDED.has(code) ? 1 : 0, 0);
}
export function keyUp(code: number) {
  w32().keybd_event(code, 0, (EXTENDED.has(code) ? 1 : 0) | 0x0002, 0);
}

/** Press a chord like "ctrl+shift+esc" or "win+d". */
export async function chord(combo: string) {
  const codes = combo.split('+').map((k) => k.trim()).filter(Boolean).map(vk);
  for (const c of codes) keyDown(c);
  await sleep(20);
  for (const c of [...codes].reverse()) keyUp(c);
}

// ---------- Windows ----------
export interface WinInfo {
  hwnd: number;
  title: string;
  process: string;
  pid: number;
  rect: { x: number; y: number; w: number; h: number };
  minimized: boolean;
  maximized: boolean;
  focused: boolean;
}

function processName(pid: number): string {
  const a = w32();
  const h = a.OpenProcess(0x1000, false, pid); // PROCESS_QUERY_LIMITED_INFORMATION
  if (!h) return '';
  try {
    const buf = Buffer.alloc(1040);
    const size = [520];
    if (!a.QueryFullProcessImageNameW(h, 0, buf, size)) return '';
    return buf.toString('utf16le', 0, size[0] * 2).split('\\').pop() ?? '';
  } finally {
    a.CloseHandle(h);
  }
}

/** Top-level, user-visible application windows (skips tool windows and cloaked UWP shells). */
export function listWindows(): WinInfo[] {
  const a = w32();
  const fg = Number(a.GetForegroundWindow());
  const out: WinInfo[] = [];
  const cb = koffi.register((h: number | bigint) => {
    const hwnd = Number(h);
    if (!a.IsWindowVisible(hwnd)) return true;
    const len = a.GetWindowTextLengthW(hwnd);
    if (len === 0) return true;
    if (a.GetWindowLongW(hwnd, -20) & 0x80) return true; // WS_EX_TOOLWINDOW
    const cloaked = [0];
    a.DwmGetWindowAttribute(hwnd, 14, cloaked, 4); // DWMWA_CLOAKED
    if (cloaked[0]) return true;
    const buf = Buffer.alloc((len + 1) * 2);
    a.GetWindowTextW(hwnd, buf, len + 1);
    const pid = [0];
    a.GetWindowThreadProcessId(hwnd, pid);
    const r: any = {};
    a.GetWindowRect(hwnd, r);
    out.push({
      hwnd,
      title: buf.toString('utf16le', 0, len * 2),
      pid: pid[0],
      process: processName(pid[0]),
      rect: { x: r.left, y: r.top, w: r.right - r.left, h: r.bottom - r.top },
      minimized: a.IsIconic(hwnd),
      maximized: a.IsZoomed(hwnd),
      focused: hwnd === fg,
    });
    return true;
  }, koffi.pointer(a.EnumWindowsProc));
  try {
    a.EnumWindows(cb, 0);
  } finally {
    koffi.unregister(cb);
  }
  return out;
}

export function focusWindow(hwnd: number) {
  const a = w32();
  if (a.IsIconic(hwnd)) a.ShowWindow(hwnd, 9); // SW_RESTORE
  // Tapping Alt releases Windows' foreground lock so SetForegroundWindow succeeds.
  keyDown(0x12);
  keyUp(0x12);
  return a.SetForegroundWindow(hwnd);
}

export const SW = { minimize: 6, maximize: 3, restore: 9 } as const;
