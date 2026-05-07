import { newEventId } from '@harness/core/ids.js';
import type { EventBus } from '@harness/bus/eventBus.js';
import type { StreamEvent, StreamSubscription } from '@harness/bus/streamBus.js';
import type { ThreadId } from '@harness/core/ids.js';
import type { HarnessEvent } from '@harness/core/events.js';
import type { SessionStore } from '@harness/store/sessionStore.js';

import type { Adapter, AdapterStartOptions, ThreadBinding } from './adapter.js';
import {
  RealDiscordTransport,
  type DiscordEmbed,
  type DiscordIncomingMessage,
  type DiscordMessageRef,
  type DiscordTransport,
} from './discordTransport.js';

/**
 * DiscordAdapter — Discord channel/thread bridge.
 *
 * In `single` mode one Discord channel binds to one harness thread.
 * In `per-channel` mode, the first @bot message in each Discord
 * channel resolves/creates a harness thread and all later messages in
 * that channel stay on that thread.
 *
 *   - replies / preambles stream live by editing the latest
 *     "live message" up to a soft cap, then continuing in a new message.
 *     Channel switches close the previous live message. Reasoning deltas are
 *     not streamed live on Discord; the persisted reasoning event is rendered
 *     once to avoid partial and duplicated thinking blocks.
 *   - tool_call / tool_result / subtask_complete / compaction_event /
 *     turn_complete / interrupt land as discrete embed messages.
 *
 * Author filter: the adapter's own bot user is suppressed; everything
 * else in the bound channel is treated as operator input. (The single
 * private server makes finer ACLs unnecessary in v1.)
 */

/** Soft cap below Discord's 2000-char message limit; leaves margin for prefixes. */
const SOFT_CAP = 1900;
/** Throttle live edits to stay well under Discord's edit rate limit. */
const DEFAULT_EDIT_INTERVAL_MS = 750;

type StreamChannel = 'reply' | 'preamble' | 'reasoning';

interface LiveMessage {
  channel: StreamChannel;
  ref: DiscordMessageRef;
  /** Accumulated text since the message was opened (without prefix). */
  text: string;
  /** Wall-clock of the most recent edit that actually went out. */
  lastEditAt: number;
  /** Pending throttle timer that will flush the latest text. */
  pendingTimer: NodeJS.Timeout | undefined;
  /** True if the message has hit SOFT_CAP and a continuation is owed. */
  full: boolean;
}

interface DiscordThreadState {
  turnActive: boolean;
  live: LiveMessage | undefined;
  streamed: Record<StreamChannel, string>;
  flushed: boolean;
  toolCallRefs: Map<string, { ref: DiscordMessageRef; rendered: string }>;
}

/** Title prefix used to persist Discord channel → thread mappings. */
export const DISCORD_THREAD_TITLE_PREFIX = 'discord:';

export interface DiscordAdapterOptions {
  store: SessionStore;
  transport?: DiscordTransport;
  /** Bot token — required when no `transport` is supplied. */
  token?: string;
  /** Optional channel to bind to. Omit for @bot-triggered channel binding. */
  channelId?: string;
  /** Edit-throttle interval in ms. Default 750. */
  editIntervalMs?: number;
}

export class DiscordAdapter implements Adapter {
  readonly id = 'discord';

  private readonly store: SessionStore;
  private readonly transport: DiscordTransport;
  private readonly configuredChannelId: string | undefined;
  private readonly editIntervalMs: number;

  private bus?: EventBus;
  private threadBinding?: ThreadBinding;
  private subscription?: { unsubscribe(): void };
  private streamSubscription?: StreamSubscription;
  /** Serializes all Discord writes so streamed edits and bus events cannot interleave. */
  private outputTail: Promise<void> = Promise.resolve();
  private readonly channelThreads = new Map<string, ThreadId>();
  private readonly pendingChannelThreads = new Map<string, Promise<ThreadId>>();
  private readonly threadChannels = new Map<ThreadId, string>();
  private readonly states = new Map<ThreadId, DiscordThreadState>();
  private readonly shutdownPromise: Promise<void>;
  private resolveShutdown!: () => void;

