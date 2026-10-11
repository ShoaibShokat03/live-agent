/** Dependency-free animated canvas charts in HUD style. */

export type ChartType = 'line' | 'area' | 'bar' | 'donut' | 'gauge' | 'radar';

export interface ChartData {
  type: ChartType;
  labels: string[];
  series: { name: string; values: number[] }[];
  unit?: string;
  max?: number;
}

export const PALETTE = ['#ffc23d', '#ff3b3b', '#ff8a3d', '#fff1dc', '#c4161c', '#ffe08a', '#ff6f91'];

const css = (name: string) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

export class Chart {
  private ctx: CanvasRenderingContext2D;
  private progress = 0;
  private hover: { x: number; y: number } | null = null;
  private ro: ResizeObserver;
  private raf = 0;

  constructor(private canvas: HTMLCanvasElement, private data: ChartData) {
    this.ctx = canvas.getContext('2d')!;
    this.ro = new ResizeObserver(() => this.draw());
    this.ro.observe(canvas);
    canvas.addEventListener('mousemove', (e) => {
      const r = canvas.getBoundingClientRect();
      this.hover = { x: e.clientX - r.left, y: e.clientY - r.top };
      this.draw();
    });
    canvas.addEventListener('mouseleave', () => {
      this.hover = null;
      this.draw();
    });
    this.animate();
  }

  update(data: Partial<ChartData>) {
    this.data = { ...this.data, ...data };
    this.progress = 0.4;
    this.animate();
  }

  destroy() {
    cancelAnimationFrame(this.raf);
    this.ro.disconnect();
  }

  private animate() {
    cancelAnimationFrame(this.raf);
    const t0 = performance.now();
    const start = this.progress;
    const step = (t: number) => {
      const k = Math.min(1, (t - t0) / 700);
      this.progress = start + (1 - start) * (1 - Math.pow(1 - k, 3));
      this.draw();
      if (k < 1) this.raf = requestAnimationFrame(step);
    };
    this.raf = requestAnimationFrame(step);
  }

