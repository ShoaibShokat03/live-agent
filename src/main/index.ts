import { app, BrowserWindow, clipboard, globalShortcut, ipcMain, Menu, nativeImage, protocol, screen, session, Tray } from 'electron';
import { isWindows, w32 } from './native/win32';
import path from 'node:path';
import type { AppConfig, HotkeyAction } from '../shared/types';
import { getConfig, setConfig } from './config';
import { sampleStats } from './stats';
import { fileTools } from './tools/files';
import { inputTools } from './tools/input';
import { memoryTools } from './tools/memory';
import { execute, manifest, register, type ToolContext } from './tools/registry';
import { captureFrame, screenTools } from './tools/screen';
import { systemTools } from './tools/system';
import { uiTools } from './tools/ui';
import { uia } from './native/uia';
import { setCaptureGuard } from './vision';
import fs from 'node:fs';
import { addFaces, addVoice, faceDb, forgetPerson, listPeople, matchVoice } from './people';
import { embedVoice, loadVoiceModel, setVoiceCacheDir } from './voiceprint';
import { warmAppIndex, windowTools } from './tools/windows';
import { webTools } from './tools/web';

// Sandboxed origin for AI-generated interactive visuals (HTML/JS panels). Isolated from the HUD.
protocol.registerSchemesAsPrivileged([
  { scheme: 'visual', privileges: { standard: true, secure: true, supportFetchAPI: true } },
  // Local ML model files for the HUD (face recognition), served read-only from node_modules.
  { scheme: 'models', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } },
]);
const visuals = new Map<string, string>();

app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
// A transparent always-on-top overlay must never be treated as "covered": Chromium's occlusion
// tracking would pause its rendering and animations (frozen HUD, stuck fade-ins, unclickable bar).
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');
app.commandLine.appendSwitch('disable-background-timer-throttling');

if (!app.requestSingleInstanceLock()) app.quit();

register([...uiTools, ...inputTools, ...windowTools, ...screenTools, ...systemTools, ...fileTools, ...webTools, ...memoryTools]);

let win: BrowserWindow | null = null;
let tray: Tray | null = null;

const ctx: ToolContext = {
  win: () => win,
  emit: (channel, payload) => win?.webContents.send(channel, payload),
  async passthrough(fn) {
    hit.agent++;
    setCapture(false);
    try {
      return await fn();
    } finally {
      // Small tail so the OS finishes delivering the click before the HUD can capture again.
      setTimeout(() => hit.agent--, 150);
    }
  },
};

function createWindow() {
  const { bounds } = screen.getPrimaryDisplay();
  win = new BrowserWindow({
    ...bounds,
    transparent: true,
    frame: false,
    resizable: false,
    movable: false,
    hasShadow: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    show: false,
    backgroundColor: '#00000000',
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false,
    },
  });
  win.setAlwaysOnTop(true, 'screen-saver');
  win.setIgnoreMouseEvents(true);
  win.loadFile(path.join(__dirname, '../renderer/index.html'));
  win.once('ready-to-show', () => {
    showOverlay();
    // Windows clamps new windows to the work area; re-apply so the overlay also covers the taskbar
    // and the HUD's 0-1000 grid matches the screen grid exactly.
    win?.setBounds(screen.getPrimaryDisplay().bounds);
  });
  win.on('closed', () => (win = null));
  win.on('minimize', () => {
    // Restoring inside the minimize event races Chromium's compositor and freezes the HUD
    // (animations stuck, nothing repaints). Restore on the next tick, then force a repaint.
    setTimeout(() => {
      if (!win) return;
      win.restore();
      showOverlay();
      win.webContents.invalidate();
    }, 60);
  });
  // Other always-on-top apps can push in front of the HUD; quietly reclaim the top spot.
  setInterval(() => win?.isVisible() && !win.isMinimized() && keepOnTop(), 5000);
  attachEditContextMenu(win);

  // Keep the overlay glued to the primary display if resolution / scaling changes.
  screen.on('display-metrics-changed', () => win?.setBounds(screen.getPrimaryDisplay().bounds));
}

