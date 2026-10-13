/**
 * JARVIS's senses beyond the screen: webcam vision, face recognition and speaker recognition.
 * Everything is computed on this PC; only camera frames the user turned on are sent to Gemini.
 */
import type { VoiceMatch } from '../../shared/types';
import { h, hud } from '../bridge';
import { closePanel, hasPanel, openPanel } from '../hud/panels';
import { Camera } from './camera';
import { detectFaces, invalidateFaces, type SeenFace } from './faces';
import { SpeechBuffer, type Utterance } from './speech';

const GREET_EVERY_MS = 10 * 60_000; // announce a known face at most once per 10 min
const RECOGNIZE_EVERY_MS = 1200;
const STREAM_EVERY_MS = 1000;

export interface PerceptionHooks {
  /** Send a camera frame to Gemini as live video. */
  sendFrame(b64: string): void;
  /** A known person just came into view. */
  onRecognized(name: string): void;
  /** Speaker identified for the latest utterance. */
  onSpeaker(m: VoiceMatch): void;
  onCameraChange(on: boolean): void;
}

export class Perception {
  readonly camera = new Camera();
  readonly speech: SpeechBuffer;
  faces: SeenFace[] = [];
  speaker: (VoiceMatch & { at: number }) | null = null;
  private streaming = false;
  private timers: number[] = [];
  private overlay?: HTMLCanvasElement;
  private seenAt = new Map<string, number>();
  private voicesEnrolled = 0;
  private identifying = false;

  constructor(private hooks: PerceptionHooks) {
    this.speech = new SpeechBuffer((u) => this.identifySpeaker(u));
    this.refreshPeople();
  }

  async refreshPeople() {
    const list = await hud.people.list().catch(() => []);
    this.voicesEnrolled = list.reduce((n, p) => n + p.voiceSamples, 0);
    invalidateFaces();
    return list;
  }

  // ---------------- Camera ----------------
  get cameraOn() {
    return this.camera.active;
  }

  /** Turn the webcam on with a HUD preview; `stream` also feeds it to Gemini live. */
  async startCamera(stream = true) {
    await this.camera.start();
    this.streaming = stream;
    if (!hasPanel('camera')) {
      openPanel({
        id: 'camera',
        kind: 'custom',
        title: 'OPTICAL FEED',
        width: 300,
        mount: (body) => this.mountPreview(body),
        onClose: () => this.stopCamera(),
      });
    }
    if (!this.timers.length) {
      this.timers.push(window.setInterval(() => this.recognize(), RECOGNIZE_EVERY_MS));
      this.timers.push(
        window.setInterval(() => {
          if (this.streaming) {
            try {
              this.hooks.sendFrame(this.camera.frame());
            } catch {}
          }
        }, STREAM_EVERY_MS),
      );
    }
    this.hooks.onCameraChange(true);
  }

  stopCamera() {
    this.timers.forEach(clearInterval);
    this.timers = [];
    this.camera.stop();
    this.faces = [];
    if (hasPanel('camera')) closePanel('camera');
    this.hooks.onCameraChange(false);
  }

  /** One fresh frame to the model right now. */
  async look() {
    if (!this.cameraOn) await this.startCamera(false);
    this.hooks.sendFrame(this.camera.frame(1024, 0.85));
    const faces = await this.recognize();
    return {
      sent: true,
      people: faces.map((f) => f.name ?? 'unknown person'),
      note: 'Camera frame sent as the latest vision input.',
    };
  }

  private mountPreview(body: HTMLElement) {
    const wrap = h('div', { class: 'cam-wrap' });
    this.overlay = h('canvas', { class: 'cam-overlay' });
    wrap.append(this.camera.video, this.overlay);
    body.append(wrap);
    return () => {
      this.overlay = undefined;
    };
  }

  private drawFaces() {
    const c = this.overlay, v = this.camera.video;
    if (!c || !v.videoWidth) return;
    c.width = v.clientWidth * devicePixelRatio;
    c.height = v.clientHeight * devicePixelRatio;
    const g = c.getContext('2d')!;
    const k = c.width / v.videoWidth;
    g.clearRect(0, 0, c.width, c.height);
    g.lineWidth = 2 * devicePixelRatio;
    g.font = `${11 * devicePixelRatio}px Orbitron, sans-serif`;
    for (const f of this.faces) {
      const color = f.name ? '#ffc23d' : '#ff3b3b';
      const x = f.box.x * k, y = f.box.y * k, w = f.box.width * k, hh = f.box.height * k;
      g.strokeStyle = color;
      g.strokeRect(x, y, w, hh);
      const label = f.name ? f.name.toUpperCase() : 'UNKNOWN';
      const tw = g.measureText(label).width + 10 * devicePixelRatio;
      g.fillStyle = color;
      g.fillRect(x, y - 16 * devicePixelRatio, tw, 16 * devicePixelRatio);
      g.fillStyle = '#1a0500';
      g.fillText(label, x + 5 * devicePixelRatio, y - 4 * devicePixelRatio);
    }
  }