  private draw() {
    const c = this.canvas;
    const dpr = devicePixelRatio || 1;
    const w = c.clientWidth, h = c.clientHeight;
    if (!w || !h) return;
    if (c.width !== Math.round(w * dpr)) c.width = Math.round(w * dpr);
    if (c.height !== Math.round(h * dpr)) c.height = Math.round(h * dpr);
    const g = this.ctx;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, w, h);
    g.font = '11px "JetBrains Mono", monospace';
    const t = this.data.type;
    if (t === 'donut') this.donut(g, w, h);
    else if (t === 'gauge') this.gauge(g, w, h);
    else if (t === 'radar') this.radar(g, w, h);
    else this.xy(g, w, h);
  }

  private fmt(v: number) {
    const a = Math.abs(v);
    const s =
      a >= 1e9 ? (v / 1e9).toFixed(1) + 'B'
      : a >= 1e6 ? (v / 1e6).toFixed(1) + 'M'
      : a >= 1e4 ? (v / 1e3).toFixed(1) + 'K'
      : a >= 100 ? String(Math.round(v))
      : String(+v.toFixed(a >= 10 ? 1 : 2));
    return s + (this.data.unit ?? '');
  }

  /** Rounds an axis max up to a clean 1/2/2.5/5 x 10^n step so tick labels are tidy. */
  private niceMax(v: number) {
    if (v <= 0) return 1;
    const step = Math.pow(10, Math.floor(Math.log10(v / 4)));
    const m = [1, 2, 2.5, 5, 10].find((k) => k * step * 4 >= v)!;
    return m * step * 4;
  }

  private xy(g: CanvasRenderingContext2D, w: number, h: number) {
    const { labels, series, type } = this.data;
    const all = series.flatMap((s) => s.values);
    const max = this.data.max ?? this.niceMax(Math.max(...all, 0) * 1.05);
    const min = Math.min(0, ...all);
    const tickW = Math.max(...[0, 1, 2, 3, 4].map((i) => g.measureText(this.fmt(min + ((max - min) * i) / 4)).width));
    const pad = { l: Math.ceil(tickW) + 12, r: 12, t: series.length > 1 ? 24 : 10, b: 24 };
    const pw = w - pad.l - pad.r, ph = h - pad.t - pad.b;
    const X = (i: number) => pad.l + (labels.length <= 1 ? pw / 2 : (i / (labels.length - 1)) * pw);
    const Y = (v: number) => pad.t + ph - ((v - min) / (max - min)) * ph * this.progress;
    const dim = css('--dim') || 'rgba(255, 194, 61, .35)';

    // grid
    g.strokeStyle = 'rgba(255, 194, 61, 0.08)';
    g.fillStyle = dim;
    g.lineWidth = 1;
    for (let i = 0; i <= 4; i++) {
      const v = min + ((max - min) * i) / 4;
      const y = pad.t + ph - (ph * i) / 4;
      g.beginPath();
      g.moveTo(pad.l, y);
      g.lineTo(w - pad.r, y);
      g.stroke();
      g.textAlign = 'right';
      g.fillText(this.fmt(v), pad.l - 6, y + 4);
    }
    const every = Math.ceil(labels.length / Math.max(1, Math.floor(pw / 60)));
    g.textAlign = 'center';
    labels.forEach((l, i) => {
      if (i % every) return;
      const x = type === 'bar' ? pad.l + (i + 0.5) * (pw / labels.length) : X(i);
      g.fillText(String(l).slice(0, 10), x, h - 6);
    });

    // legend
    if (series.length > 1) {
      let lx = pad.l;
      series.forEach((s, si) => {
        g.fillStyle = PALETTE[si % PALETTE.length];
        g.fillRect(lx, 8, 10, 3);
        g.fillStyle = dim;
        g.textAlign = 'left';
        g.fillText(s.name, lx + 14, 13);
        lx += g.measureText(s.name).width + 30;
      });
    }

    let hoverIdx = -1;
    if (this.hover && this.hover.x > pad.l) {
      hoverIdx = type === 'bar'
        ? Math.floor(((this.hover.x - pad.l) / pw) * labels.length)
        : Math.round(((this.hover.x - pad.l) / pw) * (labels.length - 1));
      if (hoverIdx < 0 || hoverIdx >= labels.length) hoverIdx = -1;
    }

    series.forEach((s, si) => {
      const col = PALETTE[si % PALETTE.length];
      if (type === 'bar') {
        const slot = pw / labels.length;
        const bw = (slot * 0.7) / series.length;
        s.values.forEach((v, i) => {
          const x = pad.l + i * slot + slot * 0.15 + si * bw;
          const y = Y(v), y0 = Y(0);
          const grad = g.createLinearGradient(0, y, 0, y0);
          grad.addColorStop(0, col);
          grad.addColorStop(1, col + '22');
          g.fillStyle = grad;
          g.fillRect(x, Math.min(y, y0), bw - 2, Math.abs(y0 - y));
          g.fillStyle = col;
          g.fillRect(x, Math.min(y, y0), bw - 2, 2);
        });
      } else {
        g.beginPath();
        s.values.forEach((v, i) => (i ? g.lineTo(X(i), Y(v)) : g.moveTo(X(i), Y(v))));
        g.strokeStyle = col;
        g.lineWidth = 2;
        g.shadowColor = col;
        g.shadowBlur = 8;
        g.stroke();
        g.shadowBlur = 0;
        if (type === 'area' || series.length === 1) {
          g.lineTo(X(s.values.length - 1), Y(min));
          g.lineTo(X(0), Y(min));
          g.closePath();
          const grad = g.createLinearGradient(0, pad.t, 0, pad.t + ph);
          grad.addColorStop(0, col + (type === 'area' ? '55' : '30'));
          grad.addColorStop(1, col + '00');
          g.fillStyle = grad;
          g.fill();
        }
        s.values.forEach((v, i) => {
          g.fillStyle = col;
          g.beginPath();
          g.arc(X(i), Y(v), i === hoverIdx ? 4 : 2, 0, Math.PI * 2);
          g.fill();
        });
      }
    });

    if (hoverIdx >= 0) {
      const x = type === 'bar' ? pad.l + (hoverIdx + 0.5) * (pw / labels.length) : X(hoverIdx);
      g.strokeStyle = 'rgba(255,255,255,0.25)';
      g.setLineDash([3, 3]);
      g.beginPath();
      g.moveTo(x, pad.t);
      g.lineTo(x, pad.t + ph);
      g.stroke();
      g.setLineDash([]);
      const rows = series.map((s) => `${s.name}: ${this.fmt(s.values[hoverIdx] ?? 0)}`);
      const tw = Math.max(...rows.map((r) => g.measureText(r).width), g.measureText(labels[hoverIdx]).width) + 16;
      const tx = Math.min(x + 10, w - tw - 4);
      g.fillStyle = 'rgba(20, 3, 3, 0.92)';
      g.strokeStyle = PALETTE[0];
      g.fillRect(tx, pad.t, tw, 18 + rows.length * 15);
      g.strokeRect(tx, pad.t, tw, 18 + rows.length * 15);
      g.fillStyle = '#fff';
      g.textAlign = 'left';
      g.fillText(labels[hoverIdx], tx + 8, pad.t + 13);
      rows.forEach((r, i) => {
        g.fillStyle = PALETTE[i % PALETTE.length];
        g.fillText(r, tx + 8, pad.t + 28 + i * 15);
      });
    }
  }

  private donut(g: CanvasRenderingContext2D, w: number, h: number) {
    const vals = this.data.series[0]?.values ?? [];
    const total = vals.reduce((a, b) => a + Math.max(0, b), 0) || 1;
    const legendW = Math.min(150, w * 0.42);
    const r = Math.min(w - legendW, h) / 2 - 10;
    const cx = (w - legendW) / 2, cy = h / 2;
    let a = -Math.PI / 2;
    vals.forEach((v, i) => {
      const sweep = (Math.max(0, v) / total) * Math.PI * 2 * this.progress;
      g.beginPath();
      g.arc(cx, cy, r, a + 0.02, a + sweep - 0.02);
      g.strokeStyle = PALETTE[i % PALETTE.length];
      g.lineWidth = r * 0.28;
      g.shadowColor = g.strokeStyle;
      g.shadowBlur = 10;
      g.stroke();
      g.shadowBlur = 0;
      a += sweep;
    });
    g.fillStyle = '#fff';
    g.textAlign = 'center';
    g.font = '600 18px Orbitron, sans-serif';
    g.fillText(this.fmt(total), cx, cy + 6);
    g.font = '11px "JetBrains Mono", monospace';
    g.textAlign = 'left';
    this.data.labels.forEach((l, i) => {
      const y = cy - (this.data.labels.length * 18) / 2 + i * 18 + 10;
      g.fillStyle = PALETTE[i % PALETTE.length];
      g.fillRect(w - legendW, y - 8, 8, 8);
      g.fillStyle = '#fff1dc';
      g.fillText(`${String(l).slice(0, 12)} ${Math.round(((vals[i] ?? 0) / total) * 100)}%`, w - legendW + 14, y);
    });
  }

  private gauge(g: CanvasRenderingContext2D, w: number, h: number) {
    const v = this.data.series[0]?.values[0] ?? 0;
    const max = this.data.max ?? 100;
    const r = Math.min(w / 2, h * 0.8) - 14;
    const cx = w / 2, cy = h * 0.62 + r * 0.25;
    const a0 = Math.PI * 0.8, a1 = Math.PI * 2.2;
    g.lineCap = 'round';
    g.lineWidth = 12;
    g.strokeStyle = 'rgba(255, 194, 61, 0.1)';
    g.beginPath();
    g.arc(cx, cy, r, a0, a1);
    g.stroke();
    const k = Math.min(1, Math.max(0, v / max)) * this.progress;
    const col = k > 0.85 ? '#ff2d55' : k > 0.65 ? '#ff8a3d' : '#ffc23d';
    g.strokeStyle = col;
    g.shadowColor = col;
    g.shadowBlur = 14;
    g.beginPath();
    g.arc(cx, cy, r, a0, a0 + (a1 - a0) * k);
    g.stroke();
    g.shadowBlur = 0;
    g.lineCap = 'butt';
    g.fillStyle = '#fff';
    g.textAlign = 'center';
    g.font = `600 ${Math.round(r * 0.38)}px Orbitron, sans-serif`;
    g.fillText(this.fmt(+(v * this.progress).toFixed(1)), cx, cy + 4);
    g.font = '11px "JetBrains Mono", monospace';
    g.fillStyle = '#ffd98a';
    g.fillText(this.data.labels[0] ?? '', cx, cy + r * 0.35);
  }

  private radar(g: CanvasRenderingContext2D, w: number, h: number) {
    const { labels, series } = this.data;
    const n = labels.length;
    if (n < 3) return this.xy(g, w, h);
    const max = this.data.max ?? Math.max(...series.flatMap((s) => s.values), 1);
    const r = Math.min(w, h) / 2 - 28;
    const cx = w / 2, cy = h / 2;
    const P = (i: number, k: number) => [cx + Math.cos(-Math.PI / 2 + (i / n) * Math.PI * 2) * r * k, cy + Math.sin(-Math.PI / 2 + (i / n) * Math.PI * 2) * r * k];
    g.strokeStyle = 'rgba(255, 194, 61, 0.12)';
    for (let ring = 1; ring <= 4; ring++) {
      g.beginPath();
      for (let i = 0; i <= n; i++) {
        const [x, y] = P(i % n, ring / 4);
        i ? g.lineTo(x, y) : g.moveTo(x, y);
      }
      g.stroke();
    }
    g.fillStyle = '#ffd98a';
    g.textAlign = 'center';
    labels.forEach((l, i) => {
      const [x, y] = P(i, 1.14);
      g.fillText(String(l).slice(0, 10), x, y + 4);
    });
    series.forEach((s, si) => {
      const col = PALETTE[si % PALETTE.length];
      g.beginPath();
      s.values.forEach((v, i) => {
        const [x, y] = P(i, (v / max) * this.progress);
        i ? g.lineTo(x, y) : g.moveTo(x, y);
      });
      g.closePath();
      g.fillStyle = col + '33';
      g.strokeStyle = col;
      g.lineWidth = 2;
      g.fill();
      g.stroke();
    });
  }
}

/** Tiny sparkline for live widgets. */
export function sparkline(canvas: HTMLCanvasElement, values: number[], max: number, color: string) {
  const dpr = devicePixelRatio || 1;
  const w = canvas.clientWidth, h = canvas.clientHeight;
  canvas.width = w * dpr;
  canvas.height = h * dpr;
  const g = canvas.getContext('2d')!;
  g.scale(dpr, dpr);
  if (values.length < 2) return;
  g.beginPath();
  values.forEach((v, i) => {
    const x = (i / (values.length - 1)) * w;
    const y = h - (Math.min(v, max) / max) * (h - 2) - 1;
    i ? g.lineTo(x, y) : g.moveTo(x, y);
  });
  g.strokeStyle = color;
  g.lineWidth = 1.5;
  g.stroke();
  g.lineTo(w, h);
  g.lineTo(0, h);
  g.closePath();
  const grad = g.createLinearGradient(0, 0, 0, h);
  grad.addColorStop(0, color + '55');
  grad.addColorStop(1, color + '00');
  g.fillStyle = grad;
  g.fill();
}
