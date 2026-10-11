import { clipboard, screen } from 'electron';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import { obj, type ToolDef } from './registry';
import { resolvePath } from './files';

const GB = 1073741824;

function drives() {
  const out: { drive: string; usedGB: number; totalGB: number; freeGB: number }[] = [];
  if (process.platform !== 'win32') return out;
  for (let c = 67; c <= 90; c++) {
    const root = `${String.fromCharCode(c)}:\\`;
    try {
      const s = fs.statfsSync(root);
      const total = s.blocks * s.bsize, free = s.bavail * s.bsize;
      if (total > 0) out.push({ drive: root, totalGB: +(total / GB).toFixed(1), freeGB: +(free / GB).toFixed(1), usedGB: +((total - free) / GB).toFixed(1) });
    } catch {}
  }
  return out;
}

const timers = new Map<string, { label: string; at: number; t: NodeJS.Timeout }>();

export const systemTools: ToolDef[] = [
  {
    name: 'get_system_info',
    description: 'Get computer specs and status: OS, CPU, RAM, disks, displays, network addresses, uptime.',
    parameters: obj({}),
    run() {
      const cpus = os.cpus();
      return {
        os: `${os.version()} (${os.release()}) ${os.arch()}`,
        hostname: os.hostname(),
        user: os.userInfo().username,
        cpu: { model: cpus[0]?.model.trim(), cores: cpus.length, speedMHz: cpus[0]?.speed },
        memory: { totalGB: +(os.totalmem() / GB).toFixed(1), freeGB: +(os.freemem() / GB).toFixed(1) },
        disks: drives(),
        displays: screen.getAllDisplays().map((d) => ({ size: `${d.size.width}x${d.size.height}`, scale: d.scaleFactor, primary: d.id === screen.getPrimaryDisplay().id })),
        network: Object.entries(os.networkInterfaces()).flatMap(([n, a]) => (a ?? []).filter((i) => i.family === 'IPv4' && !i.internal).map((i) => ({ iface: n, ip: i.address }))),
        uptimeHours: +(os.uptime() / 3600).toFixed(1),
      };
    },
  },
  {
    name: 'get_datetime',
    description: 'Current local date, time and timezone.',
    parameters: obj({}),
    run() {
      const d = new Date();
      return { local: d.toLocaleString(), iso: d.toISOString(), timezone: Intl.DateTimeFormat().resolvedOptions().timeZone, weekday: d.toLocaleDateString(undefined, { weekday: 'long' }) };
    },
  },
  {
    name: 'clipboard_read',
    description: "Read the text on the user's clipboard.",
    parameters: obj({}),
    run: async () => ({ text: (await clipboard.readText()).slice(0, 20000) }),
  },
  {
    name: 'clipboard_write',
    description: "Put text on the user's clipboard.",
    parameters: obj({ text: { type: 'string' } }, ['text']),
    async run({ text }) {
      await clipboard.writeText(text);
      return 'copied';
    },
  },
  {
    name: 'run_command',
    description:
      'Run a PowerShell command and return its output. Powerful: use for system tasks no other tool covers (processes, network diagnostics, git, package installs).',
    parameters: obj(
      {
        command: { type: 'string' },
        cwd: { type: 'string', description: 'Working directory (default: home)' },
        timeout_sec: { type: 'integer', default: 30, minimum: 1, maximum: 300 },
      },
      ['command'],
    ),
    confirm: true,
    timeoutMs: 305000,
    run({ command, cwd, timeout_sec }) {
      return new Promise((resolve) => {
        const p = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', command], {
          cwd: cwd ? resolvePath(cwd) : os.homedir(),
          windowsHide: true,
        });
        let out = '', err = '';
        const cap = (s: string, d: Buffer) => (s.length < 40000 ? s + d.toString() : s);
        p.stdout.on('data', (d) => (out = cap(out, d)));
        p.stderr.on('data', (d) => (err = cap(err, d)));
        const t = setTimeout(() => p.kill(), timeout_sec * 1000);
        p.on('close', (code) => {
          clearTimeout(t);
          resolve({ exitCode: code, stdout: out.trim().slice(0, 12000), stderr: err.trim().slice(0, 4000) });
        });
        p.on('error', (e) => resolve({ exitCode: -1, stderr: e.message }));
      });
    },
  },
  {
    name: 'set_timer',
    description: 'Set a timer/reminder. When it fires the HUD alerts and you are told so you can notify the user aloud.',
    parameters: obj(
      { seconds: { type: 'number', minimum: 1, maximum: 86400 }, label: { type: 'string', default: 'Timer' } },
      ['seconds'],
    ),
    run({ seconds, label }, ctx) {
      const id = `t${Date.now().toString(36)}`;
      const t = setTimeout(() => {
        timers.delete(id);
        ctx.emit('event', { type: 'timer', id, label });
      }, seconds * 1000);
      timers.set(id, { label, at: Date.now() + seconds * 1000, t });
      return { id, label, firesAt: new Date(Date.now() + seconds * 1000).toLocaleTimeString() };
    },
  },
  {
    name: 'list_timers',
    description: 'List active timers.',
    parameters: obj({}),
    run: () => [...timers].map(([id, v]) => ({ id, label: v.label, secondsLeft: Math.round((v.at - Date.now()) / 1000) })),
  },
  {
    name: 'cancel_timer',
    description: 'Cancel a timer by id or label.',
    parameters: obj({ id: { type: 'string' } }, ['id']),
    run({ id }) {
      for (const [k, v] of timers) {
        if (k === id || v.label.toLowerCase() === id.toLowerCase()) {
          clearTimeout(v.t);
          timers.delete(k);
          return { cancelled: v.label };
        }
      }
      throw new Error('No such timer');
    },
  },
];
