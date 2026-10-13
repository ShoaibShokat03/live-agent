import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import { shell } from 'electron';
import { sizeToPhysical, toNormalized, toPhysical } from '../coords';
import { focusWindow, isWindows, listWindows, sleep, SW, w32, type WinInfo } from '../native/win32';
import { obj, type ToolDef } from './registry';
import { resolvePath } from './files';

// ---------- Start-menu app index (Win32 + Store apps), built once in the background ----------
interface StartApp { name: string; id: string }
let appIndex: Promise<StartApp[]> | null = null;

export function warmAppIndex() {
  if (!isWindows || appIndex) return;
  appIndex = new Promise((resolve) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', 'Get-StartApps | Select-Object Name,AppID | ConvertTo-Json -Compress'],
      { windowsHide: true, maxBuffer: 16 * 1024 * 1024 },
      (err, stdout) => {
        if (err) return resolve([]);
        try {
          const raw = JSON.parse(stdout);
          resolve((Array.isArray(raw) ? raw : [raw]).map((a: any) => ({ name: a.Name, id: a.AppID })));
        } catch {
          resolve([]);
        }
      },
    );
  });
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();

function score(query: string, candidate: string): number {
  const q = norm(query), c = norm(candidate);
  if (!q || !c) return 0;
  if (c === q) return 100;
  if (c.startsWith(q)) return 80;
  if (c.split(' ').some((w) => w.startsWith(q))) return 70;
  if (c.includes(q)) return 60;
  const qt = q.split(' ');
  const hits = qt.filter((t) => c.includes(t)).length;
  return hits ? (hits / qt.length) * 50 : 0;
}

const ALIASES: Record<string, string> = {
  settings: 'ms-settings:', 'windows settings': 'ms-settings:', 'task manager': 'taskmgr',
  terminal: 'wt', 'command prompt': 'cmd', cmd: 'cmd', powershell: 'powershell', explorer: 'explorer',
  'file explorer': 'explorer', files: 'explorer', notepad: 'notepad', calculator: 'calc', paint: 'mspaint',
  'control panel': 'control', 'snipping tool': 'snippingtool',
};

function startDetached(cmd: string, args: string[]) {
  const p = spawn(cmd, args, { detached: true, stdio: 'ignore', windowsHide: false });
  p.on('error', () => {});
  p.unref();
}

// ---------- Window matching ----------
/** User app windows, excluding the JARVIS overlay itself. */
export const appWindows = () => listWindows().filter((w) => w.pid !== process.pid);

export function findWindows(target: string): WinInfo[] {
  const all = appWindows();
  const ranked = all
    .map((w) => ({ w, s: Math.max(score(target, w.title), score(target, w.process.replace(/\.exe$/i, ''))) }))
    .filter((r) => r.s >= 50)
    .sort((a, b) => b.s - a.s || Number(b.w.focused) - Number(a.w.focused));
  return ranked.map((r) => r.w);
}

const describe = (w: WinInfo) => {
  const tl = toNormalized(w.rect.x, w.rect.y);
  const br = toNormalized(w.rect.x + w.rect.w, w.rect.y + w.rect.h);
  return {
    id: w.hwnd, title: w.title, process: w.process, focused: w.focused,
    state: w.minimized ? 'minimized' : w.maximized ? 'maximized' : 'normal',
    box: { x: tl.x, y: tl.y, width: br.x - tl.x, height: br.y - tl.y },
  };
};

