import { h, hud } from '../bridge';
import { sparkline } from './chart';

const GB = 1073741824;

const fmtUptime = (s: number) => {
  const d = Math.floor(s / 86400), hh = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
  return `${d ? d + 'd ' : ''}${hh}h ${m}m`;
};

/** Live system telemetry widget. Returns a cleanup function. */
export function mountMonitor(root: HTMLElement): () => void {
  root.innerHTML = `
  <div class="mon">
    <div class="mon-row">
      <div class="mon-ring" data-k="cpu"><svg viewBox="0 0 100 100"><circle class="trk" cx="50" cy="50" r="42"/><circle class="val" cx="50" cy="50" r="42"/></svg><b>0%</b><span>CPU</span></div>
      <div class="mon-ring" data-k="mem"><svg viewBox="0 0 100 100"><circle class="trk" cx="50" cy="50" r="42"/><circle class="val" cx="50" cy="50" r="42"/></svg><b>0%</b><span>RAM</span></div>
      <div class="mon-ring" data-k="disk"><svg viewBox="0 0 100 100"><circle class="trk" cx="50" cy="50" r="42"/><circle class="val" cx="50" cy="50" r="42"/></svg><b>–</b><span>DISK C:</span></div>
    </div>
    <div class="mon-spark"><label>CPU / RAM · 60s</label><canvas class="sp-cpu"></canvas><canvas class="sp-mem"></canvas></div>
    <div class="mon-cores"></div>
    <div class="mon-kv"></div>
  </div>`;
  const C = 2 * Math.PI * 42;
  const setRing = (k: string, pct: number, label: string) => {
    const ring = root.querySelector<HTMLElement>(`.mon-ring[data-k="${k}"]`)!;
    const val = ring.querySelector<SVGCircleElement>('.val')!;
    val.style.strokeDasharray = `${C}`;
    val.style.strokeDashoffset = `${C * (1 - pct / 100)}`;
    val.style.stroke = pct > 85 ? '#ff2d55' : pct > 65 ? '#ff8a3d' : 'var(--accent)';
    ring.querySelector('b')!.textContent = label;
  };
  const cpuHist: number[] = [], memHist: number[] = [];
  const cores = root.querySelector<HTMLElement>('.mon-cores')!;
  const kv = root.querySelector<HTMLElement>('.mon-kv')!;
  let battery: any = null;
  (navigator as any).getBattery?.().then((b: any) => (battery = b)).catch(() => {});

  const tick = async () => {
    const s = await hud.stats();
    const memPct = (s.memUsed / s.memTotal) * 100;
    setRing('cpu', s.cpu, `${s.cpu}%`);
    setRing('mem', memPct, `${Math.round(memPct)}%`);
    if (s.disk) setRing('disk', (s.disk.used / s.disk.total) * 100, `${Math.round((s.disk.used / s.disk.total) * 100)}%`);
    cpuHist.push(s.cpu);
    memHist.push(memPct);
    if (cpuHist.length > 60) cpuHist.shift(), memHist.shift();
    sparkline(root.querySelector('.sp-cpu')!, cpuHist, 100, '#ffc23d');
    sparkline(root.querySelector('.sp-mem')!, memHist, 100, '#ff3b3b');
    if (cores.childElementCount !== s.cores.length) {
      cores.innerHTML = '';
      s.cores.forEach(() => cores.append(h('i')));
    }
    s.cores.forEach((v, i) => ((cores.children[i] as HTMLElement).style.setProperty('--v', `${v}%`)));
    const rows: [string, string][] = [
      ['MEMORY', `${(s.memUsed / GB).toFixed(1)} / ${(s.memTotal / GB).toFixed(1)} GB`],
      ['UPTIME', fmtUptime(s.uptime)],
      ['CORES', String(s.cores.length)],
      ['JARVIS MEM', `${Math.round(s.procMem / 1048576)} MB`],
      ['NETWORK', navigator.onLine ? 'ONLINE' : 'OFFLINE'],
    ];
    if (battery) rows.push(['BATTERY', `${Math.round(battery.level * 100)}% ${battery.charging ? '(charging)' : ''}`]);
    kv.innerHTML = rows.map(([k, v]) => `<div><span>${k}</span><b>${v}</b></div>`).join('');
  };
  tick();
  const t = setInterval(tick, 1000);
  return () => clearInterval(t);
}
