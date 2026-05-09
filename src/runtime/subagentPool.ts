import type { EventBus } from '@harness/bus/eventBus.js';
import type { SessionStore } from '@harness/store/sessionStore.js';
import type { LlmProvider } from '@harness/llm/provider.js';
import type { MemoryStore } from '@harness/memory/types.js';
import type { SearchBackend } from '@harness/search/types.js';
import type { ToolRegistry } from '@harness/tools/registry.js';
import type { ToolExecutor } from '@harness/tools/executor.js';
import { newRootTraceparent } from '@harness/core/traceparent.js';
import { newEventId, newThreadId } from '@harness/core/ids.js';
import type { ThreadId, TurnId } from '@harness/core/ids.js';
import type {
  HarnessEvent,
  InterruptPayload,
  SubtaskCompletePayload,
} from '@harness/core/events.js';

import {
  AgentRunner,
  type RuntimeBudgetSnapshot,
  type SpawnRequestInfo,
  type TokenBudget,
} from './agentRunner.js';

/**
 * Subagent pool.
 *
 * `spawn` creates a child thread + AgentRunner sharing the parent's
 * bus/store/provider/registry, seeds it with a `user_turn_start`, and
 * returns its threadId. When the child emits `turn_complete`, the pool
 * translates it into a `subtask_complete` event on the *parent* thread
 * so the parent's AgentRunner can pick it up on its next tick.
 *
 * Budgets are enforced as hard caps:
 *   - maxTurns      → counted by sampling_complete events
 *   - maxToolCalls  → counted by tool_call events on the child thread
 *   - maxWallMs     → wall time since spawn
 *   - maxTokens     → cumulative prompt+completion tokens across all
 *                     sampling_complete events on the child thread
 *
 * When any cap trips, the pool publishes `interrupt` to the child;
 * the resulting turn_complete{interrupted} is rewritten to
 * subtask_complete{budget_exceeded}.
 *
 * Structural caps (maxDepth, maxSiblingsPerParent, maxConcurrentTotal)
 * are evaluated *at spawn time* and reject the spawn before any child
 * thread is created, by throwing `SpawnRefused`. Anti spawn-bomb / cost
 * runaway. The runner converts the rejection into a tool_result.ok=false
 * so the LLM sees a clear error and can retry with smaller scope.
 *
 * Parent → descendant interrupt propagation: when an interrupt fires on
 * any thread we track, every descendant child also gets interrupted so
 * orphan agents don't keep burning provider quota.
 */

export class SpawnRefused extends Error {
  constructor(readonly reason: string, message: string) {
    super(message);
    this.name = 'SpawnRefused';
  }
}

/**
 * Per-spawn provider factory. Receives the spawn request (so it can
 * read `cwd`, `providerSessionId`, etc.) and returns a fresh
 * `LlmProvider` for that one child. Factories typically build a
 * one-shot wrapper bound to the request's parameters; reuse across
 * spawns is a factory implementation detail.
 *
 * Registered under string keys (e.g. `'cc'`, `'codex'`); when the
 * spawn request carries `provider: 'cc'` and a matching factory is
 * present, the pool routes the child through it. Without a match,
 * spawn fails with `SpawnRefused('unknown_provider')`.
 *
 * The default `LlmProvider` (`SubagentPoolDeps.provider`) is used
 * when the spawn request omits `provider` — it stays the
 * orchestrator path.
 */
export type ProviderFactory = (req: SpawnRequestInfo) => LlmProvider;