  constructor(opts: DiscordAdapterOptions) {
    this.store = opts.store;
    this.configuredChannelId = opts.channelId;
    this.editIntervalMs = opts.editIntervalMs ?? DEFAULT_EDIT_INTERVAL_MS;
    if (opts.transport) {
      this.transport = opts.transport;
    } else {
      if (!opts.token) {
        throw new Error('DiscordAdapter: either transport or token must be provided');
      }
      this.transport = new RealDiscordTransport({ token: opts.token });
    }
    this.shutdownPromise = new Promise<void>((resolve) => {
      this.resolveShutdown = resolve;
    });
  }

  whenShutdown(): Promise<void> {
    return this.shutdownPromise;
  }

  async start(opts: AdapterStartOptions): Promise<void> {
    this.bus = opts.bus;
    this.threadBinding = opts.threadBinding;
    if (opts.threadBinding.kind === 'single' && this.configuredChannelId) {
      this.bindChannel(this.configuredChannelId, opts.threadBinding.threadId);
    }

    // Restore previously-bound channels (per-channel mode). Threads
    // created via per-channel binding are titled `discord:<channelId>`,
    // so a startup scan rebuilds the channelThreads map and ensures the
    // runtime starts a runner for each one. Without this, a non-mention
    // follow-up after a restart would be ignored.
    if (opts.threadBinding.kind === 'per-channel') {
      const binding = opts.threadBinding;
      const threads = await this.store.listThreads();
      for (const t of threads) {
        if (!t.title?.startsWith(DISCORD_THREAD_TITLE_PREFIX)) continue;
        const channelId = t.title.slice(DISCORD_THREAD_TITLE_PREFIX.length);
        if (!channelId) continue;
        try {
          // resolve() is the runtime's "ensure runner exists" entrypoint
          // — for an existing channel it adopts the stored thread; for
          // a brand-new one it creates a fresh thread. Either way the
          // returned id matches the persisted mapping.
          const threadId = await binding.resolve(channelId);
          this.bindChannel(channelId, threadId);
        } catch {
          // Skip channels whose runner couldn't be restored — the next
          // inbound mention will retry.
        }
      }
    }

    this.subscription = opts.bus.subscribe((ev) => this.enqueueOutput(() => this.handleBusEvent(ev)), {
      ...(opts.threadBinding.kind === 'single' ? { threadId: opts.threadBinding.threadId } : {}),
      kinds: [
        'reply',
        'preamble',
        'reasoning',
        'tool_call',
        'tool_result',
        'subtask_complete',
        'turn_complete',
        'compaction_event',
        'interrupt',
      ],
    });

    if (opts.streamBus) {
      this.streamSubscription = opts.streamBus.subscribe(
        (ev) => {
          void this.enqueueOutput(() => this.handleStreamEvent(ev));
        },
        opts.threadBinding.kind === 'single' ? { threadId: opts.threadBinding.threadId } : {},
      );
    }

    await this.transport.start({
      onMessage: (msg) => {
        void this.onIncoming(msg);
      },
    });
  }

  async stop(): Promise<void> {
    this.subscription?.unsubscribe();
    this.streamSubscription?.unsubscribe();
    await this.outputTail;
    for (const state of this.states.values()) {
      if (state.live?.pendingTimer) {
        clearTimeout(state.live.pendingTimer);
      }
      state.live = undefined;
    }
    await this.transport.stop();
    this.resolveShutdown();
  }

  // ─── inbound: Discord → bus ────────────────────────────────────────────

