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

const ContextRef = z.object({
  sourceThreadId: z.string(),
  fromEventId: z.string().optional(),
  toEventId: z.string().optional(),
});

const SpawnArgs = z.object({
  task: z.string().describe('Freeform task description. Becomes the child\'s seed user input.'),
  role: z.string().optional().describe('Optional role tag (verifier, researcher, reviewer, …).'),
  budget: Budget.describe('Budget caps. Breach → the child is killed and reports budget_exceeded.'),
  contextRefs: z
    .array(ContextRef)
    .optional()
    .describe(
      'Slices of other threads\' event logs the child should see prepended to its own tail. ' +
        'COW: source thread keeps appending after the snapshot range. ' +
        'Use to give a verifier / reviewer subagent the parent\'s recent turns without inheriting the whole prompt.',
    ),
  provider: z
    .string()
    .optional()
    .describe(
      'Override the LLM provider for this child. Omit to inherit the runtime default. ' +
        "Set to 'cc' (Claude Code) or 'codex' to run the child as that coding-agent CLI: it has its " +
        'own filesystem / shell / edit tools internal to the CLI, runs in `cwd`, and returns its ' +
        "final reply as the child's `summary`. Its internal tool calls do not appear in this thread.",
    ),
  cwd: z
    .string()
    .optional()
    .describe(
      'Working directory the coding-agent CLI runs in. Required for coding-agent providers. ' +
        'Anything writable; the CLI reads / writes files relative to this path.',
    ),
  providerSessionId: z
    .string()
    .optional()
    .describe(
      "Resume token for the coding agent's own internal session, captured from a prior spawn's " +
        '`subtask_complete.providerSessionId`. Pass it to continue the same internal conversation ' +
        '(no re-reading of prior context); omit to start a fresh conversation.',
    ),
  continueThreadId: z
    .string()
    .optional()
    .describe(
      'Reuse an existing harness child thread instead of creating a new one. ' +
        'Schema-only in M1 (currently ignored by the runtime).',
    ),
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
    '  - delegating to a coding-agent provider (provider:"cc" / "codex"), which has its own',
    '    file / shell / edit tools and returns its final reply as the child summary',
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
