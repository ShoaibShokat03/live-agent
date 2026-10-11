import type { BrowserWindow } from 'electron';
import { validateArgs } from '../../shared/schema';
import type { JSONSchema, ToolImage, ToolManifest, ToolResult } from '../../shared/types';

export interface ToolContext {
  win: () => BrowserWindow | null;
  /** Push an event to the HUD renderer. */
  emit: (channel: string, payload: unknown) => void;
}

export interface ToolDef<A = any> {
  name: string;
  description: string;
  parameters: JSONSchema;
  confirm?: boolean;
  timeoutMs?: number;
  run: (args: A, ctx: ToolContext) => unknown | Promise<unknown>;
}

const tools = new Map<string, ToolDef>();

export const obj = (properties: Record<string, JSONSchema>, required: string[] = []): JSONSchema => ({
  type: 'object',
  properties,
  required,
});

export function register(defs: ToolDef[]) {
  for (const d of defs) {
    if (tools.has(d.name)) throw new Error(`Duplicate tool: ${d.name}`);
    tools.set(d.name, d);
  }
}

export function manifest(): ToolManifest[] {
  return [...tools.values()].map((t) => ({
    name: t.name,
    description: t.description,
    parameters: t.parameters,
    confirm: t.confirm,
    timeoutMs: t.timeoutMs,
    location: 'main',
  }));
}

/**
 * Single entry point for every main-process tool: validate → run with timeout → normalize.
 * A tool may return `{ __image: {data, mimeType}, ...rest }` to hand an image to the model.
 */
export async function execute(name: string, rawArgs: unknown, ctx: ToolContext): Promise<ToolResult> {
  const t0 = performance.now();
  const ms = () => Math.round(performance.now() - t0);
  const def = tools.get(name);
  if (!def) return { ok: false, error: `Unknown tool "${name}"`, ms: 0 };

  const v = validateArgs(def.parameters, rawArgs ?? {});
  if (!v.ok) return { ok: false, error: `Invalid arguments: ${v.errors.join('; ')}`, ms: ms() };

  const limit = def.timeoutMs ?? 20000;
  let timer: NodeJS.Timeout | undefined;
  try {
    const timeout = new Promise<never>((_, rej) => {
      timer = setTimeout(() => rej(new Error(`Timed out after ${limit}ms`)), limit);
    });
    let out: any = await Promise.race([Promise.resolve(def.run(v.value, ctx)), timeout]);
    let image: ToolImage | undefined;
    if (out && typeof out === 'object' && '__image' in out) {
      const { __image, ...rest } = out;
      image = __image;
      out = rest;
    }
    return { ok: true, result: out ?? 'done', image, ms: ms() };
  } catch (e: any) {
    return { ok: false, error: e?.message ?? String(e), ms: ms() };
  } finally {
    clearTimeout(timer);
  }
}
