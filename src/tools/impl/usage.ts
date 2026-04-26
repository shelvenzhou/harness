import { z } from 'zod';

import type { Tool } from '../tool.js';

/**
 * `usage` — query the runtime's accounting of tokens, sampling steps,
 * and configured caps. Pull-style; no advisory text is ever pushed
 * into the prompt by the runtime.
 *
 * Design principle: runtime mechanism, LLM policy. The runtime owns
 * the numbers; the model decides what to do with them. If a model
 * wants to wrap up before the cap fires, it can call `usage` and
 * choose; if not, the runtime's hard wall still applies.
 *
 * Intercepted by AgentRunner — the runner has the live counters and
 * the configured `tokenBudget`. The default execute() exists for
 * registry hygiene and tests; in normal operation it is replaced.
 */

const UsageArgs = z.object({}).strict();

export interface UsageOutput {
  tokensThisTurn: number;
  tokensThisThread: number;
  samplingCount: number;
  caps: {
    maxTurnTokens?: number;
    maxThreadTokens?: number;
  };
}

export const usageTool: Tool<typeof UsageArgs, UsageOutput> = {
  name: 'usage',
  concurrency: 'safe',
  description: [
    'Read the runtime\'s accounting: tokens consumed this turn / this thread, sampling steps so far, and any configured token caps.',
    '',
    'Pull-only — the runtime never pushes "you have N tokens left" into your prompt; if you want to know, ask. Use it when the task is open-ended and you want to decide whether to keep iterating, summarise now, or hand off via spawn.',
    '',
    'Caps are *hard walls*: when a cap is hit the turn ends with status=errored. This tool surfaces the same numbers so you can decide *before* the wall.',
  ].join('\n'),
  schema: UsageArgs,
  async execute() {
    return {
      ok: true,
      output: {
        tokensThisTurn: 0,
        tokensThisThread: 0,
        samplingCount: 0,
        caps: {},
      },
    };
  },
};
