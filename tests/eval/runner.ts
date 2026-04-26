import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import type { ThreadId } from '@harness/core/ids.js';
import type { HarnessEvent } from '@harness/core/events.js';
import type { Runtime } from '@harness/runtime/bootstrap.js';

import type {
  EvalContext,
  EvalResult,
  EvalTask,
  ObservedRun,
} from './types.js';

/**
 * Run a single eval task against an existing runtime.
 *
 * The runtime is provided by the caller — eval does not own LLM/provider
 * choice. This lets the same task run against a scripted provider in unit
 * tests and against a real provider in HARNESS_E2E mode.
 *
 * The runner subscribes to the bus on the target thread, publishes the
 * user_turn_start, waits for turn_complete (or a timeout), then hands the
 * collected ObservedRun to the task's verify function.
 */

export interface RunEvalOptions {
  /** Wall-clock budget for the whole eval (setup excluded). Defaults to 60s. */
  timeoutMs?: number;
  /** If true, leave workdir on disk after the run (default false). */
  keepWorkdir?: boolean;
  /** Override the thread to run on. Defaults to runtime.rootThreadId. */
  threadId?: ThreadId;
}

export async function runEval(
  task: EvalTask,
  runtime: Runtime,
  opts: RunEvalOptions = {},
): Promise<EvalResult> {
  const threadId = opts.threadId ?? runtime.rootThreadId;
  const workdir = await mkdtemp(path.join(tmpdir(), `harness-eval-${task.id}-`));
  const ctx: EvalContext = { taskId: task.id, workdir, runtime, threadId };

  const observed = createObserver();
  const sub = runtime.bus.subscribe((ev) => observed.record(ev), {
    threadId,
    kinds: [
      'reply',
      'tool_call',
      'sampling_complete',
      'turn_complete',
    ],
  });

  let result: EvalResult;
  try {
    if (task.setup) await task.setup(ctx);

    const startedAt = Date.now();
    const seed = await runtime.store.append({
      threadId,
      kind: 'user_turn_start',
      payload: { text: typeof task.prompt === 'function' ? task.prompt(ctx) : task.prompt },
    });
    runtime.bus.publish(seed);

    const budgetMs = task.timeoutMs ?? opts.timeoutMs ?? 60_000;
    const status = await waitForTerminal(observed, budgetMs);
    const observation = observed.snapshot(status, Date.now() - startedAt);

    if (status === 'timeout') {
      result = { taskId: task.id, status: 'timeout', observed: observation };
    } else if (status !== 'completed') {
      result = {
        taskId: task.id,
        status: 'fail',
        reason: `turn ${status}`,
        observed: observation,
      };
    } else {
      const verdict = await task.verify(ctx, observation);
      result = verdict.ok
        ? { taskId: task.id, status: 'pass', observed: observation }
        : { taskId: task.id, status: 'fail', reason: verdict.reason, observed: observation };
    }
  } catch (err) {
    result = {
      taskId: task.id,
      status: 'error',
      reason: err instanceof Error ? err.message : String(err),
      observed: observed.snapshot('errored', 0),
    };
  } finally {
    sub.unsubscribe();
    if (!opts.keepWorkdir) {
      await rm(workdir, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  return result;
}

interface Observer {
  record(ev: HarnessEvent): void;
  /** Resolve when a turn_complete event arrives. */
  waitForCompletion(): Promise<'completed' | 'interrupted' | 'errored'>;
  snapshot(status: ObservedRun['status'], wallMs: number): ObservedRun;
}

function createObserver(): Observer {
  const replies: string[] = [];
  const toolCalls: Array<{ name: string; args: unknown }> = [];
  let completed = false;
  let terminal: 'completed' | 'interrupted' | 'errored' | null = null;
  let samplingCount = 0;
  let promptTokens = 0;
  let cachedPromptTokens = 0;
  let completionTokens = 0;

  const completionWaiters: Array<(s: 'completed' | 'interrupted' | 'errored') => void> = [];

  return {
    record(ev: HarnessEvent): void {
      switch (ev.kind) {
        case 'reply':
          replies.push(ev.payload.text);
          break;
        case 'tool_call':
          toolCalls.push({ name: ev.payload.name, args: ev.payload.args });
          break;
        case 'sampling_complete':
          samplingCount += 1;
          promptTokens += ev.payload.promptTokens;
          cachedPromptTokens += ev.payload.cachedPromptTokens;
          completionTokens += ev.payload.completionTokens;
          break;
        case 'turn_complete':
          terminal = ev.payload.status;
          completed = ev.payload.status === 'completed';
          for (const w of completionWaiters) w(ev.payload.status);
          completionWaiters.length = 0;
          break;
        default:
          break;
      }
    },
    waitForCompletion(): Promise<'completed' | 'interrupted' | 'errored'> {
      if (terminal) return Promise.resolve(terminal);
      return new Promise((resolve) => completionWaiters.push(resolve));
    },
    snapshot(status, wallMs) {
      return {
        replyText: replies.join(''),
        toolCalls: [...toolCalls],
        completed,
        status,
        samplingCount,
        promptTokens,
        cachedPromptTokens,
        completionTokens,
        wallMs,
      };
    },
  };
}

async function waitForTerminal(
  observed: Observer,
  budgetMs: number,
): Promise<'completed' | 'interrupted' | 'errored' | 'timeout'> {
  const timeout = new Promise<'timeout'>((resolve) => {
    setTimeout(() => resolve('timeout'), budgetMs).unref?.();
  });
  return Promise.race([observed.waitForCompletion(), timeout]);
}
