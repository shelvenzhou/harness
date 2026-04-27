import type { Action, EventSpec } from '@harness/core/actions.js';
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
import { MicroCompactor, type MicroCompactorOptions } from '@harness/context/microCompactor.js';
import type { MemoryStore } from '@harness/memory/types.js';

import { ActiveTurn } from './activeTurn.js';
import { Scheduler } from './scheduler.js';

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

/**
 * Hard-wall token budget. The runtime enforces this as a *cap*, not as
 * advice injected into the prompt — design principle: runtime mechanism,
 * LLM policy. When tripped, the turn terminates with status='errored'
 * and a summary indicating which cap fired.
 *
 * Enforcement points:
 *   1. *Before* each sampling step — protects accumulated state from
 *      prior steps / prior turns (for thread-cap).
 *   2. *After* each sampling step that does NOT emit tool calls —
 *      catches the case where a single oversized response would
 *      otherwise close the turn as 'completed' before the wall could
 *      gate a "next" sampling. Without this the wall silently fails on
 *      one-shot responses.
 *   3. The multi-step (tool-using) path relies on (1): tools dispatched
 *      from a step are allowed to finish; the next sampling boundary
 *      then trips the cap.
 *
 * Tokens counted are `promptTokens + completionTokens` from each
 * `sampling_complete`. `cachedPromptTokens` is included in `promptTokens`
 * by convention, so it counts toward the prompt total too (cost-control
 * framing); use compaction for context-window framing.
 */
export interface TokenBudget {
  /** Hard cap on cumulative tokens for the current user turn. */
  maxTurnTokens?: number;
  /** Hard cap on cumulative tokens over the lifetime of this thread. */
  maxThreadTokens?: number;
}

export interface AgentRunnerOptions {
  threadId: ThreadId;
  bus: EventBus;
  store: SessionStore;
  registry: ToolRegistry;
  executor: ToolExecutor;
  provider: LlmProvider;
  systemPrompt: string;
  pinnedMemory?: string[];
  /** Persistent memory backend; injected into every tool ctx.services. */
  memory?: MemoryStore;
  /**
   * Hot-path micro-compaction. Disabled when undefined.
   * When set, runs deterministically before each sampling step.
   */
  microCompact?: MicroCompactorOptions | false;
  /**
   * Hard-wall token caps. Omitted (or all-undefined) means no enforcement.
   * Counters are in-memory; on resume they should be rebuilt from
   * sampling_complete events in the store.
   */
  tokenBudget?: TokenBudget;
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
  childThreadId?: ThreadId;
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
  /**
   * Seeds that arrived while a tick was in flight. Drained in FIFO order
   * after the tick completes. A boolean flag here is not enough: the actual
   * seed kind matters (user_turn_start for a new turn vs. internal_resume
   * to recheck mid-turn), and dropping seeds caused new turns to be lost
   * when they arrived during the previous turn's wind-down.
   */
  private pendingSeeds: HarnessEvent[] = [];
  private abortCtl: AbortController | undefined;
  private samplingIndex = 0;
  private microCompactor?: MicroCompactor;
  private tokensThisTurn = 0;
  private tokensThisThread = 0;
  private readonly scheduler: Scheduler;
  /**
   * Pending timer ids on the current turn. Tracked so we can cancel
   * everything on completeTurn / interrupt without leaving zombie
   * timers that fire into a dead turn. Cleared at every turn boundary.
   */
  private pendingTimerIds = new Set<string>();

  constructor(opts: AgentRunnerOptions) {
    this.opts = opts;
    if (opts.microCompact !== false) {
      this.microCompactor = new MicroCompactor(opts.microCompact ?? {});
    }
    // The runner always owns the onFire callback because timer→event
    // translation is runner state (threadId, store, bus). If the caller
    // supplied a Scheduler we re-use the timer-handle table but install
    // our callback on top.
    // Runner owns its scheduler; timer→event translation is runner state
    // (threadId, store, bus), so injection from outside would just have
    // to wrap the runner's callback anyway.
    this.scheduler = new Scheduler((s) => this.onTimerFired(s));
  }

