import fs from 'node:fs';
import os from 'node:os';
import type { StatsSnapshot } from '../shared/types';

let prev = os.cpus().map((c) => c.times);
let disk: StatsSnapshot['disk'];
let diskAt = 0;

/** Cheap live stats (no WMI / child processes) — safe to poll every second. */
export function sampleStats(): StatsSnapshot {
  const now = os.cpus().map((c) => c.times);
  const cores = now.map((t, i) => {
    const p = prev[i] ?? t;
    const idle = t.idle - p.idle;
    const total = t.user + t.nice + t.sys + t.irq + t.idle - (p.user + p.nice + p.sys + p.irq + p.idle);
    return total > 0 ? Math.round((1 - idle / total) * 100) : 0;
  });
  prev = now;
  if (Date.now() - diskAt > 30000) {
    diskAt = Date.now();
    try {
      const s = fs.statfsSync(process.platform === 'win32' ? 'C:\\' : '/');
      disk = { total: s.blocks * s.bsize, used: (s.blocks - s.bavail) * s.bsize };
    } catch {}
  }
  return {
    cpu: Math.round(cores.reduce((a, b) => a + b, 0) / (cores.length || 1)),
    cores,
    memTotal: os.totalmem(),
    memUsed: os.totalmem() - os.freemem(),
    disk,
    uptime: os.uptime(),
    procMem: process.memoryUsage().rss,
  };
}
