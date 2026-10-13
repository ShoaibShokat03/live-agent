import type { FunctionCall, FunctionResponse } from '@google/genai';
import { validateArgs } from '../../shared/schema';
import type { ToolManifest, ToolResult } from '../../shared/types';
import { hud } from '../bridge';
import { confirmAction, logEnd, logStart } from '../hud/overlays';
import type { UiTool } from './ui-tools';

const MAX_RESULT_CHARS = 12000;

/** Keep tool outputs small: the model pays for every token and latency grows with size. */
function compact(value: unknown): unknown {
  const s = typeof value === 'string' ? value : JSON.stringify(value);
  if (s === undefined) return 'done';
  if (s.length <= MAX_RESULT_CHARS) return value;
  return `${s.slice(0, MAX_RESULT_CHARS)}… [truncated ${s.length - MAX_RESULT_CHARS} chars]`;
}

export interface DispatcherHooks {
  autoApprove: () => boolean;
  sendImage: (b64: string, mimeType: string) => void;
  onBusy: (busy: boolean) => void;
}

/**
 * Unified tool router. Every call — main-process (OS) or renderer (HUD) — goes through
 * the same pipeline: lookup → validate → confirm (if dangerous) → execute → log → respond.
 * Calls in one batch run in parallel.
 */
export class Dispatcher {
  private specs = new Map<string, ToolManifest>();
  private ui = new Map<string, UiTool>();
  private cancelled = new Set<string>();
  private inflight = 0;

  constructor(mainTools: ToolManifest[], uiTools: UiTool[], private hooks: DispatcherHooks) {
    for (const t of mainTools) this.specs.set(t.name, t);
    for (const t of uiTools) {
      this.specs.set(t.name, t);
      this.ui.set(t.name, t);
    }
  }

  get manifests(): ToolManifest[] {
    return [...this.specs.values()].map(({ name, description, parameters, confirm, timeoutMs, location }) => ({
      name, description, parameters, confirm, timeoutMs, location,
    }));
  }

  cancel(ids: string[]) {
    ids.forEach((id) => this.cancelled.add(id));
  }

  async handle(calls: FunctionCall[]): Promise<FunctionResponse[]> {
    this.inflight += calls.length;
    this.hooks.onBusy(true);
    try {
      const responses = await Promise.all(calls.map((c) => this.runOne(c)));
      return responses.filter((r) => !this.cancelled.has(r.id ?? ''));
    } finally {
      this.inflight -= calls.length;
      if (!this.inflight) this.hooks.onBusy(false);
    }
  }

  private async runOne(call: FunctionCall): Promise<FunctionResponse> {
    const id = call.id ?? crypto.randomUUID();
    const name = call.name ?? '';
    const args = call.args ?? {};
    logStart(id, name, args);
    const res = await this.exec(name, args);
    if (res.image) this.hooks.sendImage(res.image.data, res.image.mimeType);
    logEnd(id, res.ok, res.ms, res.error);
    return {
      id,
      name,
      response: res.ok ? { output: compact(res.result) } : { error: res.error },
    };
  }

  private async exec(name: string, args: Record<string, unknown>): Promise<ToolResult> {
    const spec = this.specs.get(name);
    if (!spec) return { ok: false, error: `Unknown tool "${name}"`, ms: 0 };

    if (spec.confirm && !this.hooks.autoApprove()) {
      const ok = await confirmAction(name.replace(/_/g, ' ').toUpperCase(), JSON.stringify(args, null, 2).slice(0, 1500));
      if (!ok) return { ok: false, error: 'The user denied permission for this action.', ms: 0 };
    }

    if (spec.location === 'main') return hud.execTool(name, args);

    const t0 = performance.now();
    const v = validateArgs(spec.parameters, args);
    if (!v.ok) return { ok: false, error: `Invalid arguments: ${v.errors.join('; ')}`, ms: 0 };
    try {
      const limit = spec.timeoutMs ?? 60000;
      let timer = 0;
      const result = await Promise.race([
        Promise.resolve(this.ui.get(name)!.run(v.value)),
        new Promise((_, rej) => (timer = window.setTimeout(() => rej(new Error(`Timed out after ${limit}ms`)), limit))),
      ]).finally(() => clearTimeout(timer));
      return { ok: true, result: result ?? 'done', ms: Math.round(performance.now() - t0) };
    } catch (e: any) {
      return { ok: false, error: e?.message ?? String(e), ms: Math.round(performance.now() - t0) };
    }
  }
}
