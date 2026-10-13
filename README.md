# J.A.R.V.I.S — Gemini Live desktop agent

A voice-first AI agent for Windows with a transparent sci-fi HUD. You talk to it, and it answers in real time through **Gemini Live**. It can use **43 tools**: it controls apps, windows, mouse and keyboard, sees your screen, runs commands, browses the web, and puts holographic panels, live charts and interactive visuals on your screen.

## Stack (and why)

| Layer | Choice | Why |
|---|---|---|
| Runtime | **Electron 44 + TypeScript (Node 22)** | One runtime gives a transparent, always-on-top, click-through overlay plus full OS access. No Python. |
| AI | **Gemini Live** via `@google/genai` (`gemini-3.8-live`) | Native audio-to-audio over WebSocket, with built-in VAD, barge-in, transcription, tool calling and Google Search. |
| Native control | **koffi** (FFI to `user32.dll`) | Calls the Win32 API directly in microseconds, with no `node-gyp` build step and no PowerShell round-trips. |
| UI | Vanilla TS + Canvas, no framework | Small bundle and no virtual-DOM overhead. The orb and charts run at 60 fps on modest hardware. |
| Build | esbuild | Full build in under 1 s. |

## Run

```bash
npm install
```

```bash
npm start
```

On first launch the HUD asks for your Gemini API key (get one at <https://aistudio.google.com/apikey>). The key is stored only in your local app-data folder. You can also put it in `.env` (copy `.env.example`).

```bash
npm run selftest
```

`selftest` checks the native tools on this machine, renders every HUD widget, saves a snapshot and exits.

### Controls

| Action | Default hotkey (fallback if taken) |
|---|---|
| Talk (toggle mic) | `Ctrl+Alt+Space` → `Ctrl+Shift+Space` → `Alt+Shift+J`, or click the orb |
| Show/hide HUD | `Ctrl+Alt+J` → `Alt+Shift+H` |
| Stream screen (vision) | `Ctrl+Alt+V` → `Alt+Shift+V` |

Hover a button to see which combination is active. The HUD is click-through everywhere except on its own widgets. Drag panels by the header, resize them from the corner, and collapse or close them from the header buttons. The tray icon has the same controls.

Example prompts:
- "Show me my system telemetry."
- "Open Spotify and play the next track."
- "Put Chrome on the left half and VS Code on the right."
- "What's on my screen? Click the Sign in button."
- "Chart Bitcoin's price over the last week."
- "Build me an interactive 3D solar system."
- "Set a 10-minute timer for tea."
- "Remember that my project is called Atlas."

## Architecture

```
┌──────────────── Renderer (HUD) ─────────────────┐        ┌──────────── Main process ───────────┐
│ Mic 16kHz ─AudioWorklet─► LiveClient ◄─WSS─► Gemini Live                                      │
│ Player 24kHz ◄──────────┘   │ toolCall                                                         │
│                             ▼                                                                  │
│                        Dispatcher ── location:'renderer' ─► UI tools (panels, charts, fx)     │
│        validate → confirm? → run → log → respond  │                                           │
│                             └── location:'main' ─IPC─► registry.execute() ─► OS tools (koffi) │
└──────────────────────────────────────────────────┘        └─────────────────────────────────────┘
```

- **One tool contract.** Every tool is `{ name, description, parameters (JSON Schema), confirm?, timeoutMs?, run }`. The schema is converted to Gemini's format at connect time and also used to **validate and coerce** arguments before execution (for example `"42"` becomes `42`, and enum casing is fixed).
- **One pipeline.** Lookup → validate → user approval for dangerous tools → execute with timeout → log in the HUD → compact the result (≤12k chars) → `sendToolResponse`. All calls in a batch run **in parallel**.
- **Vision.** Screenshots use fast GDI capture (~150 ms). Windows can't exclude a transparent Electron overlay from capture, so the HUD steps off-screen for each capture (a blink of under 0.1 s). That way the AI always sees your real desktop, never JARVIS's own widgets.
- **Precise clicking, in three tiers.**
  1. `scan_ui` reads every control through native Windows UI Automation (COM, compiled once in a persistent host) and sends a numbered screenshot. `click_element` / `set_element_text` then act by number, pixel-exact.
  2. `locate_on_screen` asks `gemini-3.8-flash` to find the target's bounding box on a full-resolution screenshot. Use it for web pages and custom UIs.
  3. Raw coordinates are the last resort.
  During every AI mouse action, the HUD is fully click-through, so its panels can't swallow clicks.
- **Senses.** Webcam vision, face recognition (face-api on WebGL, 128-d descriptors), and speaker recognition (WavLM speaker-verification, fp32 ONNX). All of it runs on this PC. Face and voice data are encrypted with Windows data protection.
- **Coordinates.** Everything uses Gemini's native **0–1000 normalized grid**. It is converted to physical pixels with DPI scaling, so clicks land correctly at any resolution.
- **Long sessions.** Session-resumption handles, context-window compression and `goAway` handling hop to new connections seamlessly. Reconnects use exponential backoff, and auth/config errors stop the retries.
- **Latency.** Mic chunks are 32 ms, the VAD is tuned aggressively (450 ms silence), playback uses a 30 ms jitter buffer, and barge-in flushes audio instantly. The `RESPONSE` field in the top bar shows measured voice-to-voice latency.

### Tools

**OS (main process):** `open_app` (Start-menu index, Store apps included), `open_url`, `list_windows`, `window_control` (focus/min/max/restore/close/move), `close_app`, `mouse_move`, `mouse_click`, `mouse_drag`, `mouse_scroll`, `type_text` (Unicode), `press_keys`, `media_control`, `look_at_screen`, `get_system_info`, `get_datetime`, `clipboard_read/write`, `run_command`⚠, `list_directory`, `read_file`, `write_file`⚠, `search_files`, `reveal_in_explorer`, `web_fetch`, `set_timer`, `list_timers`, `cancel_timer`, `remember`, `recall`, `forget`.
**HUD (renderer):** `show_panel`, `show_chart`, `show_stats`, `show_visual` (sandboxed HTML/JS), `show_system_monitor`, `update_panel`, `move_panel`, `close_panel`, `list_panels`, `notify`, `mark_screen`, `point_at`, `hud_control`.
**Precision UI:** `scan_ui`, `click_element`, `set_element_text`, `locate_on_screen`, `wait`.
**Senses:** `camera_control`, `identify_people`, `enroll_face`, `enroll_voice`, `who_is_speaking`, `list_people`, `forget_person`⚠.
**Built in:** Google Search.

⚠ = requires approval in the HUD (set `AUTO_APPROVE=true` to skip, which is not recommended).

### Adding a tool

Add an entry to any array in `src/main/tools/*.ts`, or to `src/renderer/tools/ui-tools.ts` for HUD tools:

```ts
{
  name: 'lock_pc',
  description: 'Lock the Windows session.',
  parameters: obj({}),
  confirm: true,
  run: () => chord('win+l'),
}
```

The tool is registered, validated, logged and exposed to Gemini automatically.

## Requirements and storage

- **Voice recognition model:** ~400 MB, downloaded once on first voice enrollment into `.cache/models` next to the app (not your C: profile).
- **RAM:** the voice model uses about 0.5 GB while loaded. It only loads after you enroll a voice.
- **Data:** your settings, memories and the face/voice database live in `%APPDATA%jarvis-live`. JARVIS needs some free space on C: to save them.

## Security

- The renderer is sandboxed (`contextIsolation`, no Node) and only talks to the main process through a typed preload bridge.
- AI-generated visuals run in a separate `visual://` origin with `sandbox="allow-scripts"`. They can't reach the HUD, IPC or your files.
- Shell commands and file writes need your click to approve, and the request auto-denies after 60 s.
- The AI's file tools can't read or write JARVIS's own data folder or `.env` files (API key, biometrics). This blocks prompt-injection attempts to steal them.
- If Gemini rejects the session (no credits, invalid key, quota), JARVIS stops retrying and tells you exactly what to fix.

## Limits

- Native control (mouse, keyboard, windows) is Windows-only. The rest is cross-platform.
- Only the primary monitor is supported for clicks and vision.
- The model ID comes from Google's current Live docs. To change it, set `GEMINI_MODEL` in `.env`.