  /** Wire this runner's subscription to its thread. */
  start(): void {
    this.opts.bus.subscribe(
      (ev) => this.onEvent(ev),
      { threadId: this.opts.threadId },
    );
  }

  /**
   * Rebuild in-memory accounting from the store. Used by `resume()`:
   * after construction the runner's tokensThisThread / samplingIndex
   * counters are zero; this scans existing sampling_complete events and
   * seeds them so the hard-wall token budget remains accurate across
   * process restarts. Does not replay turns or alter activeTurn — a
   * fresh user_turn_start drives the next turn as usual.
   */
  async hydrateFromStore(): Promise<void> {
    const events = await this.opts.store.readAll(this.opts.threadId);
    let total = 0;
    let lastSamplingIndex = 0;
    for (const ev of events) {
      if (ev.kind !== 'sampling_complete') continue;
      total += ev.payload.promptTokens + ev.payload.completionTokens;
      if (ev.payload.samplingIndex > lastSamplingIndex) {
        lastSamplingIndex = ev.payload.samplingIndex;
      }
    }
    this.tokensThisThread = total;
    this.samplingIndex = lastSamplingIndex;
  }

  private async onEvent(ev: HarnessEvent): Promise<void> {
    // Ignore events this runner just emitted (they'll cause a tick storm).
    // The runner re-enters on control/data events it reacts to.
    if (!shouldTriggerTick(ev)) {
      // Still deliver to an active turn's mailbox for bookkeeping.
      this.activeTurn?.deliver(ev);
      return;
    }

    // Wake from awaiting_event when the spec matches, or unconditionally on
    // interrupt. Without this, the turn stays stuck after `wait` even
    // though the right event arrived.
    const at = this.activeTurn;
    if (at && at.state.kind === 'awaiting_event') {
      const woke =
        ev.kind === 'interrupt' ||
        eventMatchesSpec(ev, at.state.spec) ||
        // Permissive fallback: a wait_timeout external_event always wakes
        // the turn so a bounded wait can never deadlock.
        (ev.kind === 'external_event' &&
          (ev.payload as { source?: string }).source === 'wait_timeout');
      if (woke) {
        at.toRunning();
        // The wait either matched its target or timed out; either way
        // the surviving timers for this wait become noise. Cancel them.
        this.cancelPendingTimers();
      }
    }

    // Deliver to mailbox so drain picks it up on next tick.
    if (this.activeTurn && !this.activeTurn.isTerminal()) {
      this.activeTurn.deliver(ev, ev.kind === 'interrupt' ? { interrupt: true } : {});
      if (ev.kind === 'interrupt') {
        this.abortCtl?.abort();
        // Pending wait timers should not fire after an interrupt: the
        // turn is on its way out and any timer_fired we'd publish would
        // be stale. Same as completeTurn but earlier in the lifecycle.
        this.cancelPendingTimers();
      }
    }

    this.scheduleTick(ev);
  }

  private scheduleTick(seed: HarnessEvent): void {
    if (this.tickInFlight) {
      this.pendingSeeds.push(seed);
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
      // Drain any seeds that arrived while we were busy. Each seed gets a
      // fresh tick so its kind is honoured (user_turn_start starts a new
      // turn; tool_result / subtask_complete resumes the active turn).
      const next = this.pendingSeeds.shift();
      if (next !== undefined) {
        this.scheduleTick(next);
      }
    }
  }

  private async startNewTurn(seedEventId: EventId, payload: UserTurnStartPayload): Promise<void> {
    const turnId = newTurnId();
    this.activeTurn = new ActiveTurn(this.opts.threadId, turnId);
    this.activeTurn.setPhase('CurrentTurn');
    this.activeTurn.toRunning();
    this.tokensThisTurn = 0;
    void payload; // payload already persisted as the seed event.
    void seedEventId;
    await this.runSamplingStep();
  }

