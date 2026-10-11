import { app, BrowserWindow, globalShortcut, ipcMain, Menu, nativeImage, protocol, screen, session, Tray } from 'electron';
import path from 'node:path';
import type { AppConfig, HotkeyAction } from '../shared/types';
import { getConfig, hideFromCapture, setConfig } from './config';
import { sampleStats } from './stats';
import { fileTools } from './tools/files';
import { inputTools } from './tools/input';
import { memoryTools } from './tools/memory';
import { execute, manifest, register, type ToolContext } from './tools/registry';
import { captureFrame, screenTools } from './tools/screen';
import { systemTools } from './tools/system';
import { warmAppIndex, windowTools } from './tools/windows';
import { webTools } from './tools/web';

// Sandboxed origin for AI-generated interactive visuals (HTML/JS panels). Isolated from the HUD.
protocol.registerSchemesAsPrivileged([{ scheme: 'visual', privileges: { standard: true, secure: true, supportFetchAPI: true } }]);
const visuals = new Map<string, string>();

app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

if (!app.requestSingleInstanceLock()) app.quit();

register([...inputTools, ...windowTools, ...screenTools, ...systemTools, ...fileTools, ...webTools, ...memoryTools]);

let win: BrowserWindow | null = null;
let tray: Tray | null = null;

const ctx: ToolContext = {
  win: () => win,
  emit: (channel, payload) => win?.webContents.send(channel, payload),
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
  win.setIgnoreMouseEvents(true, { forward: true });
  if (hideFromCapture()) win.setContentProtection(true);
  win.loadFile(path.join(__dirname, '../renderer/index.html'));
  win.once('ready-to-show', () => {
    win?.showInactive();
    // Windows clamps new windows to the work area; re-apply so the overlay also covers the taskbar
    // and the HUD's 0-1000 grid matches the screen grid exactly.
    win?.setBounds(screen.getPrimaryDisplay().bounds);
  });
  win.on('closed', () => (win = null));

  // Keep the overlay glued to the primary display if resolution / scaling changes.
  screen.on('display-metrics-changed', () => win?.setBounds(screen.getPrimaryDisplay().bounds));
}

function toggleHud() {
  if (!win) return;
  win.isVisible() ? win.hide() : win.showInactive();
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
  if (a !== 'toggle-hud' && win && !win.isVisible()) win.showInactive();
  win?.webContents.send('hotkey', a);
};

function registerIpc() {
  ipcMain.handle('config:get', () => getConfig());
  ipcMain.handle('config:set', (_e, patch: Partial<AppConfig>) => setConfig(patch));
  ipcMain.handle('app:hotkeys', () => hotkeys);
  ipcMain.handle('tools:manifest', () => manifest());
  ipcMain.handle('tools:exec', (_e, name: string, args: unknown) => execute(name, args, ctx));
  ipcMain.handle('stats:get', () => sampleStats());
  ipcMain.handle('screen:frame', () => captureFrame(1024, 60));
  ipcMain.handle('visual:put', (_e, id: string, html: string) => {
    visuals.set(id, html);
    return `visual://panel/${encodeURIComponent(id)}?v=${Date.now()}`;
  });
  ipcMain.on('win:ignore', (_e, ignore: boolean) => win?.setIgnoreMouseEvents(ignore, { forward: true }));
  ipcMain.on('win:hide', () => win?.hide());
  ipcMain.on('app:quit', () => app.quit());
}

app.whenReady().then(() => {
  session.defaultSession.setPermissionRequestHandler((_wc, permission, cb) => cb(permission === 'media'));
  session.defaultSession.setPermissionCheckHandler((_wc, permission) => permission === 'media');

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

  registerIpc();
  createWindow();
  createTray();
  warmAppIndex();

  if (process.env.JARVIS_SELFTEST && win) import('./selftest').then((m) => m.selfTest(win!, ctx));
});

app.on('second-instance', () => win?.showInactive());
app.on('will-quit', () => globalShortcut.unregisterAll());
app.on('window-all-closed', () => app.quit());
