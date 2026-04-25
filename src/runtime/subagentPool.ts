import type { EventBus } from '@harness/bus/eventBus.js';
import type { SessionStore } from '@harness/store/sessionStore.js';
import type { LlmProvider } from '@harness/llm/provider.js';
import type { MemoryStore } from '@harness/memory/types.js';
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

import { AgentRunner, type SpawnRequestInfo } from './agentRunner.js';

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
 *
 * When any cap trips, the pool publishes `interrupt` to the child;
 * the resulting turn_complete{interrupted} is rewritten to
 * subtask_complete{budget_exceeded}.
 *
 * Parent → descendant interrupt propagation: when an interrupt fires on
 * any thread we track, every descendant child also gets interrupted so
 * orphan agents don't keep burning provider quota.
 */

export interface SubagentPoolDeps {
  bus: EventBus;
  store: SessionStore;
  registry: ToolRegistry;
  executor: ToolExecutor;
  provider: LlmProvider;
  systemPromptFor: (role: string | undefined) => string;
  /** Children share the parent's memory backend. */
  memory?: MemoryStore;
  /** Provided to children so micro-compaction is consistent across the tree. */
  microCompact?: ConstructorParameters<typeof AgentRunner>[0]['microCompact'];
}

interface ChildRecord {
  runner: AgentRunner;
  parentThreadId: ThreadId;
  parentTurnId: TurnId;
  role?: string;
  startedAt: number;
  budget: { maxTurns?: number; maxToolCalls?: number; maxWallMs?: number };
  turnsUsed: number;
  toolCallsUsed: number;
  wallTimer?: ReturnType<typeof setTimeout>;
  budgetExceeded: boolean;
  exceededReason?: 'maxTurns' | 'maxToolCalls' | 'maxWallMs';
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
    const childThreadId = newThreadId();
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

    const systemPrompt = this.deps.systemPromptFor(req.role);
    const runner = new AgentRunner({
      threadId: childThreadId,
      bus: this.deps.bus,
      store: this.deps.store,
      registry: this.deps.registry,
      executor: this.deps.executor,
      provider: this.deps.provider,
      systemPrompt,
      ...(this.deps.memory !== undefined ? { memory: this.deps.memory } : {}),
      ...(this.deps.microCompact !== undefined ? { microCompact: this.deps.microCompact } : {}),
      onSpawn: (inner) => this.spawn(inner),
    });
    runner.start();

    const record: ChildRecord = {
      runner,
      parentThreadId: req.parentThreadId,
      parentTurnId: req.parentTurnId,
      ...(req.role !== undefined ? { role: req.role } : {}),
      startedAt: Date.now(),
      budget: req.budget ?? {},
      turnsUsed: 0,
      toolCallsUsed: 0,
      budgetExceeded: false,
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
        return this.onSamplingComplete(event.threadId);
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

  private onSamplingComplete(threadId: ThreadId): void {
    const r = this.children.get(threadId);
    if (!r || r.budgetExceeded) return;
    r.turnsUsed += 1;
    if (r.budget.maxTurns !== undefined && r.turnsUsed >= r.budget.maxTurns) {
      this.tripBudget(threadId, 'maxTurns');
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
    reason: 'maxTurns' | 'maxToolCalls' | 'maxWallMs',
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

  private async onTurnComplete(event: HarnessEvent): Promise<void> {
    const record = this.children.get(event.threadId);
    if (!record) return; // not one of our children
    this.children.delete(event.threadId);
    if (record.wallTimer) clearTimeout(record.wallTimer);

    const p = event.payload as { status: string; summary?: string };
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

    const summary = record.budgetExceeded
      ? `budget exceeded (${record.exceededReason}); turns=${record.turnsUsed} toolCalls=${record.toolCallsUsed}`
      : p.summary;

    const evOut: HarnessEvent = {
      id: newEventId(),
      threadId: record.parentThreadId,
      turnId: record.parentTurnId,
      kind: 'subtask_complete',
      payload: {
        childThreadId: event.threadId,
        status,
        ...(summary !== undefined ? { summary } : {}),
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