  private async onIncoming(msg: DiscordIncomingMessage): Promise<void> {
    if (msg.authorIsBot) return;
    const binding = this.threadBinding;
    if (!binding) return;
    if (this.configuredChannelId && msg.channelId !== this.configuredChannelId) return;

    const boundThreadId = this.channelThreads.get(msg.channelId);
    if (!boundThreadId && !this.configuredChannelId && !msg.mentionedBot) return;

    const wasBound = boundThreadId !== undefined;
    const threadId = boundThreadId ?? (await this.resolveThreadForChannel(msg.channelId));
    const state = this.stateFor(threadId);
    const text = stripBotMention(msg.content, msg.botUserId).trim();
    if (!text) {
      // Bare @bot with no other content. The channel is now bound (via
      // resolveThreadForChannel above); acknowledge the binding so the
      // user knows the bot is listening, but don't start a turn.
      if (!wasBound) {
        try {
          await this.transport.sendText(
            msg.channelId,
            "-# 👋 ready — send a message and I'll respond.",
          );
        } catch {
          // Greeting is cosmetic; binding still happened.
        }
      }
      return;
    }

    if (text === '/interrupt') {
      await this.publishInterrupt(threadId, 'user requested interrupt');
      return;
    }

    if (state.turnActive) {
      await this.publishUserInput(threadId, text);
    } else {
      state.turnActive = true;
      await this.publishUserTurnStart(threadId, text);
      await this.safeStartTyping(msg.channelId);
    }
  }

  private async resolveThreadForChannel(channelId: string): Promise<ThreadId> {
    const existing = this.channelThreads.get(channelId);
    if (existing) return existing;
    const pending = this.pendingChannelThreads.get(channelId);
    if (pending) return pending;
    const binding = this.threadBinding;
    if (!binding) throw new Error('DiscordAdapter: not started');
    const promise = (async () => {
      const threadId =
        binding.kind === 'single' ? binding.threadId : await binding.resolve(channelId);
      this.bindChannel(channelId, threadId);
      return threadId;
    })();
    this.pendingChannelThreads.set(channelId, promise);
    try {
      return await promise;
    } finally {
      this.pendingChannelThreads.delete(channelId);
    }
  }

  private bindChannel(channelId: string, threadId: ThreadId): void {
    this.channelThreads.set(channelId, threadId);
    this.threadChannels.set(threadId, channelId);
    this.stateFor(threadId);
  }

  private stateFor(threadId: ThreadId): DiscordThreadState {
    const existing = this.states.get(threadId);
    if (existing) return existing;
    const state: DiscordThreadState = {
      turnActive: false,
      live: undefined,
      streamed: { reply: '', preamble: '', reasoning: '' },
      flushed: false,
      toolCallRefs: new Map(),
    };
    this.states.set(threadId, state);
    return state;
  }

  private async publishUserTurnStart(threadId: ThreadId, text: string): Promise<void> {
    const event = await this.store.append({
      id: newEventId(),
      threadId,
      kind: 'user_turn_start',
      payload: { text },
    });
    this.bus!.publish(event);
  }

  private async publishUserInput(threadId: ThreadId, text: string): Promise<void> {
    const event = await this.store.append({
      id: newEventId(),
      threadId,
      kind: 'user_input',
      payload: { text },
    });
    this.bus!.publish(event);
  }

  private async publishInterrupt(threadId: ThreadId, reason: string): Promise<void> {
    const event = await this.store.append({
      id: newEventId(),
      threadId,
      kind: 'interrupt',
      payload: { reason },
    });
    this.bus!.publish(event);
  }

  private async safeStartTyping(channelId: string): Promise<void> {
    try {
      await this.transport.startTyping(channelId);
    } catch {
      // Typing indicator is cosmetic — never fail a turn over it.
    }
  }

  // ─── outbound: bus → Discord ───────────────────────────────────────────

  private enqueueOutput(task: () => Promise<void>): Promise<void> {
    const run = this.outputTail.then(task, task);
    this.outputTail = run.catch(() => {
      // Per-event handlers already swallow Discord failures; keep the
      // serializer alive even if a future handler regresses.
    });
    return run;
  }

