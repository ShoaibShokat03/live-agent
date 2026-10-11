import { getConfig, setConfig } from '../config';
import { obj, type ToolDef } from './registry';

/** Long-term memory: facts persist across sessions and are injected into the system prompt. */
export const memoryTools: ToolDef[] = [
  {
    name: 'remember',
    description: 'Save a lasting fact about the user or their preferences (name, projects, habits) for future sessions.',
    parameters: obj({ fact: { type: 'string' } }, ['fact']),
    run({ fact }) {
      const memories = [...getConfig().memories, { id: `m${Date.now().toString(36)}`, text: fact, at: new Date().toISOString() }];
      setConfig({ memories: memories.slice(-200) });
      return { saved: fact, total: memories.length };
    },
  },
  {
    name: 'recall',
    description: 'Search saved memories (empty query returns all).',
    parameters: obj({ query: { type: 'string', default: '' } }),
    run({ query }) {
      const q: string[] = query.toLowerCase().split(/\s+/).filter(Boolean);
      const all = getConfig().memories;
      return q.length ? all.filter((m) => q.some((t) => m.text.toLowerCase().includes(t))) : all;
    },
  },
  {
    name: 'forget',
    description: 'Delete a saved memory by id or matching text.',
    parameters: obj({ id_or_text: { type: 'string' } }, ['id_or_text']),
    run({ id_or_text }) {
      const k = id_or_text.toLowerCase();
      const before = getConfig().memories;
      const after = before.filter((m) => m.id !== id_or_text && !m.text.toLowerCase().includes(k));
      setConfig({ memories: after });
      return { removed: before.length - after.length };
    },
  },
];
