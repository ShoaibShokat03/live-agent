import { app, type BrowserWindow } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { execute, manifest, type ToolContext } from './tools/registry';

/**
 * `npm run selftest` — runs the non-destructive tools for real, snapshots the HUD,
 * reports renderer console errors, then exits. Verifies native bindings on this machine.
 */
export async function selfTest(win: BrowserWindow, ctx: ToolContext) {
  const out = process.env.JARVIS_SELFTEST_OUT || app.getPath('temp');
  const errors: string[] = [];
  win.webContents.on('console-message', (e) => {
    if (e.level === 'error' || e.level === 'warning') errors.push(`[renderer ${e.level}] ${e.message}`);
  });
  if (win.webContents.isLoading()) await new Promise<void>((r) => win.webContents.once('did-finish-load', () => r()));

  const cases: [string, unknown][] = [
    ['get_datetime', {}],
    ['get_system_info', {}],
    ['list_windows', {}],
    ['list_directory', { path: 'home', limit: 5 }],
    ['look_at_screen', {}],
    ['recall', {}],
    ['web_fetch', { url: 'https://example.com', max_chars: 200 }],
    ['press_keys', { keys: 'notakey+x' }], // must fail validation without pressing anything
    ['mouse_click', { x: 'abc', y: 5 }], // must fail schema validation
  ];
  console.log(`\n== ${manifest().length} main-process tools registered ==`);
  let failed = 0;
  for (const [name, args] of cases) {
    const r = await execute(name, args, ctx);
    const expectFail = name === 'press_keys' || name === 'mouse_click';
    const pass = expectFail ? !r.ok : r.ok;
    if (!pass) failed++;
    const summary = r.ok ? JSON.stringify(r.result).slice(0, 160) : r.error;
    console.log(`${pass ? 'PASS' : 'FAIL'}  ${name.padEnd(16)} ${String(r.ms).padStart(5)}ms  ${r.image ? `[image ${Math.round(r.image.data.length / 1024)}KB] ` : ''}${summary}`);
  }

  await win.webContents.executeJavaScript('window.__hudDemo && window.__hudDemo()');
  await new Promise((r) => setTimeout(r, 3000)); // let HUD animations settle
  const img = await win.webContents.capturePage();
  const file = path.join(out, 'hud-snapshot.png');
  fs.writeFileSync(file, img.toPNG());
  console.log(`HUD snapshot: ${file}`);
  console.log(errors.length ? errors.join('\n') : 'Renderer: no console errors');
  console.log(`== ${failed ? `${failed} FAILED` : 'ALL PASSED'} ==\n`);
  app.exit(failed ? 1 : 0);
}