export interface SubagentPoolDeps {
  bus: EventBus;
  store: SessionStore;
  registry: ToolRegistry;
  executor: ToolExecutor;
  provider: LlmProvider;
  /**
   * Optional per-key provider factories. Looked up by
   * `SpawnRequestInfo.provider`; absent or empty map = only the
   * default provider is reachable (current behaviour).
   */
  providerFactories?: Record<string, ProviderFactory>;
  systemPromptFor: (role: string | undefined) => string;
  /** Children share the parent's memory backend. */
  memory?: MemoryStore;
  /** Children share the parent's web search backend. */
  searchBackend?: SearchBackend;
  /** Provided to children so micro-compaction is consistent across the tree. */
  microCompact?: ConstructorParameters<typeof AgentRunner>[0]['microCompact'];
  /**
   * Hard-wall token budget applied to every spawned child runner. Per-spawn
   * override is not yet plumbed through `spawn`; this is the pool-wide
   * default.
   */
  tokenBudget?: TokenBudget;
  /**
   * Structural caps. Pre-flight check at `spawn` time. Each cap, when
   * exceeded, throws `SpawnRefused` so the runner can surface a tool
   * error instead of silently allowing a runaway spawn tree.
   *
   * - maxDepth: how deep the spawn tree can grow. Depth 1 = root spawns
   *   a child. Depth 2 = that child spawns a grandchild. Default
   *   undefined (no limit).
   * - maxSiblingsPerParent: how many concurrent direct children any
   *   single parent may have at once. Bounds fan-out per node.
   * - maxConcurrentTotal: how many child threads the pool may track at
   *   once across the entire tree. Bounds total in-flight work.
   */
  maxDepth?: number;
  maxSiblingsPerParent?: number;
  maxConcurrentTotal?: number;
}

/** Per-child budget. `maxTokens` is the cumulative prompt+completion
 * tokens across the child thread (mirrors the runner's
 * `tokenBudget.maxThreadTokens` framing but is enforced from the pool
 * so the child exits via the same `subtask_complete{budget_exceeded}`
 * path as the other dimensions). */
export interface ChildBudget {
  maxTurns?: number;
  maxToolCalls?: number;
  maxWallMs?: number;
  maxTokens?: number;
}

interface ChildRecord {
  runner: AgentRunner;
  parentThreadId: ThreadId;
  parentTurnId: TurnId;
  role?: string;
  /** Depth in the spawn tree; root spawns a child at depth 1. */
  depth: number;
  startedAt: number;
  budget: ChildBudget;
  turnsUsed: number;
  toolCallsUsed: number;
  tokensUsed: number;
  wallTimer?: ReturnType<typeof setTimeout>;
  budgetExceeded: boolean;
  exceededReason?: 'maxTurns' | 'maxToolCalls' | 'maxWallMs' | 'maxTokens';
  /**
   * The LlmProvider this child ran against. Held so we can read
   * provider-specific state (e.g. CodingAgentProvider.lastSessionId)
   * at child-exit time and surface it on `subtask_complete`.
   */
  provider: LlmProvider;
}

export class SubagentPool {
  private children = new Map<ThreadId, ChildRecord>();
  private subscribed = false;

  constructor(private readonly deps: SubagentPoolDeps) {}

  private ensureSubscribed(): void {
    if (this.subscribed) return;
    this.subscribed = true;
    // One global subscription. We need to see:
    //   - turn_complete on a child → translate to subtask_complete
    //   - sampling_complete on a child → maxTurns accounting
    //   - tool_call on a child → maxToolCalls accounting
    //   - interrupt on any tracked thread → propagate to descendants
    this.deps.bus.subscribe(
      (ev) => this.onEvent(ev),
      { kinds: ['turn_complete', 'sampling_complete', 'tool_call', 'interrupt'] },
    );
  }

