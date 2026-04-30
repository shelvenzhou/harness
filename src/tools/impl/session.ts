import { z } from 'zod';

import type { Tool } from '../tool.js';

/**
 * `session` reads the captured output of a long-running (async) tool.
 *
 * The runner intercepts this tool — execute() never runs. The runner
 * looks the sessionId up in its in-memory SessionRegistry, truncates
 * the captured output to fit `maxTokens`, and returns the result along
 * with the *full* token estimate so the agent knows whether truncation
 * happened.
 *
 * Future args (not yet implemented; reserved for upcoming milestones):
 *   - `range: { start, end }` — read a specific slice of the captured output.
 *   - `grep: string` — server-side filter so the agent doesn't have to
 *     stream the whole capture back through context.
 */

const SessionArgs = z.object({
  sessionId: z.string().describe('The session id returned by an async tool dispatch.'),
  maxTokens: z
    .number()
    .int()
    .positive()
    .optional()
    .describe('Cap on returned output tokens. Defaults to 2048; truncated output sets `truncated:true`.'),
});

export const sessionTool: Tool<typeof SessionArgs, unknown> = {
  name: 'session',
  concurrency: 'safe',
  description: [
    'Read the captured output of a long-running tool by `sessionId`. Returns `status` (running|done|errored),',
    'the captured `output` truncated to `maxTokens`, the full `totalTokens` estimate, and a `truncated` flag.',
    'Use after `wait({matcher:"session", sessionIds:[...]})` wakes you, or to poll a still-running session.',
  ].join(' '),
  schema: SessionArgs,
  async execute() {
    // Runner intercepts; this body is never reached.
    return { ok: true, output: { intercepted: true } };
  },
};
