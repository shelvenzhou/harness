import { z } from 'zod';

import type { Tool } from '../tool.js';

/**
 * In-process key-value memory. Real implementation (persistent + semantic
 * search) lands in phase 2. The interface is already shaped for semantic
 * search via `op: "search"` so later upgrades don't break the tool's schema.
 */

const store = new Map<string, unknown>();

const MemoryArgs = z.union([
  z.object({ op: z.literal('get'), key: z.string() }),
  z.object({ op: z.literal('set'), key: z.string(), value: z.string() }),
  z.object({ op: z.literal('delete'), key: z.string() }),
  z.object({ op: z.literal('search'), query: z.string(), topK: z.number().optional() }),
  z.object({ op: z.literal('list') }),
]);

export const memoryTool: Tool<typeof MemoryArgs> = {
  name: 'memory',
  concurrency: 'safe',
  description: [
    'Long/short-term memory. `get`/`set`/`delete` on string keys; `list` enumerates keys;',
    '`search` is STUB in phase 1 (semantic search lands in phase 2).',
    'Use for plans, pinned facts, cross-turn state the model should remember.',
  ].join(' '),
  schema: MemoryArgs,
  async execute(args) {
    switch (args.op) {
      case 'get':
        return { ok: true, output: { key: args.key, value: store.get(args.key) ?? null } };
      case 'set':
        store.set(args.key, args.value);
        return { ok: true, output: { key: args.key, stored: true } };
      case 'delete': {
        const existed = store.delete(args.key);
        return { ok: true, output: { key: args.key, deleted: existed } };
      }
      case 'list':
        return { ok: true, output: { keys: [...store.keys()] } };
      case 'search':
        return {
          ok: true,
          output: {
            query: args.query,
            results: [] as Array<{ key: string; score: number }>,
            note: 'search is stubbed; returns empty (phase 2)',
          },
        };
    }
  },
};

/** Test helper. */
export function resetMemoryStore(): void {
  store.clear();
}