  async spawn(req: SpawnRequestInfo): Promise<ThreadId> {
    this.ensureSubscribed();
    // Structural caps first: fail fast before we touch the store. Each
    // throws `SpawnRefused` so the runner can convert into a
    // tool_result.ok=false instead of leaking the exception.
    const parentDepth = this.depthOf(req.parentThreadId);
    const childDepth = parentDepth + 1;
    if (this.deps.maxDepth !== undefined && childDepth > this.deps.maxDepth) {
      throw new SpawnRefused(
        'maxDepth',
        `spawn rejected: depth ${childDepth} would exceed maxDepth=${this.deps.maxDepth}`,
      );
    }
    if (this.deps.maxSiblingsPerParent !== undefined) {
      const siblings = this.directChildrenOf(req.parentThreadId).length;
      if (siblings >= this.deps.maxSiblingsPerParent) {
        throw new SpawnRefused(
          'maxSiblingsPerParent',
          `spawn rejected: parent already has ${siblings} live children (cap=${this.deps.maxSiblingsPerParent})`,
        );
      }
    }
    if (this.deps.maxConcurrentTotal !== undefined) {
      if (this.children.size >= this.deps.maxConcurrentTotal) {
        throw new SpawnRefused(
          'maxConcurrentTotal',
          `spawn rejected: ${this.children.size} children already live (cap=${this.deps.maxConcurrentTotal})`,
        );
      }
    }

    // Resolve provider before any side effects so an unknown-key spawn
    // doesn't leave a half-created thread behind.
    const childProvider = this.resolveProvider(req);

    const childThreadId = req.childThreadId ?? newThreadId();
    const traceparent = req.parentTraceparent ?? newRootTraceparent();
    await this.deps.store.createThread({
      id: childThreadId,
      rootTraceparent: traceparent,
      parentThreadId: req.parentThreadId,
      ...(req.role !== undefined ? { title: req.role } : {}),
    });

    const seed = await this.deps.store.append({
      threadId: childThreadId,
      kind: 'user_turn_start',
      payload: { text: req.task },
    });

    const systemPrompt = withBudgetGuidance(this.deps.systemPromptFor(req.role), req.budget);
    const runner = new AgentRunner({
      threadId: childThreadId,
      bus: this.deps.bus,
      store: this.deps.store,
      registry: this.deps.registry,
      executor: this.deps.executor,
      provider: childProvider,
      systemPrompt,
      ...(this.deps.memory !== undefined ? { memory: this.deps.memory } : {}),
      ...(this.deps.searchBackend !== undefined
        ? { searchBackend: this.deps.searchBackend }
        : {}),
      ...(this.deps.microCompact !== undefined ? { microCompact: this.deps.microCompact } : {}),
      ...(this.deps.tokenBudget !== undefined ? { tokenBudget: this.deps.tokenBudget } : {}),
      ...(req.contextRefs !== undefined && req.contextRefs.length > 0
        ? { contextRefs: req.contextRefs }
        : {}),
      runtimeBudgetSnapshot: () => this.runtimeBudgetSnapshotFor(childThreadId),
      onSpawn: (inner) => this.spawn(inner),
    });
    runner.start();

    const record: ChildRecord = {
      runner,
      parentThreadId: req.parentThreadId,
      parentTurnId: req.parentTurnId,
      ...(req.role !== undefined ? { role: req.role } : {}),
      depth: childDepth,
      startedAt: Date.now(),
      budget: (req.budget ?? {}) as ChildBudget,
      turnsUsed: 0,
      toolCallsUsed: 0,
      tokensUsed: 0,
      budgetExceeded: false,
      provider: childProvider,
    };
    if (record.budget.maxWallMs && record.budget.maxWallMs > 0) {
      record.wallTimer = setTimeout(
        () => this.tripBudget(childThreadId, 'maxWallMs'),
        record.budget.maxWallMs,
      );
    }
    this.children.set(childThreadId, record);

    // Nudge the child runner by publishing the seed event.
    this.deps.bus.publish(seed);
    return childThreadId;
  }

  private async onEvent(event: HarnessEvent): Promise<void> {
    switch (event.kind) {
      case 'sampling_complete':
        return this.onSamplingComplete(event.threadId, event);
      case 'tool_call':
        return this.onToolCall(event.threadId);
      case 'interrupt':
        return this.onInterrupt(event.threadId);
      case 'turn_complete':
        return this.onTurnComplete(event);
      default:
        return;
    }
  }

  private onSamplingComplete(threadId: ThreadId, ev: HarnessEvent): void {
    const r = this.children.get(threadId);
    if (!r || r.budgetExceeded) return;
    r.turnsUsed += 1;
    const usage = ev.payload as { promptTokens: number; completionTokens: number };
    r.tokensUsed += (usage.promptTokens ?? 0) + (usage.completionTokens ?? 0);
    if (r.budget.maxTurns !== undefined && r.turnsUsed >= r.budget.maxTurns) {
      this.tripBudget(threadId, 'maxTurns');
      return;
    }
    if (r.budget.maxTokens !== undefined && r.tokensUsed >= r.budget.maxTokens) {
      this.tripBudget(threadId, 'maxTokens');
    }
  }

