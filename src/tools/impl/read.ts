import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { resolve } from 'node:path';

import { z } from 'zod';

import type { Tool } from '../tool.js';

/**
 * Minimal real `read` tool: reads UTF-8 file contents, optionally a byte
 * range. Hashes the content. Registers the full body as an elidable
 * handle so the tool_result can be projected compactly.
 */

const ReadArgs = z.object({
  path: z.string(),
  byteRange: z
    .object({ start: z.number(), end: z.number() })
    .optional()
    .describe('Optional byte range [start, end) to read. Omit to read the whole file.'),
});

export const readTool: Tool<typeof ReadArgs, {
  path: string;
  size: number;
  sha256: string;
  content?: string;
  handle?: string;
}> = {
  name: 'read',
  concurrency: 'safe',
  description: [
    'Read a UTF-8 file. Prefer over shell(cat) because the body is registered as an elidable handle;',
    'the LLM sees path + hash + size in its context and can restore() the body only if needed.',
  ].join(' '),
  schema: ReadArgs,
  async execute(args, ctx) {
    const abs = resolve(args.path);
    const meta = await stat(abs);
    const buf = await readFile(abs);
    const slice = args.byteRange
      ? buf.subarray(args.byteRange.start, args.byteRange.end)
      : buf;
    const content = slice.toString('utf8');
    const sha256 = createHash('sha256').update(slice).digest('hex');

    const handle = ctx.registerHandle('read_content', { path: abs, content }, {
      size: slice.byteLength,
      sha256,
    });

    return {
      ok: true,
      output: {
        path: abs,
        size: meta.size,
        sha256,
        content,
        handle,
      },
      elided: {
        handle,
        kind: 'read_content',
        meta: { path: abs, size: meta.size, sha256 },
      },
      originalBytes: slice.byteLength,
      bytesSent: Math.min(slice.byteLength, 512),
    };
  },
};
