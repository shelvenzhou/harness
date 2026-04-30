import { z } from 'zod';

import type { Tool } from '../tool.js';

/**
 * `spawn` — THE composition primitive. LLM calls this to fork a subagent.
 * The AgentRunner intercepts this tool_call and turns it into a real
 * child thread + SpawnAction — the tool's execute() just echoes back.
 *
 * The description is load-bearing: it contains decision hints (when to
 * spawn vs. do inline). Matches Codex's `spawn_agent` tool doc.
 */

const Budget = z.object({
  maxTurns: z.number().optional(),
  maxToolCalls: z.number().optional(),
  maxWallMs: z.number().optional(),
  maxTokens: z.number().optional(),
});

const SpawnArgs = z.object({
  task: z.string().describe('Freeform task description. Becomes the child\'s seed user input.'),
  role: z.string().optional().describe('Optional role tag (verifier, researcher, reviewer, …).'),
  budget: Budget.describe('Budget caps. Breach → the child is killed and reports budget_exceeded.'),
  inheritTurns: z.number().optional().describe('If set, copy the last N turns from the parent into the child context. Default 0.'),
});

export const spawnTool: Tool<typeof SpawnArgs, { childThreadId: string }> = {
  name: 'spawn',
  concurrency: 'safe',
  description: [
    'Fork a subagent with its own context. Returns immediately; listen for subtask_complete',
    '(or wait for it via the `wait` tool).',
    '',
    'USE spawn when the child task can proceed without blocking your current decision path:',
    '  - background research ("look up how lib X handles Y while I keep coding")',
    '  - verification of a completed artefact ("did I actually satisfy the spec?")',
    '  - independent experiments you want to run in parallel',
    '',
    'DO NOT spawn for critical-path subtasks. Doing the work inline is cheaper and clearer than',
    'round-tripping through a child — spawn is for concurrency and context isolation, not delegation.',
  ].join('\n'),
  schema: SpawnArgs,
  async execute(args) {
    // AgentRunner intercepts; this path should rarely execute directly.
    return {
      ok: true,
      output: { childThreadId: '(assigned by runner)' },
      originalBytes: JSON.stringify(args).length,
    };
  },
};
