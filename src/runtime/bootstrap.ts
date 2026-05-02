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

import type { MicroCompactorOptions } from '@harness/context/microCompactor.js';
import {
  CompactionTrigger,
  type CompactionTriggerOptions,
} from '@harness/context/compactionTrigger.js';
import {
  CompactionHandler,
  type CompactionHandlerOptions,
} from '@harness/context/compactionHandler.js';
import type { Compactor } from '@harness/context/compactor.js';
import { SubagentCompactor } from '@harness/context/subagentCompactor.js';
import { InMemoryStore } from '@harness/memory/inMemoryStore.js';
import type { MemoryStore } from '@harness/memory/types.js';
import type { SearchBackend } from '@harness/search/types.js';

import { AgentRunner, type TokenBudget } from './agentRunner.js';
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
   * Memory backend. Defaults to a fresh InMemoryStore (process-scoped,
   * lost on exit). Pass a persistent backend (JSONL, mem0, …) for
   * cross-session memory.
   */
  memory?: MemoryStore;
  /**
   * Web search backend. Off when undefined; the `web_search` tool
   * returns `unsupported` so the model knows search is disabled.
   */
  searchBackend?: SearchBackend;
  /**
   * Hot-path micro-compaction options. Pass `false` to disable.
   * When omitted, defaults are used (keepRecent=20, triggerEvery=10).
   */
  microCompact?: MicroCompactorOptions | false;
  /**
   * Diagnostic sinks. Each sees every bus event and the prompt hook.
   */
  diagSinks?: DiagSink[];
  /**
   * Hard-wall token caps for the root runner. Subagents inherit through
   * the pool's `subagentTokenBudget` (separate option).
   */
  tokenBudget?: TokenBudget;
  /**
   * Hard-wall token caps applied to every spawned subagent. Per-spawn
   * override is not yet plumbed through `spawn`; this is the global
   * default for children of this runtime.
   */
  subagentTokenBudget?: TokenBudget;
  /**
   * Structural caps on the spawn tree. See SubagentPoolDeps for shape.
   * Keeping these undefined gives the existing unbounded behaviour;
   * for any production / long-running setup at least `maxDepth` and
   * `maxConcurrentTotal` should be set.
   */
  subagentMaxDepth?: number;
  subagentMaxSiblingsPerParent?: number;
  subagentMaxConcurrentTotal?: number;
  /**
   * Cold-path compaction trigger. When set, the runtime watches
   * sampling_complete events and publishes `compact_request` once the
   * projection's estimatedTokens crosses the threshold. The trigger is a
   * mechanism only — actual compaction handling lives in the runner /
   * compactor stack.
   */
  compactionTrigger?: CompactionTriggerOptions;
  /**
   * Cold-path compaction handler. Defaults to a `CompactionHandler` with
   * the `StaticCompactor` strategy whenever `compactionTrigger` is set,
   * so threshold crossings always have a consumer that emits
   * `compaction_event` and clears the trigger's cooldown. Pass
   * explicit options to override the strategy (e.g. inject a
   * subagent-backed Compactor) or to install a handler without a
   * trigger.
   */
  compactionHandler?: CompactionHandlerOptions;
  /**
   * If set, the bootstrap installs a `SubagentCompactor` (provider-backed,
   * isolated thread, falls back to `StaticCompactor` on failure) as the
   * cold-path strategy. `true` keeps the defaults; an object overrides
   * `systemPrompt` / `timeoutMs` / `fallback`. Ignored when
   * `compactionHandler.compactor` is already supplied — explicit caller
   * choice wins.
   */
  useSubagentCompactor?:
    | boolean
    | { systemPrompt?: string; timeoutMs?: number; fallback?: Compactor };
}

export interface Runtime {
  bus: EventBus;
  store: SessionStore;
  memory: MemoryStore;
  registry: ToolRegistry;
  executor: ToolExecutor;
  provider: LlmProvider;
  subagents: SubagentPool;
  rootThreadId: ThreadId;
  runner: AgentRunner;
  searchBackend?: SearchBackend;
  diag?: { stop: () => Promise<void> };
  /** Cold-path compaction trigger (only present if `compactionTrigger` opt was passed). */
  compactionTrigger?: CompactionTrigger;
  /** Cold-path compaction handler (auto-installed alongside the trigger). */
  compactionHandler?: CompactionHandler;
}