  private async handleBusEvent(ev: HarnessEvent): Promise<void> {
    const channelId = this.threadChannels.get(ev.threadId);
    if (!channelId) return;
    const state = this.stateFor(ev.threadId);
    try {
      switch (ev.kind) {
        case 'preamble': {
          await this.renderPersistedText(state, channelId, 'preamble', ev.payload.text);
          break;
        }
        case 'reply': {
          if (ev.payload.internal) break;
          await this.renderPersistedText(state, channelId, 'reply', ev.payload.text);
          break;
        }
        case 'reasoning': {
          const text = ev.payload.text;
          if (!text) break;
          await this.flushLive(state);
          await this.postFallback(channelId, 'reasoning', text);
          break;
        }
        case 'tool_call': {
          if (isQuietTool(ev.payload.name)) break;
          await this.flushLive(state);
          const summary = formatToolCallSummary(ev.payload.name, ev.payload.args);
          const rendered = `-# 🔧 ${summary}`;
          const ref = await this.transport.sendText(channelId, rendered);
          state.toolCallRefs.set(ev.payload.toolCallId, { ref, rendered });
          break;
        }
        case 'tool_result': {
          if (isQuietToolResult(ev.payload.output)) {
            state.toolCallRefs.delete(ev.payload.toolCallId);
            break;
          }
          await this.flushLive(state);
          const entry = state.toolCallRefs.get(ev.payload.toolCallId);
          if (ev.payload.ok) {
            // Edit the original tool_call line to mark completion in-place.
            // Falls back to a new line if we never recorded the ref.
            if (entry) {
              const updated = entry.rendered.replace('🔧', '✓');
              try {
                await this.transport.editText(entry.ref, updated);
              } catch {
                // Edit failures are cosmetic — the call line stays as-is.
              }
            }
          } else {
            await this.transport.sendText(
              channelId,
              `-# ✗ tool failed: ${formatErrorInline(ev.payload.error)}`,
            );
          }
          state.toolCallRefs.delete(ev.payload.toolCallId);
          break;
        }
        case 'subtask_complete': {
          await this.flushLive(state);
          const p = ev.payload;
          const fields: DiscordEmbed['fields'] = [
            { name: 'status', value: p.status, inline: true },
            { name: 'thread', value: shortenId(p.childThreadId), inline: true },
          ];
          if (p.budget) {
            fields.push({
              name: 'budget',
              value: `${p.budget.reason} · turns=${p.budget.turnsUsed} · tools=${p.budget.toolCallsUsed} · tokens=${p.budget.tokensUsed}`,
              inline: false,
            });
          }
          await this.transport.sendEmbed(channelId, {
            title: '↩️ subtask complete',
            ...(p.summary ? { description: truncateForEmbed(p.summary) } : {}),
            color: p.status === 'completed' ? 0x57f287 : 0xfee75c,
            fields,
            ...(p.reason !== undefined ? { footer: `reason: ${p.reason}` } : {}),
          });
          break;
        }
        case 'turn_complete': {
          await this.flushLive(state);
          const p = ev.payload;
          if (p.status !== 'completed') {
            const detail =
              p.summary && p.reason
                ? `${p.summary} (reason: ${p.reason})`
                : (p.summary ?? p.reason ?? '');
            await this.transport.sendText(
              channelId,
              `-# turn ${p.status}${detail ? ` — ${detail}` : ''}`,
            );
          }
          state.turnActive = false;
          break;
        }
        case 'compaction_event': {
          await this.flushLive(state);
          const p = ev.payload;
          await this.transport.sendText(
            channelId,
            `-# 🗜️ compacted (${p.reason}): ${p.tokensBefore} → ${p.tokensAfter} tok`,
          );
          break;
        }
        case 'interrupt': {
          await this.flushLive(state);
          const reason = ev.payload.reason ? ` — ${ev.payload.reason}` : '';
          await this.transport.sendText(channelId, `-# ⏸️ interrupt${reason}`);
          break;
        }
        default:
          break;
      }
    } catch {
      // Discord errors must never take the runtime down. Best-effort
      // surface only — diagnostics layer subscribes separately.
    }
  }

