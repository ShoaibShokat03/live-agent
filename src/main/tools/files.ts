import { app, shell } from 'electron';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { obj, type ToolDef } from './registry';

const KNOWN: Record<string, () => string> = {
  desktop: () => app.getPath('desktop'),
  documents: () => app.getPath('documents'),
  downloads: () => app.getPath('downloads'),
  pictures: () => app.getPath('pictures'),
  music: () => app.getPath('music'),
  videos: () => app.getPath('videos'),
  home: () => os.homedir(),
};

/** Accepts "~/x", "%USERPROFILE%\\x", "desktop/notes.txt", or absolute paths. */
export function resolvePath(p: string): string {
  let s = p.trim().replace(/^["']|["']$/g, '');
  s = s.replace(/%([^%]+)%/g, (_, v) => process.env[v] ?? `%${v}%`);
  if (s === '~' || s.startsWith('~/') || s.startsWith('~\\')) s = path.join(os.homedir(), s.slice(1));
  const first = s.split(/[\\/]/)[0].toLowerCase();
  if (KNOWN[first]) s = path.join(KNOWN[first](), s.slice(first.length));
  return assertAllowed(path.resolve(s));
}

/**
 * JARVIS's own data (API key, face/voice database, config) and .env files are off-limits to the
 * AI's file tools — so a malicious web page can't trick the AI into reading and leaking them.
 */
function assertAllowed(p: string) {
  const lower = p.toLowerCase();
  const blocked = [app.getPath('userData'), path.join(app.getAppPath(), '.cache')].map((d) => d.toLowerCase());
  if (blocked.some((d) => lower === d || lower.startsWith(d + path.sep)) || /(^|[\\/])\.env(\.|$)/i.test(path.basename(p))) {
    throw new Error("Access denied: that is JARVIS's private data (keys, biometrics, config).");
  }
  return p;
}

const fmtSize = (n: number) =>
  n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : n < 1073741824 ? `${(n / 1048576).toFixed(1)} MB` : `${(n / 1073741824).toFixed(2)} GB`;

export const fileTools: ToolDef[] = [
  {
    name: 'list_directory',
    description: 'List files and folders in a directory. Shortcuts: desktop, documents, downloads, pictures, home, ~.',
    parameters: obj({ path: { type: 'string', default: 'home' }, limit: { type: 'integer', default: 100, maximum: 500 } }),
    async run({ path: p, limit }) {
      const dir = resolvePath(p);
      const entries = await fs.readdir(dir, { withFileTypes: true });
      const items = await Promise.all(
        entries.slice(0, limit).map(async (e) => {
          const full = path.join(dir, e.name);
          if (e.isDirectory()) return { name: e.name, type: 'folder' };
          const st = await fs.stat(full).catch(() => null);
          return { name: e.name, type: 'file', size: st ? fmtSize(st.size) : '?', modified: st?.mtime.toISOString().slice(0, 16) };
        }),
      );
      return { path: dir, total: entries.length, items };
    },
  },
  {
    name: 'read_file',
    description: 'Read a text file (truncated to max_chars).',
    parameters: obj({ path: { type: 'string' }, max_chars: { type: 'integer', default: 8000, maximum: 50000 } }, ['path']),
    async run({ path: p, max_chars }) {
      const file = resolvePath(p);
      const st = await fs.stat(file);
      if (st.size > 20 * 1048576) throw new Error('File too large (>20MB)');
      const text = await fs.readFile(file, 'utf8');
      return { path: file, chars: text.length, truncated: text.length > max_chars, content: text.slice(0, max_chars) };
    },
  },
  {
    name: 'write_file',
    description: 'Create or overwrite a text file (or append). Creates parent folders as needed.',
    parameters: obj(
      { path: { type: 'string' }, content: { type: 'string' }, append: { type: 'boolean', default: false } },
      ['path', 'content'],
    ),
    confirm: true,
    async run({ path: p, content, append }) {
      const file = resolvePath(p);
      await fs.mkdir(path.dirname(file), { recursive: true });
      await (append ? fs.appendFile(file, content, 'utf8') : fs.writeFile(file, content, 'utf8'));
      return { path: file, bytes: Buffer.byteLength(content), append };
    },
  },
  {
    name: 'search_files',
    description: 'Find files/folders whose name contains a query, searching recursively under a directory.',
    parameters: obj(
      {
        query: { type: 'string' },
        path: { type: 'string', default: 'home' },
        max_results: { type: 'integer', default: 30, maximum: 200 },
      },
      ['query'],
    ),
    timeoutMs: 30000,
    async run({ query, path: p, max_results }) {
      const root = resolvePath(p);
      const q = query.toLowerCase();
      const found: string[] = [];
      const skip = new Set(['node_modules', '.git', 'AppData', '$Recycle.Bin', 'Windows']);
      const queue = [root];
      const deadline = Date.now() + 20000;
      while (queue.length && found.length < max_results && Date.now() < deadline) {
        const dir = queue.shift()!;
        const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
        for (const e of entries) {
          if (e.name.toLowerCase().includes(q)) found.push(path.join(dir, e.name));
          if (e.isDirectory() && !skip.has(e.name) && !e.name.startsWith('.')) queue.push(path.join(dir, e.name));
          if (found.length >= max_results) break;
        }
      }
      return { root, results: found };
    },
  },
  {
    name: 'reveal_in_explorer',
    description: 'Show a file or folder in Windows File Explorer.',
    parameters: obj({ path: { type: 'string' } }, ['path']),
    run({ path: p }) {
      shell.showItemInFolder(resolvePath(p));
      return 'shown';
    },
  },
];
