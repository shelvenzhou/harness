import type { Action } from '@harness/core/actions.js';
import type {
  HarnessEvent,
  ReplyPayload,
  ToolCallPayload,
  ToolResultPayload,
  UserTurnStartPayload,
} from '@harness/core/events.js';
import {
  newEventId,
  newThreadId,
  newToolCallId,
  newTurnId,
  type EventId,
  type ThreadId,
  type ToolCallId,
  type TurnId,
} from '@harness/core/ids.js';
import { childOf } from '@harness/core/traceparent.js';
import type { EventBus } from '@harness/bus/eventBus.js';
import type { SessionStore } from '@harness/store/sessionStore.js';
import type { LlmProvider, SamplingRequest } from '@harness/llm/provider.js';
import { parseSampling } from '@harness/llm/actionParser.js';
import type { ToolRegistry } from '@harness/tools/registry.js';
import type { Tool, ToolExecutionContext } from '@harness/tools/tool.js';
import type { ToolExecutor } from '@harness/tools/executor.js';
import { HandleRegistry } from '@harness/context/handleRegistry.js';
import { buildSamplingRequest } from '@harness/context/projection.js';

import { ActiveTurn } from './activeTurn.js';

/**
 * AgentRunner: drives one thread. Event-driven, not loop-driven.
 *
 * Lifecycle:
 *   - External publishes `user_turn_start` on the bus.
 *   - handleEvent enqueues a tick; one tick at a time per thread.
 *   - Tick: load projection → sample LLM → parse actions → dispatch →
 *     update ActiveTurn → return.
 *   - ToolResult events arrive later; another tick resumes.
 *
 * See design-docs/01-runtime.md.
 */

export interface AgentRunnerOptions {
  threadId: ThreadId;
  bus: EventBus;
  store: SessionStore;
  registry: ToolRegistry;
  executor: ToolExecutor;
  provider: LlmProvider;
  systemPrompt: string;
  pinnedMemory?: string[];
  /**
   * Called before each sampling request. Use to persist or tee the
   * exact prompt going to the provider. Return a path (or any id) and
   * the runner will include it in the `sampling_complete` event.
   */
  onPromptBuilt?: (
    ctx: { threadId: ThreadId; turnId: TurnId; samplingIndex: number },
    request: SamplingRequest,
    stats: { projectedItems: number; elidedCount: number; estimatedTokens: number; pinnedHandles: number },
  ) => Promise<string | undefined> | string | undefined;
  /**
   * Called when the runner wants to spawn a child. Injected so subagent-
   * pool behaviour (budgets, shared bus, traceparent propagation) is
   * decided externally.
   */
  onSpawn?: (req: SpawnRequestInfo) => Promise<ThreadId>;
}

export interface SpawnRequestInfo {
  parentThreadId: ThreadId;
  parentTurnId: TurnId;
  task: string;
  role?: string;
  budget: { maxTurns?: number; maxToolCalls?: number; maxWallMs?: number };
  inheritTurns: number;
  parentTraceparent?: string;
}

export class AgentRunner {
  private readonly opts: AgentRunnerOptions;
  private activeTurn?: ActiveTurn;
  private handles = new HandleRegistry();
  private tickInFlight = false;
  private tickPending = false;
  private abortCtl: AbortController | undefined;
  private samplingIndex = 0;

  constructor(opts: AgentRunnerOptions) {
    this.opts = opts;
  }

  /** Wire this runner's subscription to its thread. */
  start(): void {
    this.opts.bus.subscribe(
      (ev) => this.onEvent(ev),
      { threadId: this.opts.threadId },
    );
  }

  private async onEvent(ev: HarnessEvent): Promise<void> {
    // Ignore events this runner just emitted (they'll cause a tick storm).
    // The runner re-enters on control/data events it reacts to.
    if (!shouldTriggerTick(ev)) {
      // Still deliver to an active turn's mailbox for bookkeeping.
      this.activeTurn?.deliver(ev);
      return;
    }

    // Deliver to mailbox so drain picks it up on next tick.
    if (this.activeTurn && !this.activeTurn.isTerminal()) {
      this.activeTurn.deliver(ev, ev.kind === 'interrupt' ? { interrupt: true } : {});
      if (ev.kind === 'interrupt') {
        this.abortCtl?.abort();
      }
    }

    this.scheduleTick(ev);
  }

