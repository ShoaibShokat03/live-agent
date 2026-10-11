import type { JSONSchema, ToolManifest } from '../../shared/types';
import { closeAllPanels, closePanel, hasPanel, listPanels, movePanel, newId, openPanel, updatePanel, type PanelSpec } from '../hud/panels';
import { markRegion, pointAt, toast, type Level } from '../hud/overlays';
import { ACCENT_NAMES, accentColor } from '../hud/theme';

export interface HudControls {
  setMini(on: boolean): void;
  setLog(on: boolean): void;
  setTheme(color: string): void;
  setVision(on: boolean): void;
}

export interface UiTool extends ToolManifest {
  run(args: any): unknown | Promise<unknown>;
}

const N = (description: string): JSONSchema => ({ type: 'number', minimum: 0, maximum: 1000, description });
const BOX: Record<string, JSONSchema> = {
  x: N('Left edge, 0-1000 grid (omit to auto-place)'),
  y: N('Top edge, 0-1000 grid'),
  width: N('Width on the 0-1000 grid (e.g. 300 ≈ 30% of screen)'),
  height: N('Height on the 0-1000 grid'),
};
const ACCENT: JSONSchema = { type: 'string', enum: ACCENT_NAMES, description: 'Color (default gold)' };
const COMMON: Record<string, JSONSchema> = {
  id: { type: 'string', description: 'Reuse an id to replace/update that panel in place' },
  title: { type: 'string' },
  accent: ACCENT,
  ttl_seconds: { type: 'number', description: 'Auto-close after N seconds (omit to keep open)' },
  ...BOX,
};

const obj = (properties: Record<string, JSONSchema>, required: string[] = []): JSONSchema => ({ type: 'object', properties, required });

function show(kind: PanelSpec['kind'], a: any, extra: Partial<PanelSpec> = {}) {
  const id = a.id || newId(kind[0]);
  openPanel({ ...a, ...extra, id, kind, title: a.title || kind.toUpperCase() });
  return { panel_id: id };
}