  private recognizing = false;
  async recognize(): Promise<SeenFace[]> {
    if (!this.cameraOn || this.recognizing) return this.faces;
    this.recognizing = true;
    try {
      this.faces = await detectFaces(this.camera.video);
      this.drawFaces();
      const now = Date.now();
      for (const f of this.faces) {
        if (!f.name) continue;
        const last = this.seenAt.get(f.name) ?? 0;
        if (now - last > GREET_EVERY_MS) this.hooks.onRecognized(f.name);
        this.seenAt.set(f.name, now);
      }
    } catch {
      // camera paused / models still loading — next tick will retry
    } finally {
      this.recognizing = false;
    }
    return this.faces;
  }

  // ---------------- Face memory ----------------
  /** Learn the face currently in front of the camera (several samples for robustness). */
  async enrollFace(name: string) {
    if (!this.cameraOn) await this.startCamera(false);
    const samples: Float32Array[] = [];
    let crowded = false;
    for (let i = 0; i < 12 && samples.length < 5; i++) {
      const faces = await detectFaces(this.camera.video);
      if (faces.length > 1) crowded = true;
      const main = faces.sort((a, b) => b.box.width * b.box.height - a.box.width * a.box.height)[0];
      if (main && main.box.width > 60) samples.push(main.descriptor);
      await new Promise((r) => setTimeout(r, 350));
    }
    if (samples.length < 2) throw new Error('No clear face in view. Ask the person to face the camera in good light, then try again.');
    const res = await hud.people.addFaces(name, samples.map((d) => Array.from(d)));
    await this.refreshPeople();
    this.seenAt.set(res.name, Date.now()); // don't immediately "greet" the person just enrolled
    return { ...res, captured: samples.length, warning: crowded ? 'More than one face was visible; the largest face was used.' : undefined };
  }

  async identifyPeople() {
    const faces = this.cameraOn ? await this.recognize() : [];
    return {
      camera: this.cameraOn ? 'on' : 'off',
      faces: faces.map((f) => ({ name: f.name ?? 'unknown', confidence: +(1 - f.distance).toFixed(2) })),
      lastSpeaker: this.speaker
        ? { name: this.speaker.name ?? 'unknown', score: this.speaker.score, secondsAgo: Math.round((Date.now() - this.speaker.at) / 1000) }
        : null,
    };
  }

  // ---------------- Voice memory ----------------
  /** Enroll from the speech the user JUST gave (ask them to talk first, then call this). */
  async enrollVoice(name: string) {
    const pcm = this.speech.recent(10, 120_000);
    const secs = (pcm?.length ?? 0) / 16000;
    if (!pcm || secs < 3) {
      throw new Error(`Only ${secs.toFixed(1)}s of recent speech captured. Ask ${name} to speak a few sentences (mic on), then call enroll_voice again.`);
    }
    const res = await hud.people.enrollVoice(name, pcm.buffer as ArrayBuffer);
    await this.refreshPeople();
    return { ...res, secondsUsed: +secs.toFixed(1) };
  }

  async whoIsSpeaking() {
    const pcm = this.speech.recent(4, 30_000);
    if (!pcm || pcm.length < 16000) return { name: null, note: 'No recent speech to analyse.' };
    if (!this.voicesEnrolled) return { name: null, note: 'No voices enrolled yet — use enroll_voice first.' };
    const m = await hud.people.identifyVoice(pcm.buffer as ArrayBuffer);
    this.speaker = { ...m, at: Date.now() };
    return m;
  }

  private async identifySpeaker(_u: Utterance) {
    if (!this.voicesEnrolled || this.identifying) return;
    this.identifying = true;
    try {
      const pcm = this.speech.recent(4, 15_000);
      if (!pcm || pcm.length < 16000) return;
      const m = await hud.people.identifyVoice(pcm.buffer as ArrayBuffer);
      this.speaker = { ...m, at: Date.now() };
      this.hooks.onSpeaker(m);
    } catch {
      // model still downloading or busy — skip this utterance
    } finally {
      this.identifying = false;
    }
  }

  async forget(name: string) {
    const ok = await hud.people.forget(name);
    await this.refreshPeople();
    this.seenAt.delete(name);
    return ok;
  }
}