  private async runSamplingStep(): Promise<void> {
    if (!this.activeTurn) return;
    const at = this.activeTurn;

    // Hard-wall token budget check, evaluated at the sampling boundary.
    // Caps are checked *before* committing to another provider call; tools
    // already in flight from the previous step run to completion.
    const tripped = this.checkTokenBudget();
    if (tripped) {
      await this.completeTurn('errored', tripped);
      return;
    }

    at.toRunning();
    this.abortCtl = new AbortController();
    this.samplingIndex += 1;

    if (this.microCompactor) {
      const compacted = await this.microCompactor.maybeRun(
        this.opts.threadId,
        this.opts.store,
        this.handles,
      );
      if (compacted.compactionEvent) {
        this.opts.bus.publish(compacted.compactionEvent);
      }
    }

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

    let shouldContinueSampling = false;
    let suspended = false;
    for (const action of parsed.actions) {
      at.pushActionInFlight(action);
      const out = await this.dispatchAction(action, pendingToolCalls);
      shouldContinueSampling = shouldContinueSampling || out.continueSampling;
      suspended = suspended || out.suspended;
    }

    // Accumulate tokens for hard-wall budget enforcement. Counted on the
    // sum of prompt + completion (cost-control framing). Cached prompt
    // tokens are already part of promptTokens by convention.
    const stepTokens =
      (parsed.usage?.promptTokens ?? 0) + (parsed.usage?.completionTokens ?? 0);
    this.tokensThisTurn += stepTokens;
    this.tokensThisThread += stepTokens;

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
      // Cap enforcement for the multi-step path is handled by the
      // checkTokenBudget at the top of the *next* runSamplingStep —
      // tools dispatched here are allowed to finish first.
      for (const { toolCallId, call } of pendingToolCalls) {
        void this.runToolCall(toolCallId, call);
      }
      return;
    }

    // No tool calls emitted. Re-check the cap *now*: if this single
    // sampling overran the budget, there is no "next sampling" to gate
    // — the turn would otherwise close as 'completed' and the wall
    // would silently fail. The pre-sampling check at the top of this
    // method only catches accumulated state from prior steps; this
    // post-sampling check catches a single oversized response.
    const trippedAfter = this.checkTokenBudget();
    if (trippedAfter) {
      await this.completeTurn('errored', trippedAfter);
      return;
    }

    if (suspended) {
      // wait was issued: leave the turn open. An external event
      // (timer_fired / external_event / subtask_complete) will re-arm
      // sampling via shouldTriggerTick. Do NOT close the turn here.
      return;
    }

    if (shouldContinueSampling) {
      this.scheduleTick(synthEvent(this.opts.threadId, 'post_transport_tool'));
      return;
    }

    if (parsed.actions.length === 0) {
      const summary =
        parsed.stopReason === 'tool_use'
          ? 'model_returned_tool_use_without_tool_calls'
          : parsed.stopReason === 'max_tokens'
            ? 'model_response_truncated_before_any_action'
            : `model_returned_no_actions${parsed.stopReason ? ` stop=${parsed.stopReason}` : ''}`;
      await this.completeTurn('errored', summary);
      return;
    }

