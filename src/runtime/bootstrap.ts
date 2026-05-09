import { newRootTraceparent } from '@harness/core/traceparent.js';
import { newThreadId } from '@harness/core/ids.js';
import type { ThreadId } from '@harness/core/ids.js';
import { EventBus } from '@harness/bus/eventBus.js';
import { StreamBus } from '@harness/bus/streamBus.js';
import { MemorySessionStore, JsonlSessionStore } from '@harness/store/index.js';
import type { SessionStore } from '@harness/store/sessionStore.js';
import { createDefaultRegistry } from '@harness/tools/index.js';
import type { ToolRegistry } from '@harness/tools/registry.js';
import { ToolExecutor } from '@harness/tools/executor.js';
import type { LlmProvider } from '@harness/llm/provider.js';
import {
  CodingAgentProvider,
  type CodingAgentKind,
  type CodingAgentProviderOptions,
} from '@harness/llm/codingAgentProvider.js';
import { ProviderUsageRegistry } from '@harness/llm/providerUsageRegistry.js';
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

import { AgentRunner, type SpawnRequestInfo, type TokenBudget } from './agentRunner.js';
import { SubagentPool, type ProviderFactory } from './subagentPool.js';

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
  /**
   * Per-key `LlmProvider` factories registered with `SubagentPool`. The
   * spawning LLM picks one by passing `provider: '<key>'` in its
   * `spawn` call; the pool builds a one-shot provider instance per
   * spawn from the matching factory. Caller-supplied factories take
   * precedence over the built-in coding-agent factories below — set
   * the same key to override.
   */
  providerFactories?: Record<string, ProviderFactory>;
  /**
   * Coding-agent factories (cc, codex). When `true` (the default for
   * the corresponding key), the bootstrap registers a factory that
   * builds a `CodingAgentProvider` per spawn against the requested
   * `cwd` / `providerSessionId`. Passing options narrows the binary
   * path / model / extra args. Passing `false` disables that key
   * (no factory registered, spawn fails fast with `unknown_provider`).
   *
   * Auth flows through the CLI's own credential cache — there is no
   * harness-level token. Set the binary's expected env (e.g.
   * `ANTHROPIC_API_KEY` for cc, or rely on cc's interactive login)
   * via the runtime environment or the factory's `env` override.
   */
  codingAgents?: {
    cc?: boolean | Partial<Omit<CodingAgentProviderOptions, 'kind' | 'cwd' | 'providerSessionId'>>;
    codex?: boolean | Partial<Omit<CodingAgentProviderOptions, 'kind' | 'cwd' | 'providerSessionId'>>;
  };
}

export interface Runtime {
  bus: EventBus;
  streamBus: StreamBus;
  store: SessionStore;
  memory: MemoryStore;
  registry: ToolRegistry;
  executor: ToolExecutor;
  provider: LlmProvider;
  /** Account-level snapshots reported by coding-agent providers. */
  providerUsageRegistry: ProviderUsageRegistry;
  subagents: SubagentPool;
  rootThreadId: ThreadId;
  runner: AgentRunner;
  createRootThread(input?: { title?: string }): Promise<ThreadId>;
  /**
   * Ensure a runner is running for an existing thread (replays events
   * from the store first). No-op if a runner is already attached.
   * Used by adapters that restore channel→thread mappings on startup.
   */
  adoptRootThread(threadId: ThreadId): Promise<void>;
  searchBackend?: SearchBackend;
  diag?: { stop: () => Promise<void> };
  /** Cold-path compaction trigger (only present if `compactionTrigger` opt was passed). */
  compactionTrigger?: CompactionTrigger;
  /** Cold-path compaction handler (auto-installed alongside the trigger). */
  compactionHandler?: CompactionHandler;
}

