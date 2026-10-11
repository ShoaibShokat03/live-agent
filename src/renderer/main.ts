import type { AppConfig } from '../shared/types';
import { $, h, hud } from './bridge';
import { initHitTest } from './hud/hit';
import { hydrateIcons } from './hud/icons';
import { Orb, type OrbState } from './hud/orb';
import { rippleAt, subtitle, subtitleNewUserTurn, subtitleTurnEnd, toast, typingFx } from './hud/overlays';
import { closeAllPanels, initPanels } from './hud/panels';
import { accentColor } from './hud/theme';
import { Mic, Player } from './live/audio';
import { systemPrompt } from './live/prompt';
import { LiveClient, type LiveState } from './live/session';
import { Dispatcher } from './tools/dispatcher';
import { toDeclarations } from './tools/gemini-schema';
import { uiTools, type HudControls } from './tools/ui-tools';

const IDLE_MIC_TIMEOUT = 5 * 60_000; // auto-sleep the mic after 5 min of silence (saves tokens)

let cfg: AppConfig;
let keys = { mic: '', hud: '', vision: '' };
let client: LiveClient | null = null;
let liveState: LiveState = 'closed';
let busy = false;
let visionTimer = 0;
let lastSpeech = Date.now();
let userSpokeAt = 0;
let awaitingFirstAudio = false;

const player = new Player();
const mic = new Mic((b64) => client?.sendAudio(b64));

// ---------------- HUD state ----------------
function setFlag(id: string, on: boolean) {
  $(`#${id}`).classList.toggle('on', on);
}

const controls: HudControls = {
  setMini: (on) => document.body.classList.toggle('mini', on),
  setLog: (on) => document.body.classList.toggle('log-hidden', !on),
  setTheme: (c) => document.documentElement.style.setProperty('--accent', accentColor(c)!),
  setVision: (on) => setVision(on),
};

function orbState(): OrbState {
  if (liveState === 'error') return 'error';
  if (liveState !== 'live') return 'offline';
  if (busy) return 'thinking';
  if (player.speaking) return 'speaking';
  if (mic.active) return 'listening';
  return 'idle';
}

function statusText(): string {
  switch (liveState) {
    case 'live':
      return busy ? 'EXECUTING' : player.speaking ? 'SPEAKING' : mic.active ? 'LISTENING' : 'STANDBY';
    case 'connecting': return 'CONNECTING';
    case 'reconnecting': return 'RE-LINKING';
    case 'error': return 'FAULT';
    default: return 'OFFLINE';
  }
}

// ---------------- Mic / vision ----------------
async function setMic(on: boolean) {
  if (on === mic.active) return;
  if (on) {
    try {
      await mic.start();
      lastSpeech = Date.now();
      if (player.ctx.state === 'suspended') player.ctx.resume();
    } catch (e: any) {
      toast('Microphone unavailable', e?.message ?? String(e), 'error');
    }
  } else {
    mic.stop();
    client?.endAudio();
  }
  setFlag('btn-mic', mic.active);
}

async function setVision(on: boolean) {
  clearInterval(visionTimer);
  visionTimer = 0;
  if (on) {
    const push = async () => {
      if (!client?.isLive) return;
      try {
        const f = await hud.screenFrame();
        client.sendImage(f.data, f.mimeType);
      } catch {}
    };
    push();
    visionTimer = window.setInterval(push, 1000);
    toast('Vision online', 'Streaming your screen to JARVIS at 1 fps', 'info', 3);
  }
  setFlag('btn-vision', on);
}

