import { z } from 'zod';

import type { Tool } from '../tool.js';

/**
 * Memory tool. The actual store lives behind a backend (`MemoryStore`)
 * injected via `ctx.services.memory` at runtime — see
 * `src/memory/types.ts`. This tool is thin glue: argument validation +
 * dispatch to the store.
 *
 * If no store is wired the tool returns an `unsupported` error so the
 * model knows memory is disabled rather than silently no-oping.
 */

const MemoryArgs = z.object({
  op: z
    .enum(['get', 'set', 'delete', 'search', 'list', 'pin', 'unpin'])
    .describe('Operation: get | set | delete | search | list | pin | unpin'),
  key: z.string().optional().describe('Key for get / set / delete / pin / unpin.'),
  value: z.string().optional().describe('Value for set.'),
  query: z.string().optional().describe('Query for search.'),
  topK: z
    .number()
    .optional()
    .describe('Max results for search (default 5) or max entries for list (default 50).'),
  pinned: z
    .boolean()
    .optional()
    .describe('If true with op=set, the entry is auto-injected into the system prompt.'),
  tags: z
    .array(z.string())
    .optional()
    .describe(
      'Tags applied with set. This tool currently does not pass tag filters to list/search.',
    ),
});

export const memoryTool: Tool<typeof MemoryArgs> = {
  name: 'memory',
  concurrency: 'safe',
  description: [
    'Long/short-term memory.',
    '`set` saves a key/value (use {pinned: true} to auto-include it in every prompt).',
    '`get` reads one key and returns `{key,value,found}`. `delete` removes one and returns `{key,deleted}`. `list` enumerates `{key,pinned,tags}` entries; `topK` limits list size.',
    '`search` requires `query` and returns `{query,results:[{key,content,score,reason?}]}`; backends with embeddings do semantic search.',
    '`pin` / `unpin` toggle prefix-injection on an existing entry.',
    'Returns `ok:false` with `error.kind:"unsupported"` when no memory store is configured; missing per-op fields return `error.kind:"schema"`.',
  ].join(' '),
  schema: MemoryArgs,
  async execute(args, ctx) {
    const store = ctx.services.memory;
    if (!store) {
      return {
        ok: false as const,
        error: { kind: 'unsupported', message: 'memory store not configured' },
      };
    }
    switch (args.op) {
      case 'get': {
        if (!args.key) return missingField('key', 'get');
        const entry = await store.get(args.key);
        return {
          ok: true,
          output: { key: args.key, value: entry?.value ?? entry?.content ?? null, found: !!entry },
        };
      }
      case 'set': {
        if (!args.key) return missingField('key', 'set');
        if (args.value === undefined) return missingField('value', 'set');
        const entry = await store.set(args.key, args.value, {
          ...(args.pinned !== undefined ? { pinned: args.pinned } : {}),
          ...(args.tags !== undefined ? { tags: args.tags } : {}),
          source: 'agent',
        });
        return { ok: true, output: { key: entry.key, pinned: entry.pinned, stored: true } };
      }
      case 'delete': {
        if (!args.key) return missingField('key', 'delete');
        const deleted = await store.delete(args.key);
        return { ok: true, output: { key: args.key, deleted } };
      }
      case 'list': {
        const entries = await store.list({ limit: args.topK ?? 50 });
        return {
          ok: true,
          output: { entries: entries.map((e) => ({ key: e.key, pinned: e.pinned, tags: e.tags })) },
        };
      }
      case 'search': {
        if (!args.query) return missingField('query', 'search');
        const hits = await store.search(args.query, { topK: args.topK ?? 5 });
        return {
          ok: true,
          output: {
            query: args.query,
            results: hits.map((h) => ({
              key: h.entry.key,
              content: h.entry.content,
              score: h.score,
              reason: h.reason,
            })),
          },
        };
      }
      case 'pin':
      case 'unpin': {
        if (!args.key) return missingField('key', args.op);
        const updated = await store.update(args.key, { pinned: args.op === 'pin' });
        return updated
          ? { ok: true, output: { key: args.key, pinned: updated.pinned } }
          : {
              ok: false as const,
              error: { kind: 'not_found', message: `no memory entry for key '${args.key}'` },
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
    error: { kind: 'schema', message: `memory op='${op}' requires '${field}'` },
  };
}