  private onToolCall(threadId: ThreadId): void {
    const r = this.children.get(threadId);
    if (!r || r.budgetExceeded) return;
    r.toolCallsUsed += 1;
    if (r.budget.maxToolCalls !== undefined && r.toolCallsUsed > r.budget.maxToolCalls) {
      this.tripBudget(threadId, 'maxToolCalls');
    }
  }

  private tripBudget(
    threadId: ThreadId,
    reason: 'maxTurns' | 'maxToolCalls' | 'maxWallMs' | 'maxTokens',
  ): void {
    const r = this.children.get(threadId);
    if (!r || r.budgetExceeded) return;
    r.budgetExceeded = true;
    r.exceededReason = reason;
    this.publishInterrupt(threadId, `budget:${reason}`);
  }

  private onInterrupt(threadId: ThreadId): void {
    // Propagate to descendants. We collect the descendant set first so
    // we don't republish to the original sender.
    const descendants = this.descendantsOf(threadId);
    for (const child of descendants) {
      this.publishInterrupt(child, 'parent_interrupt');
    }
  }

  private depthOf(threadId: ThreadId): number {
    // The given thread is itself a "node" in the spawn tree; if it's
    // tracked, its `depth` is authoritative. If it's not tracked, it's
    // a root (parent that was never a child of this pool), depth 0.
    const r = this.children.get(threadId);
    return r ? r.depth : 0;
  }

  private directChildrenOf(parentThreadId: ThreadId): ChildRecord[] {
    const out: ChildRecord[] = [];
    for (const r of this.children.values()) {
      if (r.parentThreadId === parentThreadId) out.push(r);
    }
    return out;
  }

  private descendantsOf(threadId: ThreadId): ThreadId[] {
    const out: ThreadId[] = [];
    const queue: ThreadId[] = [threadId];
    while (queue.length > 0) {
      const cur = queue.shift();
      if (cur === undefined) break;
      for (const [childId, rec] of this.children) {
        if (rec.parentThreadId === cur) {
          out.push(childId);
          queue.push(childId);
        }
      }
    }
    return out;
  }

  private publishInterrupt(threadId: ThreadId, reason: string): void {
    const ev: HarnessEvent = {
      id: newEventId(),
      threadId,
      kind: 'interrupt',
      payload: { reason } satisfies InterruptPayload,
      createdAt: new Date().toISOString(),
    } as HarnessEvent;
    // Persist + publish so the runner picks it up via its bus filter.
    void this.deps.store.append(ev).then(() => this.deps.bus.publish(ev));
  }

  private runtimeBudgetSnapshotFor(threadId: ThreadId): RuntimeBudgetSnapshot | undefined {
    const r = this.children.get(threadId);
    if (!r) return undefined;
    const wallMs = Math.max(0, Date.now() - r.startedAt);
    return {
      caps: { ...r.budget },
      used: {
        turns: r.turnsUsed,
        toolCalls: r.toolCallsUsed,
        wallMs,
        tokens: r.tokensUsed,
      },
      remaining: {
        ...(r.budget.maxTurns !== undefined
          ? { turns: Math.max(0, r.budget.maxTurns - r.turnsUsed) }
          : {}),
        ...(r.budget.maxToolCalls !== undefined
          ? { toolCalls: Math.max(0, r.budget.maxToolCalls - r.toolCallsUsed) }
          : {}),
        ...(r.budget.maxWallMs !== undefined
          ? { wallMs: Math.max(0, r.budget.maxWallMs - wallMs) }
          : {}),
        ...(r.budget.maxTokens !== undefined
          ? { tokens: Math.max(0, r.budget.maxTokens - r.tokensUsed) }
          : {}),
      },
    };
  }