export const windowTools: ToolDef[] = [
  {
    name: 'open_app',
    description:
      'Launch an application by name (e.g. "chrome", "spotify", "vs code", "calculator", "settings"), or open a file/folder path with its default app.',
    parameters: obj({ name: { type: 'string', description: 'App name or a file/folder path' } }, ['name']),
    timeoutMs: 15000,
    async run({ name }) {
      const asPath = resolvePath(name);
      if (/[\\/:]/.test(name) && fs.existsSync(asPath)) {
        const err = await shell.openPath(asPath);
        if (err) throw new Error(err);
        return { opened: asPath };
      }
      const alias = ALIASES[norm(name)];
      if (alias) {
        if (alias.endsWith(':')) await shell.openExternal(alias);
        else startDetached('cmd.exe', ['/c', 'start', '""', alias]);
        return { launched: name };
      }
      warmAppIndex();
      const apps = (await appIndex) ?? [];
      const best = apps
        .map((a) => ({ a, s: score(name, a.name) }))
        .filter((r) => r.s >= 50)
        .sort((x, y) => y.s - x.s)[0];
      if (best) {
        startDetached('explorer.exe', [`shell:AppsFolder\\${best.a.id}`]);
        return { launched: best.a.name };
      }
      startDetached('cmd.exe', ['/c', 'start', '""', name]);
      return { launched: name, note: 'Not found in Start menu; attempted direct launch' };
    },
  },
  {
    name: 'open_url',
    description: 'Open a website in the default browser. For a web search, pass a Google search URL.',
    parameters: obj({ url: { type: 'string' } }, ['url']),
    async run({ url }) {
      const u = /^[a-z][a-z0-9+.-]*:/i.test(url) ? url : `https://${url}`;
      if (!/^(https?|mailto|ms-[a-z-]+|spotify|steam|zoommtg):/i.test(u)) throw new Error('Unsupported URL scheme');
      await shell.openExternal(u);
      return { opened: u };
    },
  },
  {
    name: 'list_windows',
    description: 'List open application windows with title, process, state and on-screen box (0-1000 grid).',
    parameters: obj({}),
    run: () => appWindows().map(describe),
  },
  {
    name: 'window_control',
    description:
      'Control an app window found by title or process name: focus, minimize, maximize, restore, close, or move/resize (x,y,width,height on the 0-1000 grid).',
    parameters: obj(
      {
        target: { type: 'string', description: 'Window title or app name, e.g. "chrome", "notepad"' },
        action: { type: 'string', enum: ['focus', 'minimize', 'maximize', 'restore', 'close', 'move'] },
        x: { type: 'number', minimum: 0, maximum: 1000 },
        y: { type: 'number', minimum: 0, maximum: 1000 },
        width: { type: 'number', minimum: 50, maximum: 1000 },
        height: { type: 'number', minimum: 50, maximum: 1000 },
        all: { type: 'boolean', default: false, description: 'Apply to every matching window' },
      },
      ['target', 'action'],
    ),
    async run({ target, action, x, y, width, height, all }) {
      const matches = findWindows(target);
      if (!matches.length) throw new Error(`No open window matches "${target}"`);
      const a = w32();
      const list = all ? matches : [matches[0]];
      for (const w of list) {
        switch (action) {
          case 'focus': focusWindow(w.hwnd); break;
          case 'minimize': a.ShowWindow(w.hwnd, SW.minimize); break;
          case 'maximize': a.ShowWindow(w.hwnd, SW.maximize); break;
          case 'restore': a.ShowWindow(w.hwnd, SW.restore); break;
          case 'close': a.PostMessageW(w.hwnd, 0x0010, 0, 0); break; // WM_CLOSE
          case 'move': {
            if (w.minimized || w.maximized) a.ShowWindow(w.hwnd, SW.restore);
            const cur = describe(w).box;
            const p = toPhysical(x ?? cur.x, y ?? cur.y);
            const s = sizeToPhysical(width ?? cur.width, height ?? cur.height);
            a.MoveWindow(w.hwnd, p.x, p.y, s.w, s.h, true);
            break;
          }
        }
      }
      return { action, windows: list.map((w) => w.title) };
    },
  },
  {
    name: 'close_app',
    description: 'Close an application gracefully (like clicking X). force=true kills the process immediately (unsaved work is lost).',
    parameters: obj(
      { name: { type: 'string' }, force: { type: 'boolean', default: false } },
      ['name'],
    ),
    async run({ name, force }) {
      const matches = findWindows(name);
      if (!matches.length) throw new Error(`No open window matches "${name}"`);
      const procName = matches[0].process;
      const targets = matches.filter((w) => w.process === procName);
      if (force) {
        const pids = [...new Set(targets.map((w) => w.pid))];
        await new Promise<void>((res, rej) =>
          execFile('taskkill.exe', ['/F', '/T', ...pids.flatMap((p) => ['/PID', String(p)])], { windowsHide: true }, (e) =>
            e ? rej(e) : res(),
          ),
        );
      } else {
        for (const w of targets) w32().PostMessageW(w.hwnd, 0x0010, 0, 0);
        await sleep(300);
      }
      return { closed: procName, windows: targets.length, force };
    },
  },
];

/**
 * If JARVIS's own HUD holds the keyboard (e.g. the user just typed in it), hand the foreground
 * back to the topmost app window so the AI's typing and shortcuts land where the user expects.
 */
export async function ensureAppForeground() {
  if (!isWindows) return;
  const pid = [0];
  w32().GetWindowThreadProcessId(Number(w32().GetForegroundWindow()), pid);
  if (pid[0] !== process.pid) return;
  const top = appWindows().find((w) => !w.minimized);
  if (top) {
    focusWindow(top.hwnd);
    await sleep(80);
  }
}
