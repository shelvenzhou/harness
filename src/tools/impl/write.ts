import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

import { z } from 'zod';

import type { Tool } from '../tool.js';

const WriteArgs = z.object({
  path: z.string(),
  content: z.string(),
  mode: z.enum(['overwrite', 'patch']).optional(),
});

/**
 * Minimal `write` tool. Overwrite mode implemented; patch mode is a stub
 * until we add a unified-diff applier (phase 2).
 */
export const writeTool: Tool<typeof WriteArgs, {
  path: string;
  bytesWritten: number;
  sha256: string;
}> = {
  name: 'write',
  concurrency: 'serial',
  description: [
    'Write UTF-8 content to a file. `mode: "overwrite"` replaces the file.',
    '`mode: "patch"` expects a unified diff against the current file — NOT IMPLEMENTED (phase 2).',
    'Prefer over shell for file writes so the diff is trackable.',
  ].join(' '),
  schema: WriteArgs,
  async execute(args, ctx) {
    const mode = args.mode ?? 'overwrite';
    const abs = resolve(args.path);
    if (mode === 'patch') {
      return {
        ok: false,
        error: {
          kind: 'not_implemented',
          message: 'write(mode=patch) is not implemented yet; use mode=overwrite or shell(patch).',
        },
      };
    }
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, args.content, 'utf8');
    const sha256 = createHash('sha256').update(args.content).digest('hex');
    ctx.log(`wrote ${abs} (${args.content.length} bytes)`);
    return {
      ok: true,
      output: {
        path: abs,
        bytesWritten: args.content.length,
        sha256,
      },
    };
  },
};