export async function bootstrap(opts: BootstrapOptions): Promise<Runtime> {
  const bus = new EventBus();
  const store: SessionStore = opts.storeRoot
    ? new JsonlSessionStore({ root: opts.storeRoot })
    : new MemorySessionStore();
  const registry = opts.registry ?? createDefaultRegistry();
  const executor = new ToolExecutor(registry);
  const memory: MemoryStore = opts.memory ?? new InMemoryStore();

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
    memory,
    ...(opts.searchBackend !== undefined ? { searchBackend: opts.searchBackend } : {}),
    ...(opts.microCompact !== undefined ? { microCompact: opts.microCompact } : {}),
    ...(opts.subagentTokenBudget !== undefined
      ? { tokenBudget: opts.subagentTokenBudget }
      : {}),
    ...(opts.subagentMaxDepth !== undefined ? { maxDepth: opts.subagentMaxDepth } : {}),
    ...(opts.subagentMaxSiblingsPerParent !== undefined
      ? { maxSiblingsPerParent: opts.subagentMaxSiblingsPerParent }
      : {}),
    ...(opts.subagentMaxConcurrentTotal !== undefined
      ? { maxConcurrentTotal: opts.subagentMaxConcurrentTotal }
      : {}),
  });

  const runner = new AgentRunner({
    threadId: rootThreadId,
    bus,
    store,
    registry,
    executor,
    provider: opts.provider,
    systemPrompt: opts.systemPrompt,
    memory,
    ...(opts.searchBackend !== undefined ? { searchBackend: opts.searchBackend } : {}),
    ...(opts.pinnedMemory !== undefined ? { pinnedMemory: opts.pinnedMemory } : {}),
    ...(opts.microCompact !== undefined ? { microCompact: opts.microCompact } : {}),
    ...(opts.tokenBudget !== undefined ? { tokenBudget: opts.tokenBudget } : {}),
    ...(onPromptBuilt !== undefined ? { onPromptBuilt } : {}),
    onSpawn: (req) => subagents.spawn(req),
  });
  runner.start();

  let compactionTrigger: CompactionTrigger | undefined;
  if (opts.compactionTrigger) {
    compactionTrigger = new CompactionTrigger(opts.compactionTrigger);
    compactionTrigger.start(bus, store);
  }

  // Install a cold-path handler whenever a trigger is present (so the
  // request actually has a consumer) or when the caller explicitly
  // asks for one. Without this, threshold crossings would publish
  // compact_request and nobody would pick it up — the cooldown would
  // fire once and then stay silent forever.
  let compactionHandler: CompactionHandler | undefined;
  if (opts.compactionHandler !== undefined || compactionTrigger !== undefined) {
    const handlerOpts: CompactionHandlerOptions = { ...(opts.compactionHandler ?? {}) };
    if (handlerOpts.compactor === undefined && opts.useSubagentCompactor) {
      const overrides =
        typeof opts.useSubagentCompactor === 'object' ? opts.useSubagentCompactor : {};
      handlerOpts.compactor = new SubagentCompactor({
        bus,
        store,
        provider: opts.provider,
        ...(overrides.systemPrompt !== undefined ? { systemPrompt: overrides.systemPrompt } : {}),
        ...(overrides.timeoutMs !== undefined ? { timeoutMs: overrides.timeoutMs } : {}),
        ...(overrides.fallback !== undefined ? { fallback: overrides.fallback } : {}),
      });
    }
    if (compactionTrigger !== undefined) handlerOpts.trigger = compactionTrigger;
    compactionHandler = new CompactionHandler(handlerOpts);
    compactionHandler.start(bus, store);
  }

  return {
    bus,
    store,
    memory,
    registry,
    executor,
    provider: opts.provider,
    subagents,
    rootThreadId,
    runner,
    ...(opts.searchBackend !== undefined ? { searchBackend: opts.searchBackend } : {}),
    ...(diag !== undefined ? { diag } : {}),
    ...(compactionTrigger !== undefined ? { compactionTrigger } : {}),
    ...(compactionHandler !== undefined ? { compactionHandler } : {}),
  };
}
