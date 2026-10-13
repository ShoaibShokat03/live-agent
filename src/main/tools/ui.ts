import { toNormalized, toPhysical } from '../coords';
import { annotate, type Mark } from '../marks';
import { chord, click, glide, isWindows, sleep, w32, type Button } from '../native/win32';
import { actOn, scanWindow, type UiaElement } from '../native/uia';
import { captureScreen, locate } from '../vision';
import { appWindows, ensureAppForeground, findWindows } from './windows';
import { obj, type ToolContext, type ToolDef } from './registry';
import { clipboard } from 'electron';
import type { JSONSchema } from '../../shared/types';

// ---------- last scan (ids the model sees → live UIA elements) ----------
interface Scanned { id: number; el: UiaElement; window: string }
let lastScan = new Map<number, Scanned>();

function resolveTarget(target: string) {
  const t = target.trim().toLowerCase();
  if (t === 'taskbar') return { hwnd: Number(w32().FindWindowW('Shell_TrayWnd', null)), title: 'Taskbar' };
  if (t === 'desktop') return { hwnd: Number(w32().FindWindowW('Progman', null)), title: 'Desktop' };
  if (t === 'foreground' || t === 'active' || !t) {
    const fg = Number(w32().GetForegroundWindow());
    const pid = [0];
    w32().GetWindowThreadProcessId(fg, pid);
    if (fg && pid[0] !== process.pid) {
      const info = appWindows().find((w) => w.hwnd === fg);
      return { hwnd: fg, title: info?.title ?? 'Active window' };
    }
    const top = appWindows().find((w) => !w.minimized); // EnumWindows runs in z-order
    if (!top) throw new Error('No application window is open');
    return { hwnd: top.hwnd, title: top.title };
  }
  const w = findWindows(target)[0];
  if (!w) throw new Error(`No open window matches "${target}"`);
  return { hwnd: w.hwnd, title: w.title };
}

const center = (e: UiaElement) => ({ x: e.x + e.w / 2, y: e.y + e.h / 2 });

/** Glide + click at a physical point with the HUD click-through, plus a visual ripple. */
async function clickPhysical(ctx: ToolContext, px: number, py: number, button: Button, clicks: number) {
  const n = toNormalized(px, py);
  await ctx.passthrough(async () => {
    await glide(px, py);
    ctx.emit('fx', { type: 'click', x: n.x, y: n.y, button });
    await click(button, clicks);
  });
  return n;
}

const ACTION: JSONSchema = { type: 'string', enum: ['click', 'double_click', 'right_click', 'hover', 'locate'], default: 'click' };
const toButton = (a: string): [Button, number] => (a === 'right_click' ? ['right', 1] : a === 'double_click' ? ['left', 2] : ['left', 1]);

