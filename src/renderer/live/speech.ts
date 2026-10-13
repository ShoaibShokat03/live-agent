/**
 * Keeps the user's recent *speech* (16 kHz PCM) for voiceprints: a simple energy gate splits
 * the mic stream into utterances; silence and JARVIS's own voice (echo) are dropped.
 */
const RATE = 16000;
const GATE = 0.012; // RMS that counts as speech (after browser noise suppression)
const HANGOVER = 12; // chunks (~380 ms) of silence that end an utterance
const MIN_UTTERANCE = 0.6 * RATE;
const KEEP_MS = 90_000;

export interface Utterance { pcm: Int16Array; at: number }

export class SpeechBuffer {
  private current: Int16Array[] = [];
  private silent = 0;
  private utterances: Utterance[] = [];
  constructor(private onUtterance: (u: Utterance) => void) {}

  push(chunk: Int16Array, rms: number, aiSpeaking: boolean) {
    if (aiSpeaking) return this.flush(); // never learn JARVIS's own voice from speaker bleed
    if (rms >= GATE) {
      this.current.push(chunk);
      this.silent = 0;
    } else if (this.current.length) {
      this.current.push(chunk); // keep short pauses inside the utterance
      if (++this.silent >= HANGOVER) this.flush();
    }
  }

  private flush() {
    if (!this.current.length) return;
    const voiced = this.current.slice(0, this.current.length - this.silent);
    this.current = [];
    this.silent = 0;
    const len = voiced.reduce((n, c) => n + c.length, 0);
    if (len < MIN_UTTERANCE) return;
    const pcm = new Int16Array(len);
    let o = 0;
    for (const c of voiced) {
      pcm.set(c, o);
      o += c.length;
    }
    const u = { pcm, at: Date.now() };
    this.utterances.push(u);
    const cutoff = Date.now() - KEEP_MS;
    this.utterances = this.utterances.filter((x) => x.at >= cutoff).slice(-30);
    this.onUtterance(u);
  }

  /** Most recent speech, newest first, up to `seconds` (for enrollment/identification). */
  recent(seconds: number, withinMs = KEEP_MS): Int16Array | null {
    this.flush();
    const cutoff = Date.now() - withinMs;
    const parts: Int16Array[] = [];
    let n = 0;
    for (let i = this.utterances.length - 1; i >= 0 && n < seconds * RATE; i--) {
      const u = this.utterances[i];
      if (u.at < cutoff) break;
      parts.unshift(u.pcm);
      n += u.pcm.length;
    }
    if (!n) return null;
    const out = new Int16Array(Math.min(n, seconds * RATE));
    let o = 0;
    for (const p of parts) {
      const take = Math.min(p.length, out.length - o);
      out.set(p.subarray(p.length - take), o);
      o += take;
      if (o >= out.length) break;
    }
    return out;
  }

  seconds(withinMs = KEEP_MS) {
    const cutoff = Date.now() - withinMs;
    return this.utterances.filter((u) => u.at >= cutoff).reduce((n, u) => n + u.pcm.length, 0) / RATE;
  }
}