  // ─── stream rendering ──────────────────────────────────────────────────

  private async handleStreamEvent(ev: StreamEvent): Promise<void> {
    const channelId = this.threadChannels.get(ev.threadId);
    if (!channelId) return;
    const state = this.stateFor(ev.threadId);
    if (ev.kind === 'sampling_flush') {
      await this.flushLive(state);
      state.flushed = true;
      return;
    }
    if (state.flushed) {
      state.streamed.reply = '';
      state.streamed.preamble = '';
      state.streamed.reasoning = '';
      state.flushed = false;
    }
    if (ev.kind === 'reasoning_delta') {
      // Discord only renders the persisted reasoning event. Streaming
      // reasoning deltas are often partial and are followed by the full event,
      // so showing both creates duplicated, out-of-order thinking blocks.
      return;
    }
    const channel: StreamChannel = ev.channel ?? 'reply';
    await this.appendDelta(state, channelId, channel, ev.text);
  }

  private async appendDelta(
    state: DiscordThreadState,
    channelId: string,
    channel: StreamChannel,
    text: string,
  ): Promise<void> {
    if (!text) return;
    state.streamed[channel] += text;

    if (state.live && state.live.channel !== channel) {
      await this.flushLive(state);
    }

    if (state.live && renderedLength(channel, state.live.text + text) > SOFT_CAP) {
      state.live.full = true;
      await this.flushLive(state);
    }

    const chunks = chunkTextForChannel(channel, text, SOFT_CAP);
    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i]!;
      if (!state.live) {
        const ref = await this.transport.sendText(channelId, renderForChannel(channel, chunk));
        this.openLive(state, channel, ref, chunk);
      } else {
        state.live.text += chunk;
        this.scheduleEdit(state);
      }

