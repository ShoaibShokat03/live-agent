import { app, clipboard, screen, type BrowserWindow } from 'electron';
import { chord, click, cursorPos, glide, setCursor, sleep } from './native/win32';
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

  // Real keyboard input into the API-key field, exactly as a user does it: focus the field
  // (the HUD then grabs the foreground), press OS-level Ctrl+V, then type a character.
  const probe = `AIzaTest${Date.now()}`;
  const savedClip = await clipboard.readText().catch(() => '');
  await clipboard.writeText(probe);
  const field = `(document.querySelector('.setup input') || document.querySelector('#cmd'))`;
  const r: { x: number; y: number } = await win.webContents.executeJavaScript(
    `(() => { document.body.classList.add('typing'); const i = ${field}; i.value = ''; const b = i.getBoundingClientRect(); return { x: b.left + b.width / 2, y: b.top + b.height / 2 }; })()`,
  );
  await sleep(300);
  const home = cursorPos();
  const wb = win.getBounds();
  const p = screen.dipToScreenPoint({ x: wb.x + r.x, y: wb.y + r.y });
  await glide(p.x, p.y, 150); // real OS mouse click on the field, like a user
  await sleep(150);
  await click('left');
  await sleep(500);
  await chord('ctrl+v');
  await sleep(300);
  await chord('x');
  await sleep(300);
  const got: string = await win.webContents.executeJavaScript(`${field}.value`);
  await win.webContents.executeJavaScript(`${field}.blur(); 0`);
  await clipboard.writeText(savedClip).catch(() => {});
  setCursor(home.x, home.y);
  for (const [label, ok] of [['ctrl+v paste', got.startsWith(probe)], ['typing', got === probe + 'x']] as const) {
    if (!ok) failed++;
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${label.padEnd(22)} field got ${JSON.stringify(got)}`);
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