export const uiTools: ToolDef[] = [
  {
    name: 'scan_ui',
    description:
      'MOST ACCURATE way to operate apps. Reads every button, field, link, menu, tab and list item of a window via Windows UI Automation, ' +
      'and sends you a screenshot with NUMBERED boxes on them. Then use click_element / set_element_text with those numbers. ' +
      'Works for desktop apps, File Explorer, Settings, the taskbar and the browser toolbar/tabs. Web page content may not be listed — use locate_on_screen for that.',
    parameters: obj({
      target: { type: 'string', description: '"foreground" (default), "taskbar", "desktop", or a window title/app name', default: 'foreground' },
      query: { type: 'string', description: 'Only list elements whose name contains this text' },
      include_text: { type: 'boolean', default: false, description: 'Also include static text labels and images' },
      max: { type: 'integer', default: 150, minimum: 10, maximum: 400 },
    }),
    timeoutMs: 30000,
    async run({ target, query, include_text, max }, ctx) {
      if (!isWindows) throw new Error('UI Automation is Windows-only');
      const t = resolveTarget(target);
      let els = await scanWindow(t.hwnd, 600, include_text);
      if (query) {
        const q = query.toLowerCase();
        els = els.filter((e) => e.n.toLowerCase().includes(q));
      }
      const shot = await captureScreen(1600);
      const onScreen = (e: UiaElement) => e.x + e.w > shot.origin.x && e.y + e.h > shot.origin.y && e.x < shot.origin.x + shot.physW && e.y < shot.origin.y + shot.physH;
      els = els.filter(onScreen).sort((a, b) => a.y - b.y || a.x - b.x).slice(0, max);

      lastScan = new Map();
      const marks: Mark[] = [];
      const lines: string[] = [];
      els.forEach((el, k) => {
        const id = k + 1;
        lastScan.set(id, { id, el, window: t.title });
        marks.push({ id, x: (el.x - shot.origin.x) * shot.scale, y: (el.y - shot.origin.y) * shot.scale, w: el.w * shot.scale, h: el.h * shot.scale });
        const c = toNormalized(center(el).x, center(el).y);
        lines.push(`${id} ${el.t}${el.n ? ` "${el.n}"` : ''} @${c.x},${c.y}${el.en ? '' : ' (disabled)'}${el.f ? ' (focused)' : ''}`);
      });
      const img = annotate(shot.image, marks);
      ctx.emit('fx', {
        type: 'scan',
        boxes: els.slice(0, 200).map((e) => {
          const a = toNormalized(e.x, e.y), b = toNormalized(e.x + e.w, e.y + e.h);
          return { x: a.x, y: a.y, width: b.x - a.x, height: b.y - a.y };
        }),
      });
      return {
        __image: { data: img.toJPEG(85).toString('base64'), mimeType: 'image/jpeg' },
        window: t.title,
        count: els.length,
        elements: lines.join('\n') || '(no accessible elements found — use locate_on_screen)',
        note: 'Numbered screenshot sent. Use click_element {id} / set_element_text {id}.',
      };
    },
  },
  {
    name: 'click_element',
    description: 'Click an element by its number from the latest scan_ui. Precise: uses the element\'s exact live position.',
    parameters: obj(
      {
        id: { type: 'integer', minimum: 1 },
        action: { type: 'string', enum: ['click', 'double_click', 'right_click', 'hover', 'invoke'], default: 'click', description: 'invoke = press it via accessibility without moving the mouse' },
      },
      ['id'],
    ),
    async run({ id, action }, ctx) {
      const s = lastScan.get(id);
      if (!s) throw new Error(`No element #${id} in the last scan — call scan_ui again`);
      if (action === 'invoke') {
        const r = await actOn(s.el.i, 'invoke');
        if (r?.done) return { invoked: s.el.n || s.el.t, via: r.via };
        action = 'click'; // element has no invoke pattern: fall back to a real click
      }
      // Use the live rect: the window may have moved/scrolled since the scan.
      let rect = s.el;
      try {
        const live = await actOn(s.el.i, 'rect', '');
        if (live && live.w > 0 && !live.off) rect = { ...s.el, ...live };
      } catch {}
      const c = center(rect);
      if (action === 'hover') {
        await ctx.passthrough(() => glide(c.x, c.y));
        return { hovered: s.el.n || s.el.t };
      }
      const [button, clicks] = toButton(action);
      const n = await clickPhysical(ctx, c.x, c.y, button, clicks);
      return { clicked: s.el.n || s.el.t, type: s.el.t, at: n, action };
    },
  },
  {
    name: 'set_element_text',
    description: 'Put text into an input field by its scan_ui number (replaces the existing text). submit=true presses Enter afterwards.',
    parameters: obj(
      { id: { type: 'integer', minimum: 1 }, text: { type: 'string' }, submit: { type: 'boolean', default: false } },
      ['id', 'text'],
    ),
    async run({ id, text, submit }, ctx) {
      const s = lastScan.get(id);
      if (!s) throw new Error(`No element #${id} in the last scan — call scan_ui again`);
      let via = 'ValuePattern';
      const r = await actOn(s.el.i, 'set_text', text).catch(() => null);
      if (!r?.done) {
        // Fallback: click into the field, select all, paste (Unicode-safe).
        via = 'click+paste';
        const c = center(s.el);
        await clickPhysical(ctx, c.x, c.y, 'left', 1);
        await sleep(80);
        const saved = await clipboard.readText().catch(() => '');
        await clipboard.writeText(text);
        await chord('ctrl+a');
        await chord('ctrl+v');
        await sleep(80);
        setTimeout(() => clipboard.writeText(saved).catch(() => {}), 300);
      }
      if (submit) {
        await ensureAppForeground();
        await chord('enter');
      }
      return { field: s.el.n || s.el.t, via, submitted: submit };
    },
  },
  {
    name: 'locate_on_screen',
    description:
      'Find ANY visible target precisely by description using Gemini vision grounding (e.g. "the blue Sign in button", "search box at top of the YouTube page", "first video thumbnail"), ' +
      'then optionally click it. Best choice for web page content and custom-drawn UIs. Returns the exact box on the 0-1000 grid.',
    parameters: obj(
      {
        description: { type: 'string', description: 'What to find — be specific (text on it, color, position, nearby labels)' },
        action: ACTION,
      },
      ['description'],
    ),
    timeoutMs: 40000,
    async run({ description, action }, ctx) {
      const r = await locate(description);
      if (!r.found || !r.box || !r.center) return { found: false, reason: r.reason };
      ctx.emit('fx', { type: 'target', box: r.box, label: r.label || description });
      if (action === 'locate') return { found: true, box: r.box, center: r.center, label: r.label };
      const p = toPhysical(r.center.x, r.center.y);
      if (action === 'hover') {
        await ctx.passthrough(() => glide(p.x, p.y));
        return { found: true, hovered: r.label || description, center: r.center };
      }
      const [button, clicks] = toButton(action);
      await clickPhysical(ctx, p.x, p.y, button, clicks);
      return { found: true, clicked: r.label || description, center: r.center, box: r.box, action };
    },
  },
  {
    name: 'wait',
    description: 'Pause for a moment (e.g. for a page or app to finish loading) before the next step.',
    parameters: obj({ seconds: { type: 'number', minimum: 0.1, maximum: 30, default: 1 } }),
    timeoutMs: 31000,
    async run({ seconds }) {
      await sleep(seconds * 1000);
      return { waited: seconds };
    },
  },
];