  private scheduleTick(seed: HarnessEvent): void {
    if (this.tickInFlight) {
      this.tickPending = true;
      return;
    }
    void this.tick(seed).catch((err) => {
      // Surface tick errors so tests / dev notice; the runner stays up.
      // eslint-disable-next-line no-console
      console.error('[runner] tick error', err);
    });
  }

  private async tick(seed: HarnessEvent): Promise<void> {
    this.tickInFlight = true;
    try {
      if (seed.kind === 'user_turn_start') {
        await this.startNewTurn(seed.id, seed.payload);
      } else if (
        this.activeTurn &&
        !this.activeTurn.isTerminal() &&
        isReadyToSample(this.activeTurn)
      ) {
        await this.runSamplingStep();
      }
    } finally {
      this.tickInFlight = false;
      if (this.tickPending && this.activeTurn && !this.activeTurn.isTerminal()) {
        this.tickPending = false;
        this.scheduleTick(synthEvent(this.opts.threadId, 'internal_resume'));
      }
    }
  }

  private async startNewTurn(seedEventId: EventId, payload: UserTurnStartPayload): Promise<void> {
    const turnId = newTurnId();
    this.activeTurn = new ActiveTurn(this.opts.threadId, turnId);
    this.activeTurn.setPhase('CurrentTurn');
    this.activeTurn.toRunning();
    void payload; // payload already persisted as the seed event.
    void seedEventId;
    await this.runSamplingStep();
  }

  private async runSamplingStep(): Promise<void> {
    if (!this.activeTurn) return;
    const at = this.activeTurn;
    at.toRunning();
    this.abortCtl = new AbortController();
    this.samplingIndex += 1;

    const { request, stats } = await this.buildRequestWithStats();
    const promptDumpPath = this.opts.onPromptBuilt
      ? await this.opts.onPromptBuilt(
          { threadId: this.opts.threadId, turnId: at.turnId, samplingIndex: this.samplingIndex },
          request,
          stats,
        )
      : undefined;

    const startedAt = Date.now();
    const parsed = await parseSampling(
      this.opts.provider.sample(request, this.abortCtl.signal),
    );
    const wallMs = Date.now() - startedAt;
    this.handles.clearPins();

    // Record reasoning if emitted.
    if (parsed.reasoningText) {
      await this.appendEvent({
        kind: 'reasoning',
        payload: { text: parsed.reasoningText },
        ...(at.turnId !== undefined ? { turnId: at.turnId } : {}),
      });
    }

    const pendingToolCalls: Array<{ toolCallId: ToolCallId; call: Action & { kind: 'tool_call' } }> = [];

    for (const action of parsed.actions) {
      at.pushActionInFlight(action);
      await this.dispatchAction(action, pendingToolCalls);
    }

    // Emit sampling_complete with usage + projection stats so the diag
    // layer (and anyone else subscribed) can build a full trace.
    await this.appendEvent({
      kind: 'sampling_complete',
      payload: {
        samplingIndex: this.samplingIndex,
        providerId: this.opts.provider.id,
        promptTokens: parsed.usage?.promptTokens ?? 0,
        cachedPromptTokens: parsed.usage?.cachedPromptTokens ?? 0,
        completionTokens: parsed.usage?.completionTokens ?? 0,
        wallMs,
        ...(parsed.ttftMs !== undefined ? { ttftMs: parsed.ttftMs } : {}),
        ...(parsed.stopReason !== undefined ? { stopReason: parsed.stopReason } : {}),
        projection: stats,
        toolCallCount: pendingToolCalls.length,
        ...(promptDumpPath !== undefined ? { promptDumpPath } : {}),
      },
      ...(at.turnId !== undefined ? { turnId: at.turnId } : {}),
    });

    if (pendingToolCalls.length > 0) {
      at.toAwaitingTools(pendingToolCalls.map((p) => p.toolCallId));
      // Kick off all tool calls concurrently; results arrive as events.
      for (const { toolCallId, call } of pendingToolCalls) {
        void this.runToolCall(toolCallId, call);
      }
      return;
    }

    // No tool calls emitted. Decide turn fate.
    const lastReply = [...parsed.actions]
      .reverse()
      .find((a): a is Action & { kind: 'reply' } => a.kind === 'reply');
    if (lastReply?.final || parsed.stopReason === 'end_turn') {
      await this.completeTurn('completed', lastReply?.text);
    } else {
      // Model returned nothing actionable; treat as completed to avoid a
      // runaway empty loop. Provider-specific handling can improve later.
      await this.completeTurn('completed');
    }
  }