// ---------- Click-through ----------
// The renderer publishes where its clickable widgets are; we poll the real cursor at 60 Hz and
// stop being click-through only over them. Works no matter which app has focus.
const hit = { rects: [] as number[][], locked: false, capturing: false, agent: 0 };

/**
 * Source of truth is the window's real WS_EX_TRANSPARENT flag, not a cached value: Windows/Electron
 * can silently reset it (e.g. after a minimize → restore), which used to leave the HUD unclickable.
 */
function setCapture(on: boolean) {
  if (!win) return;
  const ignoring = isWindows ? !!(w32().GetWindowLongW(Number(win.getNativeWindowHandle().readBigUInt64LE(0)), -20) & 0x20) : !hit.capturing;
  hit.capturing = on;
  if (ignoring === !on) return;
  win.setIgnoreMouseEvents(!on);
}

function startHitPolling() {
  setInterval(() => {
    if (!win || !win.isVisible() || hit.agent > 0) return setCapture(false);
    const c = screen.getCursorScreenPoint();
    const b = win.getBounds();
    const x = c.x - b.x, y = c.y - b.y;
    setCapture(hit.locked || hit.rects.some(([rx, ry, rw, rh]) => x >= rx && x < rx + rw && y >= ry && y < ry + rh));
  }, 16);
}

/**
 * Bring the overlay to the real foreground so typing and pasting reach it. Called right after
 * the user clicks a text field, so Windows allows the switch without any foreground-lock tricks
 * (an Alt tap here would toggle menu-key mode and corrupt the next keystroke).
 */
function focusOverlay() {
  if (!win) return;
  setCapture(true);
  if (isWindows) {
    try {
      const hwnd = Number(win.getNativeWindowHandle().readBigUInt64LE(0));
      if (Number(w32().GetForegroundWindow()) !== hwnd) w32().SetForegroundWindow(hwnd);
    } catch {}
  }
  if (!win.isFocused()) win.focus();
  win.webContents.focus();
}

/** Cut/Copy/Paste/Select-all on right-click in any text field. */
function attachEditContextMenu(w: BrowserWindow) {
  w.webContents.on('context-menu', (_e, p) => {
    if (!p.isEditable && !p.selectionText) return;
    Menu.buildFromTemplate(
      p.isEditable
        ? [
            { role: 'cut', enabled: p.editFlags.canCut },
            { role: 'copy', enabled: p.editFlags.canCopy },
            { role: 'paste', enabled: p.editFlags.canPaste },
            { type: 'separator' },
            { role: 'selectAll' },
          ]
        : [{ role: 'copy' }],
    ).popup({ window: w });
  });
}

/**
 * Every screenshot for the AI must show the real desktop, not JARVIS. Windows can't exclude
 * Electron's transparent overlay from capture, and Chromium can leave stale pixels when the page
 * hides itself, so the window is moved off-screen at the OS level for the capture (~60 ms blink).
 */
function installCaptureGuard() {
  let depth = 0;
  const SWP = 0x0001 | 0x0004 | 0x0010; // NOSIZE | NOZORDER | NOACTIVATE
  setCaptureGuard(async (fn) => {
    if (!win || !win.isVisible() || !isWindows || depth > 0) return fn();
    depth++;
    const hwnd = Number(win.getNativeWindowHandle().readBigUInt64LE(0));
    const r: any = {};
    w32().GetWindowRect(hwnd, r);
    try {
      w32().SetWindowPos(hwnd, 0, -32000, -32000, 0, 0, SWP);
      await new Promise((res) => setTimeout(res, Number(process.env.JARVIS_CAPTURE_DELAY ?? 40))); // next DWM frame
      return await fn();
    } finally {
      w32().SetWindowPos(hwnd, 0, r.left, r.top, 0, 0, SWP);
      depth--;
    }
  });
}

