import { newRootTraceparent } from '@harness/core/traceparent.js';
import { newThreadId } from '@harness/core/ids.js';
import type { ThreadId } from '@harness/core/ids.js';
import { EventBus } from '@harness/bus/eventBus.js';
import { MemorySessionStore, JsonlSessionStore } from '@harness/store/index.js';
import type { SessionStore } from '@harness/store/sessionStore.js';
import { createDefaultRegistry } from '@harness/tools/index.js';
import type { ToolRegistry } from '@harness/tools/registry.js';
import { ToolExecutor } from '@harness/tools/executor.js';
import type { LlmProvider } from '@harness/llm/provider.js';
import {
  attachDiag,
  composePromptHook,
  type DiagSink,
} from '@harness/diag/index.js';

import { AgentRunner } from './agentRunner.js';
import { SubagentPool } from './subagentPool.js';

/**
 * Convenience bootstrap: wire a full runtime (bus, store, registry,
 * executor, provider, subagent pool, one root thread + runner) and
 * return the pieces the caller still needs (bus + threadId for adapters).
 *
 * Everything the adapter or the CLI touches goes through this.
 */

export interface BootstrapOptions {
  provider: LlmProvider;
  systemPrompt: string;
  /**
   * If set, events are persisted to <storeRoot>/<threadId>/events.jsonl in
   * addition to the in-memory store; otherwise the store is purely
   * in-memory (fine for short-lived REPL sessions).
   */
  storeRoot?: string;
  registry?: ToolRegistry;
  pinnedMemory?: string[];
  /**
   * Diagnostic sinks. Each sees every bus event and the prompt hook.
   */
  diagSinks?: DiagSink[];
}

export interface Runtime {
  bus: EventBus;
  store: SessionStore;
  registry: ToolRegistry;
  executor: ToolExecutor;
  provider: LlmProvider;
  subagents: SubagentPool;
  rootThreadId: ThreadId;
  runner: AgentRunner;
  diag?: { stop: () => Promise<void> };
}

export async function bootstrap(opts: BootstrapOptions): Promise<Runtime> {
  const bus = new EventBus();
  const store: SessionStore = opts.storeRoot
    ? new JsonlSessionStore({ root: opts.storeRoot })
    : new MemorySessionStore();
  const registry = opts.registry ?? createDefaultRegistry();
  const executor = new ToolExecutor(registry);

  const rootThreadId = newThreadId();
  await store.createThread({
    id: rootThreadId,
    rootTraceparent: newRootTraceparent(),
  });

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
  });

  const runner = new AgentRunner({
    threadId: rootThreadId,
    bus,
    store,
    registry,
    executor,
    provider: opts.provider,
    systemPrompt: opts.systemPrompt,
    ...(opts.pinnedMemory !== undefined ? { pinnedMemory: opts.pinnedMemory } : {}),
    ...(onPromptBuilt !== undefined ? { onPromptBuilt } : {}),
    onSpawn: (req) => subagents.spawn(req),
  });
  runner.start();

  return {
    bus,
    store,
    registry,
    executor,
    provider: opts.provider,
    subagents,
    rootThreadId,
    runner,
    ...(diag !== undefined ? { diag } : {}),
  };
}