// ---------------- Session ----------------
async function startSession() {
  const mainTools = await hud.toolManifest();
  const dispatcher = new Dispatcher(mainTools, uiTools(controls), {
    autoApprove: () => cfg.autoApprove,
    sendImage: (b64, mime) => client?.sendImage(b64, mime),
    onBusy: (b) => (busy = b),
  });

  client?.close();
  client = new LiveClient(
    {
      apiKey: cfg.apiKey,
      model: cfg.model,
      voice: cfg.voice,
      systemInstruction: () => systemPrompt(cfg),
      declarations: toDeclarations(dispatcher.manifests),
    },
    {
      onState: (s, detail) => {
        const prev = liveState;
        liveState = s;
        if (s === 'live' && prev !== 'live') toast('Link established', `${cfg.model} · ${dispatcher.manifests.length} tools armed`, 'success', 3);
        if (s === 'error') toast('Gemini Live error', detail ?? '', 'error', 10);
      },
      onAudio: (b64) => {
        if (awaitingFirstAudio && userSpokeAt) {
          $('#latency').textContent = `${Math.round(performance.now() - userSpokeAt)}ms`;
          awaitingFirstAudio = false;
        }
        player.play(b64);
      },
      onInterrupted: () => player.interrupt(),
      onInputText: (t) => {
        subtitleNewUserTurn();
        subtitle('user', t);
        lastSpeech = Date.now();
        userSpokeAt = performance.now();
        awaitingFirstAudio = true;
      },
      onOutputText: (t) => subtitle('ai', t),
      onTurnComplete: () => subtitleTurnEnd(),
      onToolCall: async (calls) => {
        const responses = await dispatcher.handle(calls);
        client?.sendToolResponses(responses);
      },
      onToolCancel: (ids) => dispatcher.cancel(ids),
    },
  );
  await client.connect();
}

function sendTyped(text: string) {
  if (!text.trim()) return;
  if (!client?.isLive) return toast('Not connected', 'Waiting for the Gemini Live link…', 'warning');
  subtitleNewUserTurn();
  subtitle('user', text, false);
  userSpokeAt = performance.now();
  awaitingFirstAudio = true;
  client.sendText(text);
}

// ---------------- Setup (first run) ----------------
function showSetup(): Promise<void> {
  return new Promise((resolve) => {
    const input = h('input', { type: 'password', placeholder: 'Paste your Gemini API key', spellcheck: 'false' });
    const save = h('button', { class: 'btn approve' }, 'INITIALIZE');
    const card = h(
      'div',
      { class: 'setup', 'data-hit': true },
      h('div', { class: 'setup-title' }, 'J.A.R.V.I.S'),
      h('p', {}, 'Gemini Live API key required. Get one free at aistudio.google.com/apikey — it is stored locally on this PC only.'),
      input,
      save,
    );
    $('#modal').append(card);
    const go = async () => {
      const key = input.value.trim();
      if (key.length < 20) return input.classList.add('bad');
      cfg = await hud.setConfig({ apiKey: key });
      card.remove();
      resolve();
    };
    save.onclick = go;
    input.onkeydown = (e) => e.key === 'Enter' && go();
    setTimeout(() => input.focus(), 100);
  });
}

// ---------------- Wiring ----------------
function wireUi() {
  $('#btn-mic').onclick = () => setMic(!mic.active);
  $('#orb').onclick = () => setMic(!mic.active);
  $('#btn-vision').onclick = () => setVision(!visionTimer);
  $('#btn-type').onclick = () => {
    document.body.classList.toggle('typing');
    if (document.body.classList.contains('typing')) $<HTMLInputElement>('#cmd').focus();
  };
  $('#btn-clear').onclick = () => closeAllPanels();
  $('#btn-log').onclick = () => document.body.classList.toggle('log-hidden');
  $('#btn-mini').onclick = () => document.body.classList.toggle('mini');
  $('#btn-hide').onclick = () => hud.hide();
  $('#btn-power').onclick = () => hud.quit();
  $<HTMLInputElement>('#cmd').onkeydown = (e) => {
    const el = e.target as HTMLInputElement;
    if (e.key === 'Enter') {
      sendTyped(el.value);
      el.value = '';
    } else if (e.key === 'Escape') {
      document.body.classList.remove('typing');
      el.blur();
    }
  };

  hud.onHotkey((a) => {
    if (a === 'toggle-mic') setMic(!mic.active);
    if (a === 'toggle-vision') setVision(!visionTimer);
  });
  hud.onFx((e) => {
    if (e.type === 'click' || e.type === 'move') rippleAt(e.x, e.y, e.type);
    if (e.type === 'type') typingFx(e.text);
  });
  hud.onEvent((e) => {
    if (e.type === 'timer') {
      toast(e.label, 'Timer complete', 'warning', 15);
      client?.sendText(`[SYSTEM EVENT] The timer "${e.label}" just finished. Tell the user now, briefly.`);
    }
  });

  // Status bar + clock + idle mic sleep, at 4 Hz (cheap).
  setInterval(() => {
    $('#status').textContent = statusText();
    $('#status').dataset.state = orbState();
    $('#clock').textContent = new Date().toLocaleTimeString([], { hour12: false });
    if (mic.active && mic.level > 0.02) lastSpeech = Date.now();
    if (mic.active && Date.now() - lastSpeech > IDLE_MIC_TIMEOUT) {
      setMic(false);
      toast('Microphone asleep', `No speech for 5 minutes. ${keys.mic || 'Click the core'} to wake.`, 'info');
    }
  }, 250);
}