/** Restoring/showing a window drops it out of the topmost band on Windows — always re-assert. */
function keepOnTop() {
  win?.setAlwaysOnTop(true, 'screen-saver');
  win?.moveTop();
}

function showOverlay() {
  win?.showInactive();
  keepOnTop();
}

function toggleHud() {
  if (!win) return;
  if (win.isVisible()) return win.hide();
  showOverlay();
  win.webContents.send('hotkey', 'toggle-hud'); // renderer restores the full HUD (leaves mini mode)
}

/**
 * Arc-reactor tray icon (gold ring, red core) drawn as raw BGRA pixels with anti-aliased edges.
 * Windows can't load SVG into nativeImage, and drawing it avoids shipping an image file.
 */
function reactorIcon(size: number) {
  const buf = Buffer.alloc(size * size * 4);
  const c = (size - 1) / 2;
  const s = size / 32;
  const cover = (d: number, inner: number, outer: number) => Math.max(0, Math.min(1, d - inner + 0.5, outer - d + 0.5));
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const d = Math.hypot(x - c, y - c);
      const ring = cover(d, 11 * s, 14.5 * s); // gold #ffc23d
      const core = cover(d, -1, 6 * s); // red #ff3b3b
      const a = Math.max(ring, core);
      if (!a) continue;
      const [r, g, b] = core >= ring ? [255, 59, 59] : [255, 194, 61];
      const i = (y * size + x) * 4;
      buf[i] = b;
      buf[i + 1] = g;
      buf[i + 2] = r;
      buf[i + 3] = Math.round(a * 255);
    }
  }
  return nativeImage.createFromBitmap(buf, { width: size, height: size });
}

function createTray() {
  tray = new Tray(reactorIcon(32));
  tray.setToolTip('JARVIS');
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: `Show / Hide HUD   (${hotkeys.hud})`, click: toggleHud },
      { label: `Toggle microphone (${hotkeys.mic})`, click: () => hotkey('toggle-mic') },
      { label: `Toggle screen vision (${hotkeys.vision})`, click: () => hotkey('toggle-vision') },
      { type: 'separator' },
      { label: 'Quit', click: () => app.quit() },
    ]),
  );
  tray.on('click', toggleHud);
}

/** Active global shortcuts (first free combo from each fallback list). */
const hotkeys = { mic: '', hud: '', vision: '' };

function bindFirst(combos: string[], fn: () => void): string {
  for (const c of combos) if (globalShortcut.register(c, fn)) return c.replace('Control', 'Ctrl');
  console.warn(`All hotkeys taken: ${combos.join(', ')}`);
  return '';
}

const hotkey = (a: HotkeyAction) => {
  if (a !== 'toggle-hud' && win && !win.isVisible()) showOverlay();
  win?.webContents.send('hotkey', a);
};

