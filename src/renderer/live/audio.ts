/**
 * Low-latency audio I/O for Gemini Live.
 *  - Mic: AudioContext pinned at 16 kHz (browser resamples), AudioWorklet emits 32 ms Int16 chunks.
 *  - Player: 24 kHz PCM chunks scheduled back-to-back; instant flush on barge-in.
 */

const WORKLET = `
class Pcm16 extends AudioWorkletProcessor {
  constructor() { super(); this.buf = new Int16Array(512); this.i = 0; this.sum = 0; }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (!ch) return true;
    for (let k = 0; k < ch.length; k++) {
      const s = Math.max(-1, Math.min(1, ch[k]));
      this.sum += s * s;
      this.buf[this.i++] = s < 0 ? s * 0x8000 : s * 0x7fff;
      if (this.i === this.buf.length) {
        const rms = Math.sqrt(this.sum / this.buf.length);
        this.port.postMessage({ pcm: this.buf.buffer, rms }, [this.buf.buffer]);
        this.buf = new Int16Array(512); this.i = 0; this.sum = 0;
      }
    }
    return true;
  }
}
registerProcessor('pcm16', Pcm16);`;

export function bufToB64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

function b64ToFloat32(b64: string): Float32Array<ArrayBuffer> {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const i16 = new Int16Array(bytes.buffer, 0, bytes.length >> 1);
  const f32 = new Float32Array(i16.length);
  for (let i = 0; i < i16.length; i++) f32[i] = i16[i] / 32768;
  return f32;
}

export class Mic {
  level = 0;
  private ctx?: AudioContext;
  private stream?: MediaStream;
  private node?: AudioWorkletNode;
  constructor(private onChunk: (b64: string) => void) {}

  get active() {
    return !!this.stream;
  }

  async start() {
    if (this.stream) return;
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
    });
    this.ctx = new AudioContext({ sampleRate: 16000, latencyHint: 'interactive' });
    const url = URL.createObjectURL(new Blob([WORKLET], { type: 'application/javascript' }));
    await this.ctx.audioWorklet.addModule(url);
    URL.revokeObjectURL(url);
    this.node = new AudioWorkletNode(this.ctx, 'pcm16');
    this.node.port.onmessage = (e) => {
      this.level = this.level * 0.6 + e.data.rms * 0.4;
      this.onChunk(bufToB64(e.data.pcm));
    };
    const mute = this.ctx.createGain();
    mute.gain.value = 0;
    this.ctx.createMediaStreamSource(this.stream).connect(this.node).connect(mute).connect(this.ctx.destination);
  }

  stop() {
    this.stream?.getTracks().forEach((t) => t.stop());
    this.node?.disconnect();
    this.ctx?.close();
    this.stream = this.ctx = this.node = undefined;
    this.level = 0;
  }
}

export class Player {
  readonly ctx = new AudioContext({ sampleRate: 24000, latencyHint: 'interactive' });
  readonly analyser = this.ctx.createAnalyser();
  private out = this.ctx.createGain();
  private next = 0;
  private sources = new Set<AudioBufferSourceNode>();
  private td = new Float32Array(512);
  readonly freq: Uint8Array<ArrayBuffer>;

  constructor() {
    this.analyser.fftSize = 512;
    this.analyser.smoothingTimeConstant = 0.7;
    this.freq = new Uint8Array(new ArrayBuffer(this.analyser.frequencyBinCount));
    this.out.connect(this.analyser).connect(this.ctx.destination);
  }

  get speaking() {
    return this.sources.size > 0;
  }

  play(b64: string) {
    if (this.ctx.state === 'suspended') this.ctx.resume();
    const data = b64ToFloat32(b64);
    if (!data.length) return;
    const buf = this.ctx.createBuffer(1, data.length, 24000);
    buf.copyToChannel(data, 0);
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    src.connect(this.out);
    const now = this.ctx.currentTime;
    if (this.next < now) this.next = now + 0.03; // tiny jitter buffer
    src.start(this.next);
    this.next += buf.duration;
    this.sources.add(src);
    src.onended = () => this.sources.delete(src);
  }

  /** User barged in: drop everything queued immediately. */
  interrupt() {
    for (const s of this.sources) {
      try {
        s.stop();
      } catch {}
    }
    this.sources.clear();
    this.next = 0;
  }

  level(): number {
    this.analyser.getFloatTimeDomainData(this.td);
    let sum = 0;
    for (const v of this.td) sum += v * v;
    return Math.sqrt(sum / this.td.length);
  }

  spectrum(): Uint8Array {
    this.analyser.getByteFrequencyData(this.freq);
    return this.freq;
  }
}