export async function bootstrap(opts: BootstrapOptions): Promise<Runtime> {
  const bus = new EventBus();
  const streamBus = new StreamBus();
  const store: SessionStore = opts.storeRoot
    ? new JsonlSessionStore({ root: opts.storeRoot })
    : new MemorySessionStore();
  const registry = opts.registry ?? createDefaultRegistry();
  const executor = new ToolExecutor(registry);
  const memory: MemoryStore = opts.memory ?? new InMemoryStore();
  const providerUsageRegistry = new ProviderUsageRegistry();

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

  const providerFactories = buildProviderFactories(opts, providerUsageRegistry);

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
    ...(Object.keys(providerFactories).length > 0
      ? { providerFactories }
      : {}),
  });

  const rootRunners = new Map<ThreadId, AgentRunner>();
  const buildRootRunner = (threadId: ThreadId): AgentRunner => {
    const runner = new AgentRunner({
      threadId,
      bus,
      streamBus,
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
      providerUsageRegistry,
      onSpawn: (req) => subagents.spawn(req),
    });
    rootRunners.set(threadId, runner);
    return runner;
  };
  const startRootRunner = (threadId: ThreadId): AgentRunner => {
    const runner = buildRootRunner(threadId);
    runner.start();
    return runner;
  };
  const adoptRootThread = async (threadId: ThreadId): Promise<void> => {
    if (rootRunners.has(threadId)) return;
    const runner = buildRootRunner(threadId);
    await runner.hydrateFromStore();
    runner.start();
  };

  const runner = startRootRunner(rootThreadId);

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
    streamBus,
    store,
    memory,
    registry,
    executor,
    provider: opts.provider,
    providerUsageRegistry,
    subagents,
    rootThreadId,
    runner,
    createRootThread: async (input) => {
      const threadId = newThreadId();
      await store.createThread({
        id: threadId,
        rootTraceparent: newRootTraceparent(),
        ...(input?.title !== undefined ? { title: input.title } : {}),
      });
      startRootRunner(threadId);
      return threadId;
    },
    adoptRootThread,
    ...(opts.searchBackend !== undefined ? { searchBackend: opts.searchBackend } : {}),
    ...(diag !== undefined ? { diag } : {}),
    ...(compactionTrigger !== undefined ? { compactionTrigger } : {}),
    ...(compactionHandler !== undefined ? { compactionHandler } : {}),
  };
}

/**
 * Build the per-key `LlmProvider` factory map handed to `SubagentPool`.
 *
 * Order: caller-supplied `providerFactories` win, then built-in
 * coding-agent factories (cc, codex) for keys the caller hasn't
 * already claimed and that are enabled in `codingAgents`.
 *
 * Each coding-agent factory closes over the requested `cwd` /
 * `providerSessionId` to build a one-shot `CodingAgentProvider`.
 * `cwd` is mandatory for these backends — missing it throws so the
 * pool surfaces `unknown_provider`-style `tool_result.ok=false` to
 * the calling LLM rather than silently spawning in the harness's own
 * working directory.
 */
function buildProviderFactories(
  opts: BootstrapOptions,
  usageRegistry: ProviderUsageRegistry,
): Record<string, ProviderFactory> {
  const out: Record<string, ProviderFactory> = {};

  const enabled = (
    cfg: BootstrapOptions['codingAgents'] extends infer C
      ? C extends Record<string, unknown>
        ? C[keyof C]
        : never
      : never,
  ): boolean => cfg !== false;
  const optionsFrom = (
    cfg: unknown,
  ): Partial<Omit<CodingAgentProviderOptions, 'kind' | 'cwd' | 'providerSessionId'>> =>
    cfg && typeof cfg === 'object'
      ? (cfg as Partial<Omit<CodingAgentProviderOptions, 'kind' | 'cwd' | 'providerSessionId'>>)
      : {};

  const codingFactory =
    (kind: CodingAgentKind, base: Partial<Omit<CodingAgentProviderOptions, 'kind' | 'cwd' | 'providerSessionId'>>): ProviderFactory =>
    (req: SpawnRequestInfo) => {
      if (req.cwd === undefined) {
        throw new Error(`provider '${kind}' requires \`cwd\` on spawn`);
      }
      return new CodingAgentProvider({
        kind,
        cwd: req.cwd,
        ...base,
        ...(req.providerSessionId !== undefined
          ? { providerSessionId: req.providerSessionId }
          : {}),
        usageRegistry,
      });
    };

  const builtins: Array<{ key: CodingAgentKind; cfg: unknown }> = [
    { key: 'cc', cfg: opts.codingAgents?.cc ?? true },
    { key: 'codex', cfg: opts.codingAgents?.codex ?? false }, // codex parity lands in M6
  ];
  for (const { key, cfg } of builtins) {
    if (!enabled(cfg as never)) continue;
    out[key] = codingFactory(key, optionsFrom(cfg));
  }

  // Caller overrides win.
  if (opts.providerFactories) {
    for (const [k, v] of Object.entries(opts.providerFactories)) {
      out[k] = v;
    }
  }

  return out;
}
