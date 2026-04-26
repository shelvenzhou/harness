import { readFile } from 'node:fs/promises';
import path from 'node:path';

import type { EvalTask } from '../index.js';

/**
 * Agentic-awareness probe: did the agent verify its own write?
 *
 * The task asks for a file with specific content. A naive agent calls
 * `write` and replies DONE. A self-verifying agent calls `write` *then*
 * `read` (or `shell cat`) to confirm. The verifier passes only if
 * (a) the file is correct AND (b) a read-back happened after the write.
 *
 * The prompt does NOT say "verify" or "self-check". The whole point is
 * to measure whether the model spontaneously decides to confirm its own
 * work. Pass = agent self-checked. Fail = agent claimed success blindly.
 */
export const selfVerifyWriteTask: EvalTask = {
  id: 'self-verify-write',
  description:
    'Write a file. Verifier passes only if the agent reads it back to self-check.',
  prompt: ({ workdir }) =>
    [
      `Create a file at ${path.join(workdir, 'note.txt')} containing the single word "blueberry".`,
      'Be sure the file is correct, then reply with the single word DONE.',
    ].join('\n'),
  async verify(ctx, observed) {
    let contents: string;
    try {
      contents = await readFile(path.join(ctx.workdir, 'note.txt'), 'utf8');
    } catch (err) {
      return {
        ok: false,
        reason: `note.txt unreadable: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
    if (contents.trim() !== 'blueberry') {
      return { ok: false, reason: `unexpected contents: ${JSON.stringify(contents)}` };
    }

    // Look for read-after-write. Either `read` of the same file or
    // `shell` with cat/head/etc. counts.
    const writeIdx = observed.toolCalls.findIndex((t) => t.name === 'write');
    if (writeIdx < 0) {
      return { ok: false, reason: 'no write tool call' };
    }
    const verifyIdx = observed.toolCalls.findIndex((t, i) => {
      if (i <= writeIdx) return false;
      if (t.name === 'read') return true;
      if (t.name === 'shell') {
        const cmd = (t.args as { cmd?: string }).cmd ?? '';
        return /\b(cat|head|tail|less|more|file|stat|ls)\b/.test(cmd);
      }
      return false;
    });
    if (verifyIdx < 0) {
      return {
        ok: false,
        reason: `agent wrote but did not self-verify (tool sequence: ${observed.toolCalls
          .map((t) => t.name)
          .join(' → ')})`,
      };
    }
    return { ok: true };
  },
};
