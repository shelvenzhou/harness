import {
  attachDiag,
  composePromptHook,
  type DiagSink,
} from '@harness/diag/index.js';
import {
  CompactionTrigger,
  type CompactionTriggerOptions,
} from '@harness/context/compactionTrigger.js';
import type { MicroCompactorOptions } from '@harness/context/microCompactor.js';
import type { ThreadId } from '@harness/core/ids.js';
import type { LlmProvider } from '@harness/llm/provider.js';
import { InMemoryStore } from '@harness/memory/inMemoryStore.js';
import type { MemoryStore } from '@harness/memory/types.js';
import { EventBus } from '@harness/bus/eventBus.js';
import { JsonlSessionStore } from '@harness/store/index.js';
import { createDefaultRegistry } from '@harness/tools/index.js';
import { ToolExecutor } from '@harness/tools/executor.js';
import type { ToolRegistry } from '@harness/tools/registry.js';

import { AgentRunner, type TokenBudget } from './agentRunner.js';
import { SubagentPool } from './subagentPool.js';
import type { Runtime } from './bootstrap.js';

/**
 * Resume an existing thread from disk.
 *
 * Reads `<storeRoot>/<threadId>/{meta.json,events.jsonl}` and constructs
 * a runtime bound to that thread. The runner's token counters are
 * rehydrated from the store so the hard-wall budget is accurate across
 * process restarts; activeTurn is *not* reconstructed — a fresh
 * user_turn_start drives the next turn as usual. This is the simplest
 * useful semantics; mid-turn resume (rebuilding pending tool calls) is
 * out of scope and can land later.
 *
 * Children (subagent threads) are not auto-resumed: only the named root
 * gets a runner. Their event logs survive on disk; resume them
 * individually if the caller cares.
 */

export interface ResumeOptions {
  provider: LlmProvider;
  systemPrompt: string;
  /** Where the JSONL store lives. Required for resume. */
  storeRoot: string;
  /** Thread to resume. Must exist under storeRoot. */
  threadId: ThreadId;
  registry?: ToolRegistry;
  pinnedMemory?: string[];
  memory?: MemoryStore;
  microCompact?: MicroCompactorOptions | false;
  diagSinks?: DiagSink[];
  tokenBudget?: TokenBudget;
  subagentTokenBudget?: TokenBudget;
  compactionTrigger?: CompactionTriggerOptions;
}

export async function resume(opts: ResumeOptions): Promise<Runtime> {
  const bus = new EventBus();
  const store = new JsonlSessionStore({ root: opts.storeRoot });
  const thread = await store.getThread(opts.threadId);
  if (!thread) {
    throw new Error(
      `resume: thread ${opts.threadId} not found under ${opts.storeRoot}`,
    );
  }

  const registry = opts.registry ?? createDefaultRegistry();
  const executor = new ToolExecutor(registry);
  const memory: MemoryStore = opts.memory ?? new InMemoryStore();

  const diag =
    opts.diagSinks && opts.diagSinks.length > 0
      ? attachDiag({ bus, sinks: opts.diagSinks })
      : undefined;
  const onPromptBuilt =
    opts.diagSinks && opts.diagSinks.length > 0
      ? composePromptHook(opts.diagSinks)
      : undefined;

  const subagents = new SubagentPool({
    bus,
    store,
    registry,
    executor,
    provider: opts.provider,
    systemPromptFor: (role) =>
      role ? `${opts.systemPrompt}\n\n[role: ${role}]` : opts.systemPrompt,
    memory,
    ...(opts.microCompact !== undefined ? { microCompact: opts.microCompact } : {}),
    ...(opts.subagentTokenBudget !== undefined
      ? { tokenBudget: opts.subagentTokenBudget }
      : {}),
  });

  const runner = new AgentRunner({
    threadId: opts.threadId,
    bus,
    store,
    registry,
    executor,
    provider: opts.provider,
    systemPrompt: opts.systemPrompt,
    memory,
    ...(opts.pinnedMemory !== undefined ? { pinnedMemory: opts.pinnedMemory } : {}),
    ...(opts.microCompact !== undefined ? { microCompact: opts.microCompact } : {}),
    ...(opts.tokenBudget !== undefined ? { tokenBudget: opts.tokenBudget } : {}),
    ...(onPromptBuilt !== undefined ? { onPromptBuilt } : {}),
    onSpawn: (req) => subagents.spawn(req),
  });
  await runner.hydrateFromStore();
  runner.start();

  let compactionTrigger: CompactionTrigger | undefined;
  if (opts.compactionTrigger) {
    compactionTrigger = new CompactionTrigger(opts.compactionTrigger);
    compactionTrigger.start(bus, store);
  }

  return {
    bus,
    store,
    memory,
    registry,
    executor,
    provider: opts.provider,
    subagents,
    rootThreadId: opts.threadId,
    runner,
    ...(diag !== undefined ? { diag } : {}),
    ...(compactionTrigger !== undefined ? { compactionTrigger } : {}),
  };
}