  private resolveProvider(req: SpawnRequestInfo): LlmProvider {
    if (req.provider === undefined) return this.deps.provider;
    const factory = this.deps.providerFactories?.[req.provider];
    if (!factory) {
      throw new SpawnRefused(
        'unknown_provider',
        `spawn rejected: provider '${req.provider}' is not registered`,
      );
    }
    try {
      return factory(req);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new SpawnRefused(
        'provider_factory_failed',
        `spawn rejected: provider factory '${req.provider}' threw: ${message}`,
      );
    }
  }

  private async onTurnComplete(event: HarnessEvent): Promise<void> {
    const record = this.children.get(event.threadId);
    if (!record) return; // not one of our children
    this.children.delete(event.threadId);
    if (record.wallTimer) clearTimeout(record.wallTimer);

    const p = event.payload as { status: string; summary?: string; reason?: string };
    let status: SubtaskCompletePayload['status'];
    if (record.budgetExceeded) {
      status = 'budget_exceeded';
    } else if (p.status === 'completed') {
      status = 'completed';
    } else if (p.status === 'errored') {
      status = 'errored';
    } else {
      status = 'interrupted';
    }

    const summary =
      p.summary ??
      (record.budgetExceeded
        ? `budget exceeded (${record.exceededReason}); turns=${record.turnsUsed} toolCalls=${record.toolCallsUsed} tokens=${record.tokensUsed}`
        : undefined);

    // Coding-agent providers expose `lastSessionId` on themselves so
    // we can surface the cc / codex session token without leaking
    // provider-specific types into SubagentPool. Anything without
    // that field returns undefined and the optional payload key is
    // dropped.
    const providerSessionId = readProviderSessionId(record.provider);

    const evOut: HarnessEvent = {
      id: newEventId(),
      threadId: record.parentThreadId,
      turnId: record.parentTurnId,
      kind: 'subtask_complete',
      payload: {
        childThreadId: event.threadId,
        status,
        ...(summary !== undefined ? { summary } : {}),
        ...(providerSessionId !== undefined ? { providerSessionId } : {}),
        ...(record.budgetExceeded
          ? {
              reason: `budget:${record.exceededReason}`,
              budget: {
                reason: record.exceededReason!,
                turnsUsed: record.turnsUsed,
                toolCallsUsed: record.toolCallsUsed,
                tokensUsed: record.tokensUsed,
              },
            }
          : p.reason !== undefined
            ? { reason: p.reason }
            : {}),
      } satisfies SubtaskCompletePayload,
      createdAt: new Date().toISOString(),
    } as HarnessEvent;

    await this.deps.store.append(evOut);
    this.deps.bus.publish(evOut);
  }

  get childCount(): number {
    return this.children.size;
  }
}

function readProviderSessionId(provider: LlmProvider): string | undefined {
  // Duck-type the optional field. CodingAgentProvider sets
  // `lastSessionId` directly on the instance; other providers
  // (OpenAI, scripted test providers) leave it undefined.
  const v = (provider as { lastSessionId?: unknown }).lastSessionId;
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

function withBudgetGuidance(systemPrompt: string, budget: ChildBudget): string {
  if (!hasBudgetCaps(budget)) return systemPrompt;
  const caps = [
    budget.maxTurns !== undefined ? `maxTurns=${budget.maxTurns}` : undefined,
    budget.maxToolCalls !== undefined ? `maxToolCalls=${budget.maxToolCalls}` : undefined,
    budget.maxWallMs !== undefined ? `maxWallMs=${budget.maxWallMs}` : undefined,
    budget.maxTokens !== undefined ? `maxTokens=${budget.maxTokens}` : undefined,
  ].filter((v): v is string => v !== undefined);
  return [
    systemPrompt,
    [
      '[subagent budget]',
      `Hard caps: ${caps.join(', ')}.`,
      'Plan before acting. If the task is larger than the remaining budget, produce the best partial conclusion you can before the cap fires.',
      'Prefer a concise conclusion over extra exploration when close to budget limits.',
    ].join('\n'),
  ].join('\n\n');
}

function hasBudgetCaps(budget: ChildBudget): boolean {
  return (
    budget.maxTurns !== undefined ||
    budget.maxToolCalls !== undefined ||
    budget.maxWallMs !== undefined ||
    budget.maxTokens !== undefined
  );
}
