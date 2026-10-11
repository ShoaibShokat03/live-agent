/** Minimal JSON-Schema subset used to declare tool parameters (converted to Gemini Schema at connect time). */
export interface JSONSchema {
  type?: 'object' | 'string' | 'number' | 'integer' | 'boolean' | 'array';
  description?: string;
  properties?: Record<string, JSONSchema>;
  required?: string[];
  items?: JSONSchema;
  enum?: string[];
  minimum?: number;
  maximum?: number;
  default?: unknown;
}

export type ToolLocation = 'main' | 'renderer';

/** What the model sees + how the dispatcher should run a tool. */
export interface ToolManifest {
  name: string;
  description: string;
  parameters: JSONSchema;
  /** Requires explicit user approval before running. */
  confirm?: boolean;
  timeoutMs?: number;
  location: ToolLocation;
}

export interface ToolImage {
  data: string; // base64
  mimeType: string;
}

export interface ToolResult {
  ok: boolean;
  result?: unknown;
  error?: string;
  ms: number;
  /** Image produced by the tool; streamed to the model as a vision frame. */
  image?: ToolImage;
}

export interface StatsSnapshot {
  cpu: number; // 0-100
  cores: number[];
  memUsed: number;
  memTotal: number;
  disk?: { used: number; total: number };
  uptime: number;
  procMem: number;
}

export interface AppConfig {
  apiKey: string;
  model: string;
  voice: string;
  userTitle: string;
  autoApprove: boolean;
  memories: { id: string; text: string; at: string }[];
}

export type FxEvent =
  | { type: 'click'; x: number; y: number; button: string }
  | { type: 'move'; x: number; y: number }
  | { type: 'type'; text: string };

export type AppEvent = { type: 'timer'; id: string; label: string };

export type HotkeyAction = 'toggle-mic' | 'toggle-hud' | 'toggle-vision';

/** API exposed by the preload script as `window.hud`. */
export interface HudBridge {
  getConfig(): Promise<AppConfig>;
  setConfig(patch: Partial<AppConfig>): Promise<AppConfig>;
  toolManifest(): Promise<ToolManifest[]>;
  /** Global shortcuts actually bound (fallbacks are used when a combo is taken). */
  hotkeys(): Promise<{ mic: string; hud: string; vision: string }>;
  execTool(name: string, args: unknown): Promise<ToolResult>;
  stats(): Promise<StatsSnapshot>;
  screenFrame(): Promise<ToolImage & { width: number; height: number }>;
  /** Stores AI-generated HTML in the main process and returns its sandboxed visual:// URL. */
  putVisual(id: string, html: string): Promise<string>;
  /** Window-local rects [x, y, w, h] of clickable HUD elements; everything else is click-through. */
  setHitRects(rects: number[][]): void;
  /** Force mouse capture (dragging, editing) regardless of rects. */
  setHitLock(locked: boolean): void;
  /** Make the overlay the real foreground window so it receives the keyboard. */
  focus(): void;
  readClipboard(): Promise<string>;
  hide(): void;
  quit(): void;
  onHotkey(cb: (a: HotkeyAction) => void): void;
  onFx(cb: (e: FxEvent) => void): void;
  onEvent(cb: (e: AppEvent) => void): void;
}