  private async buildRequestWithStats(): Promise<{
    request: SamplingRequest;
    stats: { projectedItems: number; elidedCount: number; estimatedTokens: number; pinnedHandles: number };
  }> {
    const built = await buildSamplingRequest({
      threadId: this.opts.threadId,
      store: this.opts.store,
      registry: this.opts.registry,
      handles: this.handles,
      systemPrompt: this.opts.systemPrompt,
      pinnedMemory: this.opts.pinnedMemory ?? [],
    });
    return { request: built.request, stats: built.stats };
  }

  private async dispatchAction(
    action: Action,
    collectToolCalls: Array<{ toolCallId: ToolCallId; call: Action & { kind: 'tool_call' } }>,
  ): Promise<void> {
    switch (action.kind) {
      case 'reply':
        await this.appendEvent({
          kind: 'reply',
          payload: {
            text: action.text,
            ...(action.internal !== undefined ? { internal: action.internal } : {}),
            ...(action.final !== undefined ? { final: action.final } : {}),
          } satisfies ReplyPayload,
          ...(this.activeTurn?.turnId !== undefined ? { turnId: this.activeTurn.turnId } : {}),
        });
        break;
      case 'preamble':
        await this.appendEvent({
          kind: 'preamble',
          payload: { text: action.text },
          ...(this.activeTurn?.turnId !== undefined ? { turnId: this.activeTurn.turnId } : {}),
        });
        break;
      case 'tool_call': {
        const toolCallId = action.toolCallId;
        // The canonical conversation pair for ANY tool — including the
        // transport tools (spawn / wait / restore) — is `tool_call` →
        // `tool_result`. We always persist the tool_call event first so
        // projection produces a consistent assistant{tool_calls:[id]} →
        // tool{tool_call_id: id} sequence; otherwise OpenAI rejects the
        // next request as "tool_calls without responses".
        await this.appendEvent({
          kind: 'tool_call',
          payload: {
            toolCallId,
            name: action.name,
            args: action.args,
          } satisfies ToolCallPayload,
          ...(this.activeTurn?.turnId !== undefined ? { turnId: this.activeTurn.turnId } : {}),
        });

        // Intercept the three transport tools — they need access to the
        // runner's internals (subagent pool / handle registry) and so
        // can't be expressed as ordinary Tool.execute().
        if (action.name === 'spawn') {
          await this.handleSpawnRequest(toolCallId, action.args);
          break;
        }
        if (action.name === 'wait') {
          await this.handleWaitRequest(toolCallId, action.args);
          break;
        }
        if (action.name === 'restore') {
          await this.handleRestoreRequest(toolCallId, action.args);
          break;
        }
        collectToolCalls.push({ toolCallId, call: action });
        break;
      }
      case 'spawn':
      case 'wait':
      case 'done':
        // Not produced by the parser today; reserved for providers that
        // emit these actions directly.
        break;
    }
  }

  private async runToolCall(
    toolCallId: ToolCallId,
    call: Action & { kind: 'tool_call' },
  ): Promise<void> {
    if (!this.activeTurn) return;
    const tool = this.opts.registry.get(call.name);
    if (!tool) {
      await this.persistToolResult(toolCallId, {
        ok: false,
        error: { kind: 'unknown_tool', message: `no tool named ${call.name}` },
      });
      return;
    }

    const ctx: ToolExecutionContext = {
      threadId: this.opts.threadId,
      turnId: this.activeTurn.turnId,
      toolCallId,
      signal: this.abortCtl?.signal ?? new AbortController().signal,
      log: () => void 0,
      registerHandle: (kind, payload, meta) => this.handles.register(kind, payload, meta ?? {}),
      services: {},
    };

    const result = await this.opts.executor.execute({
      toolCallId,
      name: call.name,
      args: call.args,
      ctx,
    });
    await this.persistToolResult(toolCallId, result, tool);
  }

  private async persistToolResult(
    toolCallId: ToolCallId,
    result: Awaited<ReturnType<ToolExecutor['execute']>>,
    tool?: Tool,
  ): Promise<void> {
    void tool;
    const event = await this.appendEvent({
      kind: 'tool_result',
      payload: {
        toolCallId,
        ok: result.ok,
        ...(result.output !== undefined ? { output: result.output } : {}),
        ...(result.error !== undefined ? { error: result.error } : {}),
        ...(result.originalBytes !== undefined ? { originalBytes: result.originalBytes } : {}),
        ...(result.bytesSent !== undefined ? { bytesSent: result.bytesSent } : {}),
      } satisfies ToolResultPayload,
      ...(this.activeTurn?.turnId !== undefined ? { turnId: this.activeTurn.turnId } : {}),
    });
    if (result.elided) {
      await this.opts.store.attachElision(this.opts.threadId, event.id, result.elided);
    }
    if (this.activeTurn) {
      const allResolved = this.activeTurn.resolveTool(toolCallId);
      if (allResolved && !this.activeTurn.isTerminal()) {
        this.scheduleTick(synthEvent(this.opts.threadId, 'internal_resume'));
      }
    }
  }

