import type { ThreadId } from '@harness/core/ids.js';
import type { Runtime } from '@harness/runtime/bootstrap.js';

/**
 * Eval harness types.
 *
 * The eval harness is a *development tool*, not part of the agent runtime
 * itself. It runs an agent against a fixed task with a deterministic
 * verifier and produces a structured report. It is the judge by which
 * prompt / tool / compaction changes are evaluated.
 *
 * Design principle (see design-docs/00-overview.md): agent self-verification
 * is an LLM-driven concern (the model chooses to spawn a verifier subagent).
 * The eval harness is the orthogonal concern: developer-facing, deterministic,
 * one task → one boolean.
 */

/** Per-eval workspace + handles. Created by the runner; passed to setup/verify. */
export interface EvalContext {
  taskId: string;
  /** Temp directory the task may use as a workspace. Cleaned up after. */
  workdir: string;
  /** The runtime under test. */
  runtime: Runtime;
  /** The thread the task ran on. */
  threadId: ThreadId;
}

export interface EvalTask {
  /** Stable identifier; used in reports and to filter from CLI. */
  id: string;
  /** Short human-readable summary. */
  description: string;
  /**
   * The user prompt sent to the agent as the initial `user_turn_start`.
   * If a function, it can read from the workdir set up by `setup`.
   */
  prompt: string | ((ctx: EvalContext) => string);
  /**
   * Optional preflight: create files, seed memory, etc.
   * Runs *before* the agent receives the prompt.
   */
  setup?: (ctx: EvalContext) => Promise<void> | void;
  /**
   * Deterministic pass/fail check. Runs *after* the agent's turn completes
   * (or times out). Receives the same context plus the collected events.
   */
  verify: (ctx: EvalContext, observed: ObservedRun) => Promise<EvalVerdict> | EvalVerdict;
  /** Per-task wall-clock budget in ms. Defaults to runner-level timeout. */
  timeoutMs?: number;
}

/**
 * What the runner observed during the agent's turn. Passed to `verify` so
 * tasks can assert on replies, tool usage, sampling counts, etc., not just
 * filesystem side effects.
 */
export interface ObservedRun {
  /** All reply event texts concatenated in order. */
  replyText: string;
  /** Tool calls in the order they were emitted. */
  toolCalls: Array<{ name: string; args: unknown }>;
  /** True if a turn_complete with status='completed' was seen. */
  completed: boolean;
  /** Status from the terminal turn_complete, or 'timeout' if none was seen. */
  status: 'completed' | 'interrupted' | 'errored' | 'timeout';
  /** Number of sampling_complete events seen. */
  samplingCount: number;
  /** Sum of completionTokens across sampling_complete events. */
  completionTokens: number;
  /** Sum of promptTokens across sampling_complete events. */
  promptTokens: number;
  /** Sum of cachedPromptTokens. */
  cachedPromptTokens: number;
  /** Wall time from user_turn_start publish to terminal event. */
  wallMs: number;
}

export type EvalVerdict =
  | { ok: true }
  | { ok: false; reason: string };

export interface EvalResult {
  taskId: string;
  /** Final disposition. */
  status: 'pass' | 'fail' | 'timeout' | 'error';
  /** Failure reason from verify, or runner-level error message. */
  reason?: string;
  observed: ObservedRun;
}
