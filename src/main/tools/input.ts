import { clipboard } from 'electron';
import { toPhysical } from '../coords';
import { chord, click, glide, keyDown, keyUp, mouseDown, mouseUp, sleep, vk, wheel, type Button } from '../native/win32';
import { obj, type ToolDef } from './registry';

const X = { type: 'number', minimum: 0, maximum: 1000, description: 'X on the 0-1000 normalized screen grid' } as const;
const Y = { type: 'number', minimum: 0, maximum: 1000, description: 'Y on the 0-1000 normalized screen grid' } as const;

async function moveTo(x: number, y: number) {
  const p = toPhysical(x, y);
  await glide(p.x, p.y);
}

export const inputTools: ToolDef[] = [
  {
    name: 'mouse_move',
    description: 'Move the mouse cursor to a point on screen.',
    parameters: obj({ x: X, y: Y }, ['x', 'y']),
    async run({ x, y }, ctx) {
      await moveTo(x, y);
      ctx.emit('fx', { type: 'move', x, y });
      return { moved: { x, y } };
    },
  },
  {
    name: 'mouse_click',
    description:
      'Click at a point on screen. Call look_at_screen first to find the exact target coordinates. Use clicks=2 for double-click.',
    parameters: obj(
      {
        x: X,
        y: Y,
        button: { type: 'string', enum: ['left', 'right', 'middle'], default: 'left' },
        clicks: { type: 'integer', minimum: 1, maximum: 3, default: 1 },
      },
      ['x', 'y'],
    ),
    async run({ x, y, button, clicks }, ctx) {
      await moveTo(x, y);
      ctx.emit('fx', { type: 'click', x, y, button });
      await click(button as Button, clicks);
      return { clicked: { x, y, button, clicks } };
    },
  },
  {
    name: 'mouse_drag',
    description: 'Press and drag from one screen point to another (move files, select text, resize, sliders).',
    parameters: obj({ from_x: X, from_y: Y, to_x: X, to_y: Y }, ['from_x', 'from_y', 'to_x', 'to_y']),
    async run({ from_x, from_y, to_x, to_y }, ctx) {
      await moveTo(from_x, from_y);
      mouseDown('left');
      await sleep(60);
      const p = toPhysical(to_x, to_y);
      await glide(p.x, p.y, 300);
      await sleep(60);
      mouseUp('left');
      ctx.emit('fx', { type: 'click', x: to_x, y: to_y, button: 'left' });
      return 'dragged';
    },
  },
  {
    name: 'mouse_scroll',
    description: 'Scroll the mouse wheel, optionally at a screen point. Positive amount = scroll down / right.',
    parameters: obj({
      amount: { type: 'number', description: 'Notches to scroll (e.g. 5)', default: 5 },
      direction: { type: 'string', enum: ['vertical', 'horizontal'], default: 'vertical' },
      x: X,
      y: Y,
    }),
    async run({ amount, direction, x, y }) {
      if (x !== undefined && y !== undefined) await moveTo(x, y);
      // Windows wheel: positive = up; we expose positive = down for natural language.
      wheel(direction === 'horizontal' ? amount : -amount, direction === 'horizontal');
      return 'scrolled';
    },
  },
  {
    name: 'type_text',
    description:
      'Type text into the currently focused field (any language, emoji, multi-line). Set press_enter to submit afterwards.',
    parameters: obj(
      { text: { type: 'string' }, press_enter: { type: 'boolean', default: false } },
      ['text'],
    ),
    async run({ text, press_enter }, ctx) {
      // Clipboard paste is instant and Unicode-safe; the user's clipboard is restored afterwards.
      const saved = await clipboard.readText().catch(() => '');
      await clipboard.writeText(text);
      await chord('ctrl+v');
      await sleep(80);
      if (press_enter) await chord('enter');
      setTimeout(() => clipboard.writeText(saved).catch(() => {}), 300);
      ctx.emit('fx', { type: 'type', text });
      return { typed: text.length };
    },
  },
  {
    name: 'press_keys',
    description:
      'Press a key or key combination, e.g. "enter", "ctrl+c", "alt+tab", "win+d", "ctrl+shift+esc", "f5". Use sequence for several presses in order.',
    parameters: obj({
      keys: { type: 'string', description: 'Single combo, keys joined by +' },
      sequence: { type: 'array', items: { type: 'string' }, description: 'Several combos pressed in order' },
      repeat: { type: 'integer', minimum: 1, maximum: 50, default: 1 },
    }),
    async run({ keys, sequence, repeat }) {
      const combos: string[] = sequence?.length ? sequence : keys ? [keys] : [];
      if (!combos.length) throw new Error('Provide keys or sequence');
      combos.forEach((c) => c.split('+').forEach((k) => vk(k))); // validate before pressing anything
      for (let r = 0; r < repeat; r++) for (const c of combos) {
        await chord(c);
        await sleep(30);
      }
      return { pressed: combos, repeat };
    },
  },
  {
    name: 'media_control',
    description: 'Control system media playback and volume.',
    parameters: obj(
      {
        action: { type: 'string', enum: ['play_pause', 'next', 'previous', 'stop', 'volume_up', 'volume_down', 'mute'] },
        steps: { type: 'integer', minimum: 1, maximum: 50, default: 5, description: 'For volume: each step is 2%' },
      },
      ['action'],
    ),
    async run({ action, steps }) {
      const map: Record<string, string> = {
        play_pause: 'mediaplaypause', next: 'medianext', previous: 'mediaprev', stop: 'mediastop',
        volume_up: 'volumeup', volume_down: 'volumedown', mute: 'volumemute',
      };
      const code = vk(map[action]);
      const n = action.startsWith('volume_') ? steps : 1;
      for (let i = 0; i < n; i++) {
        keyDown(code);
        keyUp(code);
        await sleep(10);
      }
      return { action, steps: n };
    },
  },
];
