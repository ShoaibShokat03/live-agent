/** Arc-reactor style core that visualizes mic input, AI voice spectrum and agent state. */

export type OrbState = 'offline' | 'idle' | 'listening' | 'thinking' | 'speaking' | 'error';

const COLORS: Record<OrbState, [number, number, number]> = {
  offline: [120, 100, 90],
  idle: [210, 150, 40],
  listening: [255, 194, 61],
  thinking: [255, 59, 59],
  speaking: [255, 226, 150],
  error: [255, 30, 110],
};

export class Orb {
  state: OrbState = 'offline';
  private g: CanvasRenderingContext2D;
  private t = 0;
  private col: [number, number, number] = [...COLORS.offline];
  private mic = 0;
  private voice = 0;

  constructor(
    private canvas: HTMLCanvasElement,
    private sample: () => { mic: number; voice: number; spectrum: Uint8Array | null },
  ) {
    this.g = canvas.getContext('2d')!;
    const loop = () => {
      this.frame();
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  }

  private frame() {
    const c = this.canvas;
    const dpr = devicePixelRatio || 1;
    const size = c.clientWidth;
    if (!size || document.hidden) return;
    if (c.width !== size * dpr) {
      c.width = size * dpr;
      c.height = size * dpr;
    }
    const g = this.g;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, size, size);

    const s = this.sample();
    this.mic += (Math.min(1, s.mic * 6) - this.mic) * 0.3;
    this.voice += (Math.min(1, s.voice * 5) - this.voice) * 0.3;
    const target = COLORS[this.state];
    this.col = this.col.map((v, i) => v + (target[i] - v) * 0.08) as [number, number, number];
    const [r, gg, b] = this.col.map(Math.round);
    const rgba = (a: number) => `rgba(${r},${gg},${b},${a})`;

    const speed = this.state === 'thinking' ? 3 : this.state === 'offline' ? 0.2 : 1;
    this.t += 0.016 * speed;
    const cx = size / 2, cy = size / 2;
    const R = size * 0.42;
    const energy = Math.max(this.mic, this.voice);

    // Outer glow
    const glow = g.createRadialGradient(cx, cy, R * 0.2, cx, cy, R * 1.15);
    glow.addColorStop(0, rgba(0.18 + energy * 0.35));
    glow.addColorStop(1, rgba(0));
    g.fillStyle = glow;
    g.fillRect(0, 0, size, size);

    // Spectrum ring (AI voice) — radial bars
    const spec = s.spectrum;
    const bars = 72;
    g.lineWidth = 2;
    for (let i = 0; i < bars; i++) {
      const v = spec ? spec[Math.floor((i % (bars / 2)) * 1.4) + 2] / 255 : 0;
      const a = (i / bars) * Math.PI * 2 + this.t * 0.2;
      const len = 3 + v * R * 0.32 + this.mic * 6;
      g.strokeStyle = rgba(0.25 + v * 0.75);
      g.beginPath();
      g.moveTo(cx + Math.cos(a) * (R * 0.98), cy + Math.sin(a) * (R * 0.98));
      g.lineTo(cx + Math.cos(a) * (R * 0.98 + len), cy + Math.sin(a) * (R * 0.98 + len));
      g.stroke();
    }

    // Tick ring
    g.strokeStyle = rgba(0.5);
    g.lineWidth = 1;
    for (let i = 0; i < 120; i++) {
      const a = (i / 120) * Math.PI * 2 - this.t * 0.15;
      const l = i % 10 === 0 ? 8 : 3;
      g.beginPath();
      g.moveTo(cx + Math.cos(a) * (R * 0.86), cy + Math.sin(a) * (R * 0.86));
      g.lineTo(cx + Math.cos(a) * (R * 0.86 - l), cy + Math.sin(a) * (R * 0.86 - l));
      g.stroke();
    }

    // Segmented arcs, counter-rotating
    const arc = (rad: number, w: number, segs: number, gap: number, rot: number, alpha: number) => {
      g.lineWidth = w;
      g.strokeStyle = rgba(alpha);
      for (let i = 0; i < segs; i++) {
        const a0 = rot + (i / segs) * Math.PI * 2;
        g.beginPath();
        g.arc(cx, cy, rad, a0, a0 + (Math.PI * 2) / segs - gap);
        g.stroke();
      }
    };
    arc(R * 0.74, 3, 3, 0.5, this.t * 0.9, 0.85);
    arc(R * 0.66, 1.5, 8, 0.25, -this.t * 0.6, 0.5);
    arc(R * 0.58, 5, 2, 1.4, this.t * 1.6, 0.35 + energy * 0.5);

    // Core
    const coreR = R * (0.3 + this.mic * 0.12 + this.voice * 0.1);
    const core = g.createRadialGradient(cx, cy, 0, cx, cy, coreR);
    core.addColorStop(0, `rgba(255,255,255,${0.85 + energy * 0.15})`);
    core.addColorStop(0.35, rgba(0.9));
    core.addColorStop(1, rgba(0));
    g.fillStyle = core;
    g.beginPath();
    g.arc(cx, cy, coreR, 0, Math.PI * 2);
    g.fill();

    // Inner triangle (reactor)
    g.strokeStyle = rgba(0.7);
    g.lineWidth = 1.5;
    g.beginPath();
    for (let i = 0; i <= 3; i++) {
      const a = -Math.PI / 2 + (i / 3) * Math.PI * 2 + this.t * 0.3;
      const px = cx + Math.cos(a) * R * 0.42, py = cy + Math.sin(a) * R * 0.42;
      i ? g.lineTo(px, py) : g.moveTo(px, py);
    }
    g.stroke();
  }
}