  private async handleSpawnRequest(toolCallId: ToolCallId, rawArgs: unknown): Promise<void> {
    const args = rawArgs as {
      task: string;
      role?: string;
      budget?: { maxTurns?: number; maxToolCalls?: number; maxWallMs?: number };
      inheritTurns?: number;
    };
    const childThreadId = newThreadId();
    const turnId = this.activeTurn?.turnId ?? newTurnId();
    await this.appendEvent({
      kind: 'spawn_request',
      payload: {
        childThreadId,
        ...(args.role !== undefined ? { role: args.role } : {}),
        task: args.task,
        inheritTurns: args.inheritTurns ?? 0,
        budget: args.budget ?? {},
      },
      turnId,
    });
    if (this.opts.onSpawn) {
      await this.opts.onSpawn({
        parentThreadId: this.opts.threadId,
        parentTurnId: turnId,
        task: args.task,
        ...(args.role !== undefined ? { role: args.role } : {}),
        budget: args.budget ?? {},
        inheritTurns: args.inheritTurns ?? 0,
        parentTraceparent: childOf(undefined),
      });
    }
    await this.persistToolResult(toolCallId, {
      ok: true,
      output: { childThreadId },
    });
  }

  private async handleWaitRequest(toolCallId: ToolCallId, rawArgs: unknown): Promise<void> {
    // Reflect the wait as a tool_result; the real yield is implicit — the
    // runner simply won't sample again until a matching event arrives.
    await this.persistToolResult(toolCallId, {
      ok: true,
      output: { scheduled: true, matcher: (rawArgs as { matcher?: string }).matcher ?? 'kind' },
    });
  }

  private async handleRestoreRequest(toolCallId: ToolCallId, rawArgs: unknown): Promise<void> {
    const args = rawArgs as { handle: string };
    const ok = this.handles.pinForNextSampling(args.handle as never);
    await this.persistToolResult(toolCallId, {
      ok,
      output: { handle: args.handle, pinned: ok },
      ...(ok
        ? {}
        : {
            error: { kind: 'unknown_handle', message: `no handle ${args.handle}` },
          }),
    });
  }

  private async completeTurn(
    status: 'completed' | 'errored' | 'interrupted',
    summary?: string,
  ): Promise<void> {
    this.activeTurn?.toCompleted(summary);
    await this.appendEvent({
      kind: 'turn_complete',
      payload: { status, ...(summary !== undefined ? { summary } : {}) },
      ...(this.activeTurn?.turnId !== undefined ? { turnId: this.activeTurn.turnId } : {}),
    });
  }

  private async appendEvent(
    partial: Omit<HarnessEvent, 'id' | 'createdAt' | 'threadId'>,
  ): Promise<HarnessEvent> {
    const event = await this.opts.store.append({
      ...partial,
      id: newEventId(),
      threadId: this.opts.threadId,
    } as Parameters<SessionStore['append']>[0]);
    this.opts.bus.publish(event);
    return event;
  }
}

function shouldTriggerTick(ev: HarnessEvent): boolean {
  switch (ev.kind) {
    case 'user_turn_start':
    case 'user_input':
    case 'interrupt':
    case 'compact_request':
    case 'tool_result':
    case 'subtask_complete':
    case 'timer_fired':
    case 'external_event':
      return true;
    default:
      return false;
  }
}

function isReadyToSample(at: ActiveTurn): boolean {
  const s = at.state;
  if (s.kind === 'awaiting_tool_results') return s.pending.size === 0;
  if (s.kind === 'completed' || s.kind === 'interrupted' || s.kind === 'errored') return false;
  return true;
}

function synthEvent(threadId: ThreadId, reason: string): HarnessEvent {
  // Private sentinel; never published. Used to re-arm tick from this module.
  return {
    id: ('evt_synth_' + reason) as EventId,
    threadId,
    kind: 'external_event',
    payload: { source: 'runner', data: { reason } },
    createdAt: new Date().toISOString(),
  } as HarnessEvent;
}

// re-export for convenience
export { newToolCallId };
