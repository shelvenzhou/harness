import { z } from 'zod';

import type { Tool } from '../tool.js';

/**
 * In-process key-value memory. Real implementation (persistent + semantic
 * search) lands in phase 2. Schema is a single object with an `op`
 * discriminator — OpenAI's function-calling requires the top-level
 * parameters schema to be `type: "object"`, so we validate branch-specific
 * required fields inside execute() rather than via a top-level z.union.
 */

const store = new Map<string, unknown>();

const MemoryArgs = z.object({
  op: z.enum(['get', 'set', 'delete', 'search', 'list']).describe(
    'Operation: get | set | delete | search | list',
  ),
  key: z.string().optional().describe('Key for get / set / delete.'),
  value: z.string().optional().describe('Value for set.'),
  query: z.string().optional().describe('Query for search.'),
  topK: z.number().optional().describe('Max results for search.'),
});

export const memoryTool: Tool<typeof MemoryArgs> = {
  name: 'memory',
  concurrency: 'safe',
  description: [
    'Long/short-term memory. `get`/`set`/`delete` on string keys (provide `key`, plus `value` for set);',
    '`list` enumerates keys; `search` is STUB in phase 1 (semantic search lands in phase 2).',
    'Use for plans, pinned facts, cross-turn state the model should remember.',
  ].join(' '),
  schema: MemoryArgs,
  async execute(args) {
    switch (args.op) {
      case 'get': {
        if (!args.key) return missingField('key', 'get');
        return { ok: true, output: { key: args.key, value: store.get(args.key) ?? null } };
      }
      case 'set': {
        if (!args.key) return missingField('key', 'set');
        if (args.value === undefined) return missingField('value', 'set');
        store.set(args.key, args.value);
        return { ok: true, output: { key: args.key, stored: true } };
      }
      case 'delete': {
        if (!args.key) return missingField('key', 'delete');
        const existed = store.delete(args.key);
        return { ok: true, output: { key: args.key, deleted: existed } };
      }
      case 'list':
        return { ok: true, output: { keys: [...store.keys()] } };
      case 'search': {
        if (!args.query) return missingField('query', 'search');
        return {
          ok: true,
          output: {
            query: args.query,
            results: [] as Array<{ key: string; score: number }>,
            note: 'search is stubbed; returns empty (phase 2)',
          },
        };
      }
    }
  },
};

function missingField(
  field: string,
  op: string,
): { ok: false; error: { kind: string; message: string } } {
  return {
    ok: false,
    error: {
      kind: 'schema',
      message: `memory op='${op}' requires '${field}'`,
    },
  };
}

/** Test helper. */
export function resetMemoryStore(): void {
  store.clear();
}