export function uiTools(c: HudControls): UiTool[] {
  const t = (def: Omit<UiTool, 'location'>): UiTool => ({ ...def, location: 'renderer' });
  return [
    t({
      name: 'show_panel',
      description:
        'Open a holographic HUD panel with text, markdown, code, a list, a table, or an image. Use it for anything worth reading rather than hearing. Returns panel_id.',
      parameters: obj(
        {
          ...COMMON,
          kind: { type: 'string', enum: ['markdown', 'text', 'code', 'list', 'table', 'image'], default: 'markdown' },
          content: { type: 'string', description: 'Body for markdown/text/code' },
          items: { type: 'array', items: { type: 'string' }, description: 'For kind=list' },
          columns: { type: 'array', items: { type: 'string' }, description: 'For kind=table' },
          rows: { type: 'array', items: { type: 'array', items: { type: 'string' } }, description: 'For kind=table' },
          image_url: { type: 'string', description: 'For kind=image (https or data URL)' },
        },
        ['title'],
      ),
      run: (a) => show(a.kind ?? 'markdown', a),
    }),
    t({
      name: 'show_chart',
      description:
        'Render an animated, hoverable chart panel: line, area, bar, donut (share of total), gauge (single value vs max), radar (multi-axis comparison).',
      parameters: obj(
        {
          ...COMMON,
          type: { type: 'string', enum: ['line', 'area', 'bar', 'donut', 'gauge', 'radar'] },
          labels: { type: 'array', items: { type: 'string' }, description: 'X-axis labels / categories' },
          series: {
            type: 'array',
            items: obj({ name: { type: 'string' }, values: { type: 'array', items: { type: 'number' } } }, ['name', 'values']),
            description: 'One or more data series aligned with labels (gauge: one value)',
          },
          unit: { type: 'string', description: 'Suffix such as %, °C, $, ms' },
          max: { type: 'number', description: 'Scale max (gauge default 100)' },
        },
        ['title', 'type', 'labels', 'series'],
      ),
      run: (a) => show('chart', a, { chart: { type: a.type, labels: a.labels, series: a.series, unit: a.unit, max: a.max } }),
    }),
    t({
      name: 'show_stats',
      description: 'Show a grid of key metrics (KPI tiles) with optional progress bars and trend arrows.',
      parameters: obj(
        {
          ...COMMON,
          stats: {
            type: 'array',
            items: obj(
              {
                label: { type: 'string' },
                value: { type: 'string' },
                percent: { type: 'number', description: '0-100 bar fill' },
                trend: { type: 'string', enum: ['up', 'down', 'flat'] },
              },
              ['label', 'value'],
            ),
          },
        },
        ['title', 'stats'],
      ),
      run: (a) => show('stats', a),
    }),
    t({
      name: 'show_visual',
      description:
        'Render a fully custom INTERACTIVE visual from HTML/CSS/JS in a sandboxed panel: simulations, 3D, diagrams, animations, calculators, maps, mini-apps. Libraries may be loaded from https://cdnjs.cloudflare.com or https://cdn.jsdelivr.net (e.g. three.js, d3, chart.js). Background must stay transparent; use gold (#ffc23d) and red (#ff3b3b) neon styling on dark to match the HUD. Body HTML only is fine.',
      parameters: obj({ ...COMMON, html: { type: 'string' } }, ['title', 'html']),
      run: (a) => show('visual', a),
    }),
    t({
      name: 'show_system_monitor',
      description: 'Open the live system telemetry widget (CPU rings, per-core load, RAM, disk, uptime, battery) that updates every second.',
      parameters: obj(BOX),
      run: (a) => {
        if (!hasPanel('sysmon')) openPanel({ ...a, id: 'sysmon', kind: 'monitor', title: 'SYSTEM TELEMETRY' });
        else movePanel('sysmon', a);
        return { panel_id: 'sysmon' };
      },
    }),
    t({
      name: 'update_panel',
      description: 'Change an open panel in place: title, content, items, rows, stats, chart data, or accent color.',
      parameters: obj(
        {
          id: { type: 'string' },
          title: { type: 'string' },
          accent: ACCENT,
          content: { type: 'string' },
          items: { type: 'array', items: { type: 'string' } },
          rows: { type: 'array', items: { type: 'array', items: { type: 'string' } } },
          stats: { type: 'array', items: obj({ label: { type: 'string' }, value: { type: 'string' }, percent: { type: 'number' }, trend: { type: 'string' } }) },
          labels: { type: 'array', items: { type: 'string' } },
          series: { type: 'array', items: obj({ name: { type: 'string' }, values: { type: 'array', items: { type: 'number' } } }) },
          html: { type: 'string' },
        },
        ['id'],
      ),
      run: (a) => {
        const { id, labels, series, ...rest } = a;
        const patch: Partial<PanelSpec> = { ...rest };
        if (labels || series) patch.chart = { ...(labels && { labels }), ...(series && { series }) } as any;
        updatePanel(id, patch);
        return { updated: id };
      },
    }),
    t({
      name: 'move_panel',
      description: 'Move and/or resize an open panel with animation (0-1000 grid). Use list_panels to get ids.',
      parameters: obj({ id: { type: 'string' }, ...BOX }, ['id']),
      run: (a) => {
        const { id, ...box } = a;
        movePanel(id, box);
        return { moved: id };
      },
    }),
    t({
      name: 'close_panel',
      description: 'Close one HUD panel by id, or all panels with id="all".',
      parameters: obj({ id: { type: 'string' } }, ['id']),
      run: ({ id }) => (id === 'all' ? { closed: closeAllPanels() } : { closed: closePanel(id) ? 1 : 0 }),
    }),
    t({
      name: 'list_panels',
      description: 'List open HUD panels with ids and positions.',
      parameters: obj({}),
      run: () => listPanels(),
    }),
    t({
      name: 'notify',
      description: 'Pop a short toast notification on the HUD.',
      parameters: obj(
        {
          title: { type: 'string' },
          message: { type: 'string' },
          level: { type: 'string', enum: ['info', 'success', 'warning', 'error'], default: 'info' },
          seconds: { type: 'number', default: 5, minimum: 1, maximum: 60 },
        },
        ['title'],
      ),
      run: (a) => {
        toast(a.title, a.message, a.level as Level, a.seconds);
        return 'shown';
      },
    }),
    t({
      name: 'mark_screen',
      description: 'Draw a glowing targeting box around a region of the real screen (after look_at_screen) to show the user where something is.',
      parameters: obj(
        { ...BOX, label: { type: 'string' }, seconds: { type: 'number', default: 6 }, accent: ACCENT },
        ['x', 'y', 'width', 'height'],
      ),
      run: (a) => {
        markRegion(a, a.label, a.seconds, accentColor(a.accent));
        return 'marked';
      },
    }),
    t({
      name: 'point_at',
      description: 'Show an animated reticle pointing at a spot on the screen, with an optional label.',
      parameters: obj({ x: BOX.x, y: BOX.y, label: { type: 'string' }, seconds: { type: 'number', default: 5 } }, ['x', 'y']),
      run: (a) => {
        pointAt(a.x, a.y, a.label, a.seconds);
        return 'pointing';
      },
    }),
    t({
      name: 'hud_control',
      description:
        'Control the HUD itself: minimize to just the core, expand, show/hide the activity log, change the theme color, or turn continuous screen vision on/off.',
      parameters: obj(
        {
          action: { type: 'string', enum: ['minimize', 'expand', 'show_log', 'hide_log', 'theme', 'vision_on', 'vision_off'] },
          color: ACCENT,
        },
        ['action'],
      ),
      run: ({ action, color }) => {
        switch (action) {
          case 'minimize': c.setMini(true); break;
          case 'expand': c.setMini(false); break;
          case 'show_log': c.setLog(true); break;
          case 'hide_log': c.setLog(false); break;
          case 'theme': c.setTheme(color ?? 'gold'); break;
          case 'vision_on': c.setVision(true); break;
          case 'vision_off': c.setVision(false); break;
        }
        return { action };
      },
    }),
  ];
}