/** Exercises the HUD tools with sample data (used by `npm run selftest`). */
async function hudDemo() {
  const tools = new Map(uiTools(controls).map((t) => [t.name, t]));
  const run = (name: string, args: unknown) => tools.get(name)!.run(args);
  document.querySelector('.setup')?.remove();
  await run('show_chart', {
    title: 'Response latency', type: 'area', unit: 'ms',
    labels: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'],
    series: [{ name: 'p50', values: [420, 380, 350, 410, 300, 280, 260] }, { name: 'p95', values: [900, 820, 760, 880, 640, 600, 560] }],
  });
  await run('show_stats', {
    title: 'Mission status', accent: 'red',
    stats: [
      { label: 'Tasks', value: '12', percent: 75, trend: 'up' },
      { label: 'Uptime', value: '99.9%', percent: 99 },
      { label: 'Errors', value: '0', trend: 'down' },
      { label: 'Tools', value: '43' },
    ],
  });
  await run('show_panel', { title: 'Briefing', content: '## Summary\n- **Voice** link is *ready*\n- Tools armed: `43`\n\n```js\nconsole.log("hello")\n```' });
  await run('show_chart', { title: 'Disk usage', type: 'donut', labels: ['System', 'Apps', 'Media', 'Free'], series: [{ name: 'GB', values: [40, 85, 120, 55] }], unit: 'GB' });
  await run('show_system_monitor', {});
  await run('mark_screen', { x: 400, y: 300, width: 200, height: 120, label: 'TARGET', seconds: 30 });
  await run('point_at', { x: 700, y: 550, label: 'Here', seconds: 30 });
  rippleAt(500, 500);
  toast('Demo', 'All HUD systems nominal', 'success', 30);
  subtitle('user', 'Show me the system status', false);
  subtitle('ai', 'All systems are nominal, sir. Telemetry is on your display.', false);
}
(window as any).__hudDemo = hudDemo;

async function boot() {
  hydrateIcons();
  initHitTest();
  initPanels();
  const orb = new Orb($('#orb') as HTMLCanvasElement, () => ({
    mic: mic.level,
    voice: player.speaking ? player.level() : 0,
    spectrum: player.speaking ? player.spectrum() : null,
  }));
  setInterval(() => (orb.state = orbState()), 100);
  wireUi();

  [cfg, keys] = await Promise.all([hud.getConfig(), hud.hotkeys()]);
  $('#model').textContent = cfg.model.toUpperCase();
  const hint = (k: string) => (k ? ` (${k})` : '');
  $('#orb').title = `Click${keys.mic ? ` or ${keys.mic}` : ''} to talk`;
  $('#btn-mic').title = `Microphone${hint(keys.mic)}`;
  $('#btn-vision').title = `Stream screen${hint(keys.vision)}`;
  $('#btn-hide').title = `Hide${hint(keys.hud)}`;
  if (!cfg.apiKey) await showSetup();
  await startSession();
}

boot().catch((e) => toast('Boot failure', String(e?.message ?? e), 'error', 30));
