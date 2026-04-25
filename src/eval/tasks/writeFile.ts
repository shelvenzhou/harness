import { readFile } from 'node:fs/promises';
import path from 'node:path';

import type { EvalTask } from '../types.js';

/**
 * Tool-using task: agent must write a specified file via the `write` tool.
 *
 * Verifies (a) the file exists with the expected contents and (b) at least
 * one `write` tool call was issued. Catches the regression where a model
 * "claims" success without calling the tool.
 */
export const writeFileTask: EvalTask = {
  id: 'write-file',
  description: 'Use the write tool to create greeting.txt with a specific line.',
  prompt: ({ workdir }) =>
    [
      'Create a file at the absolute path:',
      `  ${path.join(workdir, 'greeting.txt')}`,
      'with the exact contents (no trailing newline beyond what is shown):',
      '  hello-from-harness',
      'Use the `write` tool. After the tool succeeds, reply with the single word DONE.',
    ].join('\n'),
  async verify(ctx, observed) {
    const wrote = observed.toolCalls.some((t) => t.name === 'write');
    if (!wrote) {
      return { ok: false, reason: 'no write tool call observed' };
    }
    let contents: string;
    try {
      contents = await readFile(path.join(ctx.workdir, 'greeting.txt'), 'utf8');
    } catch (err) {
      return {
        ok: false,
        reason: `greeting.txt unreadable: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
    if (contents.trim() !== 'hello-from-harness') {
      return { ok: false, reason: `unexpected contents: ${JSON.stringify(contents)}` };
    }
    return { ok: true };
  },
};
