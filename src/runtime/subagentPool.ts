import type { EventBus } from '@harness/bus/eventBus.js';
import type { SessionStore } from '@harness/store/sessionStore.js';
import type { LlmProvider } from '@harness/llm/provider.js';
import type { ToolRegistry } from '@harness/tools/registry.js';
import type { ToolExecutor } from '@harness/tools/executor.js';
import { newRootTraceparent } from '@harness/core/traceparent.js';
import type { ThreadId } from '@harness/core/ids.js';

import { AgentRunner, type SpawnRequestInfo } from './agentRunner.js';

/**
 * Subagent pool skeleton. Phase 1 behaviour: `spawn` creates a child
 * thread + AgentRunner, wires it to the same bus/store/provider, and
 * returns its threadId. The parent receives `subtask_complete` via the
 * bus when the child's turn ends.
 *
 * Budgets (`maxTurns / maxToolCalls / maxWallMs`) are recorded but not
 * yet enforced. That lands in phase 2.
 */

export interface SubagentPoolDeps {
  bus: EventBus;
  store: SessionStore;
  registry: ToolRegistry;
  executor: ToolExecutor;
  provider: LlmProvider;
  systemPromptFor: (role: string | undefined) => string;
}

export class SubagentPool {
  private children = new Map<ThreadId, AgentRunner>();

  constructor(private readonly deps: SubagentPoolDeps) {}

  async spawn(req: SpawnRequestInfo): Promise<ThreadId> {
    const childThreadId = (`thr_${randomSuffix()}` as string) as ThreadId;
    const traceparent = req.parentTraceparent ?? newRootTraceparent();
    await this.deps.store.createThread({
      id: childThreadId,
      rootTraceparent: traceparent,
      parentThreadId: req.parentThreadId,
      ...(req.role !== undefined ? { title: req.role } : {}),
    });

    // Seed the child with the task as a user_turn_start.
    await this.deps.store.append({
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
    this.children.set(childThreadId, runner);

    // Nudge the child runner by republishing the seed event on the bus.
    const seeds = await this.deps.store.readAll(childThreadId);
    if (seeds.length > 0) this.deps.bus.publish(seeds[seeds.length - 1]!);

    return childThreadId;
  }

  get childCount(): number {
    return this.children.size;
  }
}

function randomSuffix(): string {
  return Math.random().toString(16).slice(2, 14);
}
