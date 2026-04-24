import { z } from 'zod';

import type { Tool } from '../tool.js';

/**
 * Stub shell tool. Phase 2 will implement real child_process.spawn with
 * cwd / env / timeout / byte-cap. Phase 4 runs it inside a sandbox.
 *
 * This stub records the request and returns a synthetic result so that
 * integration tests can exercise the tool-call / tool-result round trip
 * without actually executing anything.
 */

const ShellArgs = z.object({
  cmd: z.string(),
  cwd: z.string().optional(),
  timeoutMs: z.number().optional(),
  maxOutputBytes: z.number().optional(),
});

export const shellTool: Tool<typeof ShellArgs, {
  exitCode: number;
  stdout: string;
  stderr: string;
  truncated: boolean;
}> = {
  name: 'shell',
  concurrency: 'serial',
  description: [
    'Run a shell command. STUB in phase 1 — returns a synthetic result.',
    'Use for any side-effectful or environmental operation (compile, test, git, …).',
    'Prefer `read` / `write` when you only need file I/O, so the result is diffable and elidable.',
  ].join(' '),
  schema: ShellArgs,
  async execute(args, ctx) {
    ctx.log(`shell (stub): ${args.cmd}`);
    return {
      ok: true,
      output: {
        exitCode: 0,
        stdout: `[stub-shell] would run: ${args.cmd}`,
        stderr: '',
        truncated: false,
      },
    };
  },
};
