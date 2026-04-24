import type { EventBus } from '@harness/bus/eventBus.js';
import type { SessionStore } from '@harness/store/sessionStore.js';
import type { LlmProvider } from '@harness/llm/provider.js';
import type { ToolRegistry } from '@harness/tools/registry.js';
import type { ToolExecutor } from '@harness/tools/executor.js';
import { newRootTraceparent } from '@harness/core/traceparent.js';
import { newEventId, newThreadId } from '@harness/core/ids.js';
import type { ThreadId, TurnId } from '@harness/core/ids.js';
import type { HarnessEvent, SubtaskCompletePayload } from '@harness/core/events.js';

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
 * Budgets (`maxTurns / maxToolCalls / maxWallMs`) are recorded but not
 * yet enforced. `inheritTurns` not yet implemented.
 */

export interface SubagentPoolDeps {
  bus: EventBus;
  store: SessionStore;
  registry: ToolRegistry;
  executor: ToolExecutor;
  provider: LlmProvider;
  systemPromptFor: (role: string | undefined) => string;
}

interface ChildRecord {
  runner: AgentRunner;
  parentThreadId: ThreadId;
  parentTurnId: TurnId;
  role?: string;
  startedAt: number;
}

export class SubagentPool {
  private children = new Map<ThreadId, ChildRecord>();
  private subscribed = false;

  constructor(private readonly deps: SubagentPoolDeps) {}

  private ensureSubscribed(): void {
    if (this.subscribed) return;
    this.subscribed = true;
    // One global subscription; it filters for turn_complete on known
    // child threads and routes a subtask_complete event to the parent.
    this.deps.bus.subscribe(
      (ev) => this.onEvent(ev),
      { kinds: ['turn_complete'] },
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
      onSpawn: (inner) => this.spawn(inner),
    });
    runner.start();
    this.children.set(childThreadId, {
      runner,
      parentThreadId: req.parentThreadId,
      parentTurnId: req.parentTurnId,
      ...(req.role !== undefined ? { role: req.role } : {}),
      startedAt: Date.now(),
    });

    // Nudge the child runner by publishing the seed event.
    this.deps.bus.publish(seed);
    return childThreadId;
  }

  private async onEvent(event: HarnessEvent): Promise<void> {
    if (event.kind !== 'turn_complete') return;
    const record = this.children.get(event.threadId);
    if (!record) return; // Not one of our children — probably a root turn.
    this.children.delete(event.threadId);

    const p = event.payload as { status: string; summary?: string };
    const status: SubtaskCompletePayload['status'] =
      p.status === 'completed'
        ? 'completed'
        : p.status === 'errored'
          ? 'errored'
          : 'interrupted';

    const evOut: HarnessEvent = {
      id: newEventId(),
      threadId: record.parentThreadId,
      turnId: record.parentTurnId,
      kind: 'subtask_complete',
      payload: {
        childThreadId: event.threadId,
        status,
        ...(p.summary !== undefined ? { summary: p.summary } : {}),
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