    const lastReply = [...parsed.actions]
      .reverse()
      .find((a): a is Action & { kind: 'reply' } => a.kind === 'reply');
    if (parsed.stopReason === 'max_tokens') {
      await this.completeTurn(
        'errored',
        lastReply
          ? 'model_response_truncated_after_partial_reply'
          : 'model_response_truncated_before_reply',
      );
      return;
    }
    if (lastReply?.final || parsed.stopReason === 'end_turn') {
      await this.completeTurn('completed', lastReply?.text);
    } else {
      await this.completeTurn(
        'errored',
        `model_stopped_without_final_reply${parsed.stopReason ? ` stop=${parsed.stopReason}` : ''}`,
      );
    }
  }

  /**
   * Returns a non-empty summary string when the token budget would be
   * exceeded by the next sampling, otherwise undefined. The caller uses
   * the string as the turn_complete summary so the cap reason is visible
   * in the trace.
   */
  private checkTokenBudget(): string | undefined {
    const b = this.opts.tokenBudget;
    if (!b) return undefined;
    if (b.maxTurnTokens !== undefined && this.tokensThisTurn >= b.maxTurnTokens) {
      return `tokens_exceeded:turn used=${this.tokensThisTurn} cap=${b.maxTurnTokens}`;
    }
    if (b.maxThreadTokens !== undefined && this.tokensThisThread >= b.maxThreadTokens) {
      return `tokens_exceeded:thread used=${this.tokensThisThread} cap=${b.maxThreadTokens}`;
    }
    return undefined;
  }

  private async buildRequestWithStats(): Promise<{
    request: SamplingRequest;
    stats: { projectedItems: number; elidedCount: number; estimatedTokens: number; pinnedHandles: number };
  }> {
    const staticPinned = this.opts.pinnedMemory ?? [];
    const memoryPinned = this.opts.memory
      ? (await this.opts.memory.pinned()).map(formatPinnedEntry)
      : [];
    const built = await buildSamplingRequest({
      threadId: this.opts.threadId,
      store: this.opts.store,
      registry: this.opts.registry,
      handles: this.handles,
      systemPrompt: this.opts.systemPrompt,
      pinnedMemory: [...staticPinned, ...memoryPinned],
    });
    return { request: built.request, stats: built.stats };
  }

  private async dispatchAction(
    action: Action,
    collectToolCalls: Array<{ toolCallId: ToolCallId; call: Action & { kind: 'tool_call' } }>,
  ): Promise<{ continueSampling: boolean; suspended: boolean }> {
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
        return { continueSampling: false, suspended: false };
      case 'preamble':
        await this.appendEvent({
          kind: 'preamble',
          payload: { text: action.text },
          ...(this.activeTurn?.turnId !== undefined ? { turnId: this.activeTurn.turnId } : {}),
        });
        return { continueSampling: false, suspended: false };
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
          return { continueSampling: true, suspended: false };
        }
        if (action.name === 'wait') {
          await this.handleWaitRequest(toolCallId, action.args);
          // wait is a hard suspend: the turn stays open until an external
          // event (timer_fired / external_event / subtask_complete) re-arms
          // sampling via shouldTriggerTick.
          return { continueSampling: false, suspended: true };
        }
        if (action.name === 'restore') {
          await this.handleRestoreRequest(toolCallId, action.args);
          return { continueSampling: true, suspended: false };
        }
        if (action.name === 'usage') {
          await this.handleUsageRequest(toolCallId);
          return { continueSampling: true, suspended: false };
        }
        collectToolCalls.push({ toolCallId, call: action });
        return { continueSampling: false, suspended: false };
      }
      case 'spawn':
      case 'wait':
      case 'done':
        // Not produced by the parser today; reserved for providers that
        // emit these actions directly.
        return { continueSampling: false, suspended: false };
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
      services: {
        ...(this.opts.memory !== undefined ? { memory: this.opts.memory } : {}),
      },
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
      budget?: {
        maxTurns?: number;
        maxToolCalls?: number;
        maxWallMs?: number;
        maxTokens?: number;
      };
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
      try {
        const spawnedChildThreadId = await this.opts.onSpawn({
          parentThreadId: this.opts.threadId,
          parentTurnId: turnId,
          childThreadId,
          task: args.task,
          ...(args.role !== undefined ? { role: args.role } : {}),
          budget: args.budget ?? {},
          inheritTurns: args.inheritTurns ?? 0,
          parentTraceparent: childOf(undefined),
        });
        if (spawnedChildThreadId !== childThreadId) {
          throw new Error(
            `spawn returned mismatched childThreadId: expected ${childThreadId}, got ${spawnedChildThreadId}`,
          );
        }
      } catch (err) {
        // Structural-cap rejection from the pool surfaces as a tool
        // error the LLM can react to (e.g. retry with smaller scope or
        // back off). Other exceptions also flow here — letting them
        // crash the tick was historically how this path failed; a
        // typed tool_result is strictly better signal.
        const message = err instanceof Error ? err.message : String(err);
        const reason =
          err instanceof Error && err.name === 'SpawnRefused'
            ? (err as { reason?: string }).reason ?? 'spawn_refused'
            : 'spawn_failed';
        await this.persistToolResult(toolCallId, {
          ok: false,
          error: { kind: reason, message },
        });
        return;
      }
    }
    await this.persistToolResult(toolCallId, {
      ok: true,
      output: { childThreadId },
    });
  }

  private async handleWaitRequest(toolCallId: ToolCallId, rawArgs: unknown): Promise<void> {
    // Transition into awaiting_event BEFORE persisting the tool_result.
    // Otherwise the tool_result we publish would itself flow back through
    // onEvent → shouldTriggerTick(tool_result) and re-arm sampling, which
    // would defeat the suspension.
    const a = (rawArgs ?? {}) as Record<string, unknown>;
    const spec = parseWaitSpec(rawArgs);
    this.activeTurn?.toAwaitingEvent(spec);

    // matcher='timer' must schedule the timer ourselves, otherwise the
    // turn deadlocks: nothing else publishes timer_fired.
    let scheduled = false;
    let scheduledTimeoutId: string | undefined;
    if (spec.matcher === 'timer') {
      const delayMs = typeof a.delayMs === 'number' ? a.delayMs : NaN;
      if (Number.isFinite(delayMs) && delayMs > 0) {
        this.scheduler.schedule({
          threadId: this.opts.threadId,
          timerId: spec.timerId,
          delayMs,
          tag: 'wait',
        });
        this.pendingTimerIds.add(spec.timerId);
        scheduled = true;
      }
      // If delayMs is missing for a timer wait, we deliberately do not
      // synthesize one. That's a model error — surface it via the
      // tool_result so the LLM can re-issue with valid args; the wait
      // itself stays open and will need an interrupt or a manual
      // event to resolve.
    } else {
      // For non-timer matchers, honour wait.timeoutMs if provided. We
      // schedule a private timer that, on fire, publishes a synthetic
      // external_event{source:"wait_timeout"} which the runner's
      // permissive fallback in eventMatchesSpec wakes on (kind matcher
      // = 'external_event'). For specific matchers we still wake them
      // because shouldTriggerTick admits external_event — and once the
      // tick runs, isReadyToSample sees the awaiting_event clear.
      const timeoutMs = typeof a.timeoutMs === 'number' ? a.timeoutMs : NaN;
      if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
        const timeoutTimerId = `wait_timeout_${toolCallId}`;
        this.scheduler.schedule({
          threadId: this.opts.threadId,
          timerId: timeoutTimerId,
          delayMs: timeoutMs,
          tag: 'wait_timeout',
        });
        this.pendingTimerIds.add(timeoutTimerId);
        scheduledTimeoutId = timeoutTimerId;
      }
    }

    await this.persistToolResult(toolCallId, {
      ok: true,
      output: {
        scheduled: spec.matcher === 'timer' ? scheduled : true,
        matcher: spec.matcher,
        ...(spec.matcher === 'timer' && !scheduled
          ? { error: 'timer wait requires positive delayMs' }
          : {}),
        ...(scheduledTimeoutId !== undefined ? { timeoutTimerId: scheduledTimeoutId } : {}),
      },
    });
  }

  /**
   * Scheduler callback. We keep it tight: persist the timer_fired
   * envelope on this thread and publish; runner's own subscription
   * picks it up via shouldTriggerTick → eventMatchesSpec wakes any
   * awaiting_event whose timerId matches. Wait-timeout timers fire as
   * external_event so the permissive fallback handles them too.
   */
  private onTimerFired(s: { threadId: ThreadId; timerId: string; tag?: string }): void {
    if (!this.pendingTimerIds.delete(s.timerId)) {
      // Already cancelled or unknown; drop.
      return;
    }
    const isTimeout = s.tag === 'wait_timeout';
    const ev: HarnessEvent = isTimeout
      ? ({
          id: newEventId(),
          threadId: s.threadId,
          kind: 'external_event',
          payload: { source: 'wait_timeout', data: { timerId: s.timerId } },
          createdAt: new Date().toISOString(),
        } as HarnessEvent)
      : ({
          id: newEventId(),
          threadId: s.threadId,
          kind: 'timer_fired',
          payload: { timerId: s.timerId, ...(s.tag !== undefined ? { tag: s.tag } : {}) },
          createdAt: new Date().toISOString(),
        } as HarnessEvent);
    void this.opts.store.append(ev).then(() => this.opts.bus.publish(ev));
  }

  private async handleUsageRequest(toolCallId: ToolCallId): Promise<void> {
    // Pull-style accounting. The runner has the live counters and the
    // configured caps; we surface them here so the model can decide
    // *before* the hard wall fires. No advisory text is generated by
    // the runtime — only the raw numbers + the configured caps.
    const caps = this.opts.tokenBudget ?? {};
    await this.persistToolResult(toolCallId, {
      ok: true,
      output: {
        tokensThisTurn: this.tokensThisTurn,
        tokensThisThread: this.tokensThisThread,
        samplingCount: this.samplingIndex,
        caps: {
          ...(caps.maxTurnTokens !== undefined ? { maxTurnTokens: caps.maxTurnTokens } : {}),
          ...(caps.maxThreadTokens !== undefined
            ? { maxThreadTokens: caps.maxThreadTokens }
            : {}),
        },
      },
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
    // Cancel any timers scheduled by waits in this turn so they don't
    // fire into a dead turn (would publish stray timer_fired events
    // that re-arm a tick with no awaiting_event to wake).
    this.cancelPendingTimers();
    await this.appendEvent({
      kind: 'turn_complete',
      payload: { status, ...(summary !== undefined ? { summary } : {}) },
      ...(this.activeTurn?.turnId !== undefined ? { turnId: this.activeTurn.turnId } : {}),
    });
  }

  private cancelPendingTimers(): void {
    for (const tid of this.pendingTimerIds) {
      this.scheduler.cancel(tid);
    }
    this.pendingTimerIds.clear();
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
  if (s.kind === 'awaiting_event') return false;
  if (s.kind === 'awaiting_subtask') return false;
  if (s.kind === 'completed' || s.kind === 'interrupted' || s.kind === 'errored') return false;
  return true;
}

function parseWaitSpec(rawArgs: unknown): EventSpec {
  const a = (rawArgs ?? {}) as Record<string, unknown>;
  const matcher = typeof a.matcher === 'string' ? a.matcher : 'kind';
  switch (matcher) {
    case 'tool_result':
      if (typeof a.toolCallId === 'string') {
        return { matcher: 'tool_result', toolCallId: a.toolCallId as ToolCallId };
      }
      break;
    case 'subtask_complete':
      if (typeof a.childThreadId === 'string') {
        return { matcher: 'subtask_complete', childThreadId: a.childThreadId as ThreadId };
      }
      break;
    case 'user_input':
      return { matcher: 'user_input' };
    case 'timer':
      if (typeof a.timerId === 'string') {
        return { matcher: 'timer', timerId: a.timerId };
      }
      break;
    case 'kind':
      if (typeof a.kind === 'string') {
        return { matcher: 'kind', kind: a.kind };
      }
      break;
  }
  // Permissive fallback: any external_event wakes the turn. Without this,
  // a malformed wait would deadlock the turn until interrupt.
  return { matcher: 'kind', kind: 'external_event' };
}

function eventMatchesSpec(ev: HarnessEvent, spec: EventSpec): boolean {
  switch (spec.matcher) {
    case 'kind':
      return ev.kind === spec.kind;
    case 'tool_result':
      return ev.kind === 'tool_result' && ev.payload.toolCallId === spec.toolCallId;
    case 'subtask_complete':
      return ev.kind === 'subtask_complete' && ev.payload.childThreadId === spec.childThreadId;
    case 'user_input':
      return ev.kind === 'user_input' || ev.kind === 'user_turn_start';
    case 'timer':
      return ev.kind === 'timer_fired' && ev.payload.timerId === spec.timerId;
  }
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

function formatPinnedEntry(e: { key?: string; content: string }): string {
  return e.key ? `${e.key}: ${e.content}` : e.content;
}

// re-export for convenience
export { newToolCallId };
