import { app, clipboard, screen, type BrowserWindow } from 'electron';
import { chord, click, cursorPos, glide, setCursor, sleep, w32 } from './native/win32';
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

  // ---- Click accuracy: UI Automation ground truth vs Gemini visual grounding ----
  const scan = await execute('scan_ui', { target: 'taskbar', max: 60 }, ctx);
  const scanOk = scan.ok && (scan.result as any).count > 0;
  if (!scanOk) failed++;
  console.log(`${scanOk ? 'PASS' : 'FAIL'}  scan_ui taskbar   ${String(scan.ms).padStart(5)}ms  ${scan.ok ? `${(scan.result as any).count} elements` : scan.error}`);
  if (scan.image) fs.writeFileSync(path.join(out, 'scan-marks.jpg'), Buffer.from(scan.image.data, 'base64'));
  const fg = await execute('scan_ui', { target: 'foreground', max: 120 }, ctx);
  console.log(`${fg.ok ? 'PASS' : 'FAIL'}  scan_ui window    ${String(fg.ms).padStart(5)}ms  ${fg.ok ? `"${(fg.result as any).window}" ${(fg.result as any).count} elements` : fg.error}`);
  if (!fg.ok) failed++;
  if (fg.image) fs.writeFileSync(path.join(out, 'scan-window.jpg'), Buffer.from(fg.image.data, 'base64'));

  if (scanOk && !process.env.JARVIS_SKIP_GROUNDING) {
    // Ground-truth boxes for named taskbar buttons, then ask the vision model to find each by description.
    const { scanWindow } = await import('./native/uia');
    const { toNormalized } = await import('./coords');
    const { locate } = await import('./vision');
    const tb = await scanWindow(Number(w32().FindWindowW('Shell_TrayWnd', null)), 100);
    const named = tb.filter((e) => e.t === 'Button' && e.n && e.w > 10).slice(0, 4);
    let hits = 0;
    for (const e of named) {
      const a = toNormalized(e.x, e.y), b = toNormalized(e.x + e.w, e.y + e.h);
      const t0 = Date.now();
      try {
        const r = await locate(`the "${e.n}" button on the Windows taskbar`);
        const inside = !!r.center && r.center.x >= a.x - 3 && r.center.x <= b.x + 3 && r.center.y >= a.y - 3 && r.center.y <= b.y + 3;
        if (inside) hits++;
        console.log(`      locate "${e.n.slice(0, 30)}" → ${r.found ? `${r.center!.x},${r.center!.y}` : 'not found'}  truth [${a.x}-${b.x}, ${a.y}-${b.y}]  ${inside ? 'HIT' : 'MISS'}  ${Date.now() - t0}ms`);
      } catch (err: any) {
        console.log(`      locate "${e.n}" error: ${err.message}`);
      }
    }
    const ok = named.length > 0 && hits === named.length;
    if (!ok) failed++;
    console.log(`${ok ? 'PASS' : 'FAIL'}  grounding accuracy  ${hits}/${named.length} clicks inside the real button`);
  }

  // ---- Window control: mini mode restores via the orb; the overlay can't stay minimized ----
  {
    const mini = await win.webContents.executeJavaScript(
      `(async () => { document.querySelector('#btn-mini').click(); await new Promise(r => setTimeout(r, 100));
        const a = document.body.classList.contains('mini'); const exp = getComputedStyle(document.querySelector('#btn-expand')).display;
        document.querySelector('#orb').click(); await new Promise(r => setTimeout(r, 100));
        return { minimized: a, expandShown: exp !== 'none', restored: !document.body.classList.contains('mini') }; })()`,
    );
    win.minimize();
    await sleep(400);
    const ok = mini.minimized && mini.expandShown && mini.restored && !win.isMinimized() && win.isVisible();
    if (!ok) failed++;
    console.log(`${ok ? 'PASS' : 'FAIL'}  window control         mini=${mini.minimized} expandBtn=${mini.expandShown} orbRestores=${mini.restored} survivesMinimize=${!win.isMinimized()}`);
  }

  // ---- Face recognition models (renderer, WebGL) ----
  {
    const t0 = Date.now();
    const r = await win.webContents.executeJavaScript('window.__faceTest ? window.__faceTest() : Promise.resolve({ error: "no hook" })');
    const ok = !r.error && r.faces === 0;
    if (!ok) failed++;
    console.log(`${ok ? 'PASS' : 'FAIL'}  face models       ${String(Date.now() - t0).padStart(5)}ms  ${r.error ?? `backend=${r.backend}, faces on blank image=${r.faces}`}`);
  }

  // ---- Voiceprints inside Electron (onnxruntime-node) on Windows' built-in voices ----
  if (!process.env.JARVIS_SKIP_VOICE) {
    const { embedVoice, cosine, loadVoiceModel, VOICE_THRESHOLD } = await import('./voiceprint');
    const dir = path.join(app.getAppPath(), '.cache', 'selftest');
    fs.mkdirSync(dir, { recursive: true });
    const ps = `Add-Type -AssemblyName System.Speech; $f = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(16000, 'Sixteen', 'Mono'); $s = New-Object System.Speech.Synthesis.SpeechSynthesizer; $v = $s.GetInstalledVoices() | % { $_.VoiceInfo.Name } | Select -First 2; $t = @('Good morning, please check the weather and my calendar for today.', 'Open the project folder and play some relaxing music in the background.'); $i = 0; foreach ($n in $v) { $s.SelectVoice($n); $j = 0; foreach ($x in $t) { $s.SetOutputToWaveFile((Join-Path '${dir}' "v$i-$j.wav"), $f); $s.Speak($x); $s.SetOutputToNull(); $j++ }; $i++ }`;
    const { execFileSync } = await import('node:child_process');
    try {
      execFileSync('powershell.exe', ['-NoProfile', '-Command', ps], { windowsHide: true, timeout: 60000 });
      const wav = (f: string) => {
        const b = fs.readFileSync(path.join(dir, f));
        const at = b.indexOf('data') + 8;
        return new Int16Array(b.buffer.slice(b.byteOffset + at, b.byteOffset + b.length - ((b.length - at) % 2)));
      };
      const t0 = Date.now();
      await loadVoiceModel();
      const [a0, a1, b0, b1] = await Promise.all(['v0-0.wav', 'v0-1.wav', 'v1-0.wav', 'v1-1.wav'].map(async (f) => embedVoice(wav(f))));
      const same = [cosine(a0, a1), cosine(b0, b1)], diff = [cosine(a0, b0), cosine(a1, b1)];
      const ok = same.every((s) => s >= VOICE_THRESHOLD) && diff.every((d) => d < VOICE_THRESHOLD);
      if (!ok) failed++;
      console.log(`${ok ? 'PASS' : 'FAIL'}  voiceprints       ${String(Date.now() - t0).padStart(5)}ms  same-speaker ${same.map((x) => x.toFixed(2)).join('/')}  different ${diff.map((x) => x.toFixed(2)).join('/')}  (threshold ${VOICE_THRESHOLD})`);
    } catch (e: any) {
      failed++;
      console.log(`FAIL  voiceprints       ${e.message.split('\n')[0]}`);
    }
  }

  // ---- Encrypted people database round-trip ----
  {
    const { addFaces, faceDb, forgetPerson } = await import('./people');
    try {
      addFaces('__selftest__', [Array.from({ length: 128 }, (_, i) => i / 128)]);
      const stored = faceDb().find((p) => p.name === '__selftest__');
      const raw = fs.readFileSync(path.join(app.getPath('userData'), 'people.dat'), 'utf8');
      forgetPerson('__selftest__');
      const ok = !!stored && raw.startsWith('enc:');
      if (!ok) failed++;
      console.log(`${ok ? 'PASS' : 'FAIL'}  people database        ${raw.startsWith('enc:') ? 'encrypted at rest' : 'NOT encrypted'}`);
    } catch (e: any) {
      failed++;
      console.log(`FAIL  people database        ${e.message}`);
    }
  }

  // Real keyboard input into the API-key field, exactly as a user does it: focus the field
  // (the HUD then grabs the foreground), press OS-level Ctrl+V, then type a character.
  const probe = `AIzaTest${Date.now()}`;
  const savedClip = await clipboard.readText().catch(() => '');
  await clipboard.writeText(probe);
  const field = `(document.querySelector('.setup input') || document.querySelector('#cmd'))`;
  const r: { x: number; y: number } = await win.webContents.executeJavaScript(
    `(async () => { document.body.classList.add('typing'); const i = ${field}; i.value = ''; await new Promise((r) => setTimeout(r, 400)); const b = i.getBoundingClientRect(); return { x: b.left + b.width / 2, y: b.top + b.height / 2 }; })()`,
  );
  await sleep(200);
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