      if (i < chunks.length - 1 && state.live) {
        state.live.full = true;
        await this.flushLive(state);
      }
    }
  }

  private openLive(
    state: DiscordThreadState,
    channel: StreamChannel,
    ref: DiscordMessageRef,
    text: string,
  ): void {
      state.live = {
        channel,
        ref,
        text,
        lastEditAt: Date.now(),
        pendingTimer: undefined,
        full: renderedLength(channel, text) >= SOFT_CAP,
      };
  }

  /**
   * Throttled edit: at most one in-flight edit per `editIntervalMs`. If
   * a delta arrives while the throttle window is still open, we just
   * update `live.text` and let the pending timer pick up the latest
   * value when it fires.
   */
  private scheduleEdit(state: DiscordThreadState): void {
    if (!state.live) return;
    if (state.live.pendingTimer) return;
    const elapsed = Date.now() - state.live.lastEditAt;
    const wait = Math.max(0, this.editIntervalMs - elapsed);
    state.live.pendingTimer = setTimeout(() => {
      void this.fireScheduledEdit(state);
    }, wait);
  }

  private async fireScheduledEdit(state: DiscordThreadState): Promise<void> {
    if (!state.live) return;
    state.live.pendingTimer = undefined;
    await this.editLiveNow(state, state.live.text);
  }

  private async editLiveNow(state: DiscordThreadState, text: string): Promise<void> {
    if (!state.live) return;
    const rendered = renderForChannel(state.live.channel, text);
    try {
      await this.transport.editText(state.live.ref, rendered);
      if (state.live) state.live.lastEditAt = Date.now();
    } catch {
      // Drop edit failures silently — the persisted reply event will
      // post a fallback message at sampling end.
    }
  }

  /**
   * Close any live message and wait for its final edit to land. Called
   * before any discrete bus event renders so messages don't get
   * interleaved with a still-mutating live block.
   *
   * Reasoning-echo guard: the model frequently emits its reasoning
   * summary as preflight text (e.g. `[reasoning] **Title**\n\n…`)
   * because pruning.ts projects past reasoning back as `[reasoning] X`
   * assistant content and the model parrots that pattern in the next
   * sample. We detect that prefix here and re-edit the live message
   * with the gray reasoning rendering (and strip the marker), so the
   * user sees one gray block per reasoning instead of black + gray.
   */
  private async flushLive(state: DiscordThreadState): Promise<void> {
    if (!state.live) return;
    const live = state.live;
    if (live.pendingTimer) {
      clearTimeout(live.pendingTimer);
      live.pendingTimer = undefined;
    }
    let renderChannel = live.channel;
    let renderText = live.text;
    if (live.channel !== 'reasoning') {
      const stripped = stripReasoningEchoPrefix(live.text);
      if (stripped !== null) {
        renderChannel = 'reasoning';
        renderText = stripped;
        live.channel = 'reasoning';
      }
    }
    try {
      await this.transport.editText(live.ref, renderForChannel(renderChannel, renderText));
      live.lastEditAt = Date.now();
    } catch {
      // Drop edit failures silently — the persisted reply event will
      // post a fallback message at sampling end.
    }
    state.live = undefined;
  }

  /**
   * Render a persisted reply / preamble. Dedupes against the streamed
   * buffer (any channel — provider may have classified differently than
   * the live render). Reasoning-echo content (`[reasoning] X`) is
   * rerouted to the gray reasoning rendering so it renders once,
   * consistently with the prefix stripped.
   */
  private async renderPersistedText(
    state: DiscordThreadState,
    channelId: string,
    persistedChannel: 'reply' | 'preamble',
    text: string,
  ): Promise<void> {
    if (!text) return;
    if (this.consumeStreamed(state, text)) return;
    await this.flushLive(state);
    const stripped = stripReasoningEchoPrefix(text);
    const renderChannel: StreamChannel = stripped !== null ? 'reasoning' : persistedChannel;
    const renderText = stripped ?? text;
    await this.postFallback(channelId, renderChannel, renderText);
  }

  /**
   * Persisted reply/preamble/reasoning event arrived but the streamed
   * buffer didn't match (provider didn't emit deltas, or the parser
   * reclassified the channel mid-stream). Post a fresh formatted block.
   */
  private async postFallback(
    channelId: string,
    channel: StreamChannel,
    text: string,
  ): Promise<void> {
    if (!text) return;
    const chunks = chunkTextForChannel(channel, text, SOFT_CAP);
    for (const chunk of chunks) {
      await this.transport.sendText(channelId, renderForChannel(channel, chunk));
    }
  }

  /**
   * Mark a streamed buffer consumed if the persisted text matches it on
   * any channel. Untagged deltas stream as reply but the parser may
   * classify them as preamble; reasoning-echo deltas are reclassified
   * to reasoning at flushLive. Either way, the streamed buffer that
   * actually matches the persisted event wins.
   */
  private consumeStreamed(state: DiscordThreadState, text: string): boolean {
    if (text.length === 0) return false;
    const channels: StreamChannel[] = ['reply', 'preamble', 'reasoning'];
    for (const ch of channels) {
      if (state.streamed[ch] === text) {
        state.streamed[ch] = '';
        return true;
      }
    }
    return false;
  }
}

// ─── formatting helpers ──────────────────────────────────────────────────

/**
 * Detect a model "[reasoning] …" preamble echo and return the stripped
 * body, or null if the text isn't an echo. Drops a single leading space
 * or newline after the marker so the rendered body doesn't start with
 * extra whitespace inside the quote block.
 */
function stripReasoningEchoPrefix(text: string): string | null {
  if (!text.startsWith('[reasoning]')) return null;
  let body = text.slice('[reasoning]'.length);
  if (body.startsWith(' ') || body.startsWith('\n')) body = body.slice(1);
  return body;
}