function registerIpc() {
  ipcMain.handle('config:get', () => getConfig());
  ipcMain.handle('config:set', (_e, patch: Partial<AppConfig>) => setConfig(patch));
  ipcMain.handle('app:hotkeys', () => hotkeys);

  // ---- People: faces & voices (biometrics stay on this PC, encrypted) ----
  ipcMain.handle('people:list', () => listPeople());
  ipcMain.handle('people:faces', () => faceDb());
  ipcMain.handle('people:addFaces', (_e, name: string, descriptors: number[][]) => addFaces(name, descriptors));
  ipcMain.handle('people:forget', (_e, name: string) => forgetPerson(name));
  const pcm = (buf: ArrayBuffer | Uint8Array) => new Int16Array(buf instanceof Uint8Array ? buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) : buf);
  const voiceProgress = (pct: number) => win?.webContents.send('event', { type: 'voice-model', pct: Math.round(pct) });
  ipcMain.handle('voice:enroll', async (_e, name: string, audio: ArrayBuffer) => {
    await loadVoiceModel(voiceProgress);
    return addVoice(name, await embedVoice(pcm(audio)));
  });
  ipcMain.handle('voice:identify', async (_e, audio: ArrayBuffer) => {
    await loadVoiceModel(voiceProgress);
    return matchVoice(await embedVoice(pcm(audio)));
  });
  ipcMain.handle('tools:manifest', () => manifest());
  ipcMain.handle('tools:exec', (_e, name: string, args: unknown) => execute(name, args, ctx));
  ipcMain.handle('stats:get', () => sampleStats());
  ipcMain.handle('screen:frame', () => captureFrame(1024, 60));
  ipcMain.handle('visual:put', (_e, id: string, html: string) => {
    visuals.set(id, html);
    return `visual://panel/${encodeURIComponent(id)}?v=${Date.now()}`;
  });
  ipcMain.on('hit:rects', (_e, rects: number[][]) => (hit.rects = rects));
  ipcMain.on('hit:lock', (_e, locked: boolean) => (hit.locked = locked));
  ipcMain.on('win:focus', () => focusOverlay());
  ipcMain.handle('clipboard:read', () => clipboard.readText());
  ipcMain.on('win:hide', () => win?.hide());
  ipcMain.on('app:quit', () => app.quit());
}

app.whenReady().then(() => {
  session.defaultSession.setPermissionRequestHandler((_wc, permission, cb) => cb(permission === 'media'));
  session.defaultSession.setPermissionCheckHandler((_wc, permission) => permission === 'media');

  const faceModels = path.join(app.getAppPath(), 'node_modules', '@vladmandic', 'face-api', 'model');
  protocol.handle('models', async (req) => {
    const name = path.basename(decodeURIComponent(new URL(req.url).pathname)); // no traversal
    try {
      const body = await fs.promises.readFile(path.join(faceModels, name));
      const type = name.endsWith('.json') ? 'application/json' : 'application/octet-stream';
      return new Response(body, { headers: { 'content-type': type, 'access-control-allow-origin': '*' } });
    } catch {
      return new Response('not found', { status: 404 });
    }
  });

  // Big ML downloads go next to the app (drive with room), not the roaming profile.
  setVoiceCacheDir(path.join(app.getAppPath(), '.cache', 'models'));

  protocol.handle('visual', (req) => {
    const id = decodeURIComponent(new URL(req.url).pathname.replace(/^\//, ''));
    const body = visuals.get(id) ?? '<p style="color:#0ff">Visual expired</p>';
    return new Response(body, {
      headers: {
        'content-type': 'text/html; charset=utf-8',
        'content-security-policy':
          "default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval' https://cdnjs.cloudflare.com https://cdn.jsdelivr.net https://unpkg.com; style-src 'unsafe-inline' https://fonts.googleapis.com https://cdnjs.cloudflare.com https://cdn.jsdelivr.net; font-src https://fonts.gstatic.com data:; img-src * data: blob:; connect-src https:",
      },
    });
  });

  hotkeys.mic = bindFirst(['Control+Alt+Space', 'Control+Shift+Space', 'Alt+Shift+J'], () => hotkey('toggle-mic'));
  hotkeys.hud = bindFirst(['Control+Alt+J', 'Alt+Shift+H'], toggleHud);
  hotkeys.vision = bindFirst(['Control+Alt+V', 'Alt+Shift+V'], () => hotkey('toggle-vision'));

  // Hidden menu (frameless window) that guarantees the standard edit shortcuts in every input.
  Menu.setApplicationMenu(Menu.buildFromTemplate([{ role: 'editMenu' }]));

  registerIpc();
  createWindow();
  startHitPolling();
  createTray();
  warmAppIndex();
  setTimeout(() => uia.warm(), 1500);
  installCaptureGuard();

  if (process.env.JARVIS_SELFTEST && win) import('./selftest').then((m) => m.selfTest(win!, ctx));
});

app.on('second-instance', () => showOverlay());
app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  uia.stop();
});
app.on('window-all-closed', () => app.quit());