function renderForChannel(channel: StreamChannel, text: string): string {
  // Discord prefix conventions:
  //   reply     → plain markdown (the bot avatar already identifies it)
  //   preamble  → -# subtext + leading › on each line (most discreet)
  //   reasoning → quote block (`> `) on each line — visible thinking
  //               surface, but without a per-line emoji marker which
  //               would be too heavy on multi-line blocks.
  if (channel === 'reply') return text;
  if (channel === 'preamble') return prefixLines(text, '-# › ');
  return prefixLines(text, '> ');
}

function renderedLength(channel: StreamChannel, text: string): number {
  return renderForChannel(channel, text).length;
}

function prefixLines(text: string, prefix: string): string {
  return text
    .split('\n')
    .map((line) => `${prefix}${line}`)
    .join('\n');
}

function stripBotMention(content: string, botUserId: string | undefined): string {
  if (!botUserId) return content;
  return content.replace(new RegExp(`<@!?${escapeRegExp(botUserId)}>\\s*`, 'g'), '');
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function chunkTextForChannel(channel: StreamChannel, text: string, max: number): string[] {
  if (renderedLength(channel, text) <= max) return [text];
  const out: string[] = [];
  let i = 0;
  while (i < text.length) {
    let end = fittingPrefixLength(channel, text.slice(i), max);
    if (end < text.length) {
      const absoluteEnd = i + end;
      const lastBreak = text.lastIndexOf('\n', absoluteEnd);
      if (lastBreak > i + end / 2) end = lastBreak - i + 1;
    }
    out.push(text.slice(i, i + end));
    i += end;
  }
  return out;
}

function fittingPrefixLength(channel: StreamChannel, text: string, max: number): number {
  if (renderedLength(channel, text) <= max) return text.length;
  let lo = 1;
  let hi = text.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (renderedLength(channel, text.slice(0, mid)) <= max) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

function truncateForEmbed(text: string): string {
  // Discord embed description hard cap is 4096; keep margin for code
  // fences and continuation marker.
  const max = 3800;
  if (text.length <= max) return text;
  return text.slice(0, max) + '\n…[truncated]';
}

function isQuietTool(name: string): boolean {
  return name === 'wait' || name === 'session';
}

function isQuietToolResult(output: unknown): boolean {
  if (!isRecord(output)) return false;
  if (output['status'] === 'running' && typeof output['sessionId'] === 'string') return true;
  if (output['scheduled'] === true && typeof output['matcher'] === 'string') return true;
  return false;
}

function formatToolCallSummary(name: string, args: unknown): string {
  const suffix = toolSummarySuffix(name, args);
  return suffix ? `${name} ${suffix}` : name;
}

function toolSummarySuffix(name: string, args: unknown): string {
  if (!isRecord(args)) return '';
  const value =
    name === 'shell'
      ? args['cmd']
      : name === 'read' || name === 'write'
        ? args['path']
        : name === 'web_fetch'
          ? args['url']
          : name === 'web_search'
            ? args['query']
            : firstStringArg(args);
  return typeof value === 'string' && value.length > 0 ? inlineCode(value, 120) : '';
}

function firstStringArg(args: Record<string, unknown>): unknown {
  for (const value of Object.values(args)) {
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return undefined;
}

function inlineCode(text: string, max: number): string {
  const cleaned = text.replace(/\s+/g, ' ').trim();
  const truncated = cleaned.length > max ? `${cleaned.slice(0, max - 1)}…` : cleaned;
  return `\`${truncated.replace(/`/g, "'")}\``;
}

function formatErrorInline(err: { kind: string; message: string } | undefined): string {
  if (!err) return 'no error detail';
  return `${err.kind}: ${err.message}`.slice(0, 300);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function shortenId(id: string): string {
  return id.length > 12 ? id.slice(0, 8) + '…' + id.slice(-3) : id;
}
