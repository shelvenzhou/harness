import { newEventId } from '@harness/core/ids.js';
import type { EventBus } from '@harness/bus/eventBus.js';
import type { StreamBus, StreamEvent, StreamSubscription } from '@harness/bus/streamBus.js';
import type { ThreadId } from '@harness/core/ids.js';
import type { HarnessEvent } from '@harness/core/events.js';
import type { SessionStore } from '@harness/store/sessionStore.js';

import type { Adapter, AdapterStartOptions, SessionRouter, ThreadBinding } from './adapter.js';
import {
  RealDiscordTransport,
  type DiscordEmbed,
  type DiscordIncomingAutocomplete,
  type DiscordIncomingInteraction,
  type DiscordIncomingMessage,
  type DiscordMessageRef,
  type DiscordTransport,
} from './discordTransport.js';
import {
  attachPreviews,
  parseSessionCommand,
  recentThreads,
  resolveThreadRef,
  shortId,
  type ListedThread,
  type SessionCommand,
} from './sessionCommands.js';

/** How many recent threads /status surfaces (and /resume <idx> indexes into). */
const RECENT_LIMIT = 10;
/** Title prefix used to mark per-channel threads that have been retired by /new or /resume. */
const ARCHIVED_TITLE_PREFIX = 'discord:archived:';

/**
 * Sink that consumes a slash-command response line. The message-text
 * path uses one that posts each line as a `-#` channel message; the
 * slash-interaction path uses one that buffers lines and emits them as
 * a single `interaction.editReply()` at the end. Keeping the surface
 * an async function (vs an array sink) means status output — which
 * arrives as a single multi-line block — also flows through cleanly.
 */
type Responder = (text: string) => Promise<void>;

/** Names registered as native Discord slash commands by this adapter. */
const SLASH_COMMAND_SPECS = [
  { name: 'status', description: 'Show current thread + recent threads' },
  { name: 'new', description: 'Start a fresh thread (auto-interrupts active turn)' },
  {
    name: 'resume',
    description: 'Switch to an existing thread by index or id-prefix',
    // Autocomplete-driven: users typing `/resume ` get a dropdown of
    // recent threads with title + preview, no need to /status first.
    option: {
      name: 'target',
      description: 'Pick a recent thread (or type an id prefix)',
      required: false,
      autocomplete: true,
    },
  },
  { name: 'interrupt', description: 'Cancel the running turn' },
] as const;

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
const DEFAULT_EDIT_INTERVAL_MS = 1500;
/** Coalesce token deltas before they enter the serialized Discord output queue. */
const STREAM_BATCH_INTERVAL_MS = 250;

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
  /** True while a Discord edit request is in flight for this message. */
  editInFlight: boolean;
  /** Promise for the current in-flight edit, if any. */
  editPromise: Promise<void> | undefined;
  /** Latest text/channel to edit after the in-flight request settles. */
  queuedEdit: { channel: StreamChannel; text: string } | undefined;
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

interface PendingStreamBatch {
  segments: Array<{ channel: StreamChannel; text: string }>;
  flush: boolean;
  timer: NodeJS.Timeout | undefined;
  drainQueued: boolean;
  drainInFlight: boolean;
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
  /** Edit-throttle interval in ms. Default 1500. */
  editIntervalMs?: number;
  /**
   * Optional dev guild id. When set, slash commands register as
   * guild-scoped (instant propagation in that guild). Omit to register
   * globally (Discord may take up to an hour to surface them).
   */
  devGuildId?: string;
}

export class DiscordAdapter implements Adapter {
  readonly id = 'discord';

  private readonly store: SessionStore;
  private readonly transport: DiscordTransport;
  private readonly configuredChannelId: string | undefined;
  private readonly editIntervalMs: number;
  private readonly devGuildId: string | undefined;

  private bus: EventBus | undefined;
  private streamBus: StreamBus | undefined;
  private router: SessionRouter | undefined;
  private threadBinding: ThreadBinding | undefined;
  private subscription: { unsubscribe(): void } | undefined;
  private streamSubscription: StreamSubscription | undefined;
  /** Per-channel /status listings, used by /resume <idx>. */
  private readonly channelLastListed = new Map<string, ListedThread[]>();
  /** Serializes all Discord writes so streamed edits and bus events cannot interleave. */
  private outputTail: Promise<void> = Promise.resolve();
  private readonly channelThreads = new Map<string, ThreadId>();
  private readonly pendingChannelThreads = new Map<string, Promise<ThreadId>>();
  private readonly threadChannels = new Map<ThreadId, string>();
  private readonly states = new Map<ThreadId, DiscordThreadState>();
  private readonly pendingStreamBatches = new Map<ThreadId, PendingStreamBatch>();
  private readonly shutdownPromise: Promise<void>;
  private resolveShutdown!: () => void;

  constructor(opts: DiscordAdapterOptions) {
    this.store = opts.store;
    this.configuredChannelId = opts.channelId;
    this.editIntervalMs = opts.editIntervalMs ?? DEFAULT_EDIT_INTERVAL_MS;
    this.devGuildId = opts.devGuildId;
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
    this.streamBus = opts.streamBus;
    this.router = opts.router;
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

    this.attachSubscriptions();

    await this.transport.start({
      onMessage: (msg) => {
        void this.onIncoming(msg);
      },
      slashCommands: SLASH_COMMAND_SPECS.map((s) => ({ ...s })),
      ...(this.devGuildId !== undefined ? { devGuildId: this.devGuildId } : {}),
      onInteraction: (it) => this.onSlashInteraction(it),
      onAutocomplete: (req) => this.onAutocomplete(req),
    });
  }

  async stop(): Promise<void> {
    this.subscription?.unsubscribe();
    this.streamSubscription?.unsubscribe();
    for (const [threadId, batch] of this.pendingStreamBatches) {
      if (batch.timer) {
        clearTimeout(batch.timer);
        batch.timer = undefined;
      }
      if (!batch.drainQueued && (batch.segments.length > 0 || batch.flush)) {
        batch.drainQueued = true;
        void this.enqueueOutput(() => this.drainStreamBatch(threadId));
      }
    }
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

    const cmd = parseSessionCommand(text);
    if (cmd) {
      await this.handleSessionCommand(cmd, msg.channelId, threadId, state, (text) =>
        this.safeSendNotice(msg.channelId, text),
      );
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

  /**
   * Discord-side autocomplete: user typing into `/resume target:`
   * gets a dropdown of recent threads with index, title, and preview
   * of the first user prompt. Selecting a choice returns its `value`
   * (the thread id) to the bot, which then runs the same /resume
   * resolution path as text/typed-arg invocations.
   */
  private async onAutocomplete(req: DiscordIncomingAutocomplete): Promise<void> {
    if (req.name !== 'resume') {
      await req.respond([]);
      return;
    }
    const recent = await attachPreviews(
      this.store,
      recentThreads(await this.store.listThreads(), RECENT_LIMIT),
    );
    // Cache so a follow-up /resume <idx> on the same channel resolves
    // against the same indices the user just saw.
    this.channelLastListed.set(req.channelId, recent);
    const q = req.query.toLowerCase().trim();
    const matches = recent
      .map((t, i) => ({ t, idx: i + 1 }))
      .filter(({ t, idx }) => {
        if (q.length === 0) return true;
        return (
          t.threadId.toLowerCase().includes(q) ||
          t.title?.toLowerCase().includes(q) ||
          t.preview?.toLowerCase().includes(q) ||
          String(idx) === q
        );
      });
    const now = Date.now();
    const choices = matches.map(({ t, idx }) => {
      const age = formatAgeShort(now - Date.parse(t.updatedAt));
      // Prefer the user's first prompt over the thread title — for
      // per-channel threads the title is just `discord:<channelId>`
      // and offers no signal to the user. Falls back to title for
      // threads with no user message yet.
      const summary = t.preview ?? t.title ?? '(empty)';
      const label = truncateTo(`${idx}. ${summary}`, 90);
      return { name: `${label} · ${age}`.slice(0, 100), value: t.threadId };
    });
    await req.respond(choices);
  }

  /**
   * Native slash-command entrypoint. Bot ignores its own interactions
   * (impossible in practice but defensive). Status / new / resume go
   * through `handleSessionCommand` with a responder that buffers the
   * notice text and emits one combined `interaction.respond()` call —
   * Discord interactions only support a single primary reply, so
   * multiple notices fired by /new (e.g. interrupt notice + switch
   * confirmation) are joined with newlines into one ephemeral reply.
   *
   * /interrupt is forwarded to the existing publish path.
   */
  private async onSlashInteraction(it: DiscordIncomingInteraction): Promise<void> {
    if (it.userIsBot) return;
    if (this.configuredChannelId && it.channelId !== this.configuredChannelId) {
      await it.respond('this bot is bound to a different channel', { ephemeral: true });
      return;
    }

    if (it.name === 'interrupt') {
      const bound = this.channelThreads.get(it.channelId);
      if (!bound) {
        await it.respond('no active thread in this channel', { ephemeral: true });
        return;
      }
      await this.publishInterrupt(bound, 'user requested interrupt');
      await it.respond('⏸️ interrupt sent', { ephemeral: true });
      return;
    }

    const cmdLine =
      it.name === 'resume'
        ? `/resume${it.options.target ? ` ${it.options.target}` : ''}`
        : `/${it.name}`;
    const cmd = parseSessionCommand(cmdLine);
    if (!cmd) {
      await it.respond(`unknown command /${it.name}`, { ephemeral: true });
      return;
    }

    // Slash commands implicitly bind the channel (per-channel mode):
    // running /new in an unbound channel should be a perfectly fine
    // way to start a session, so we resolve a thread the same way an
    // @bot mention would.
    const boundThreadId = this.channelThreads.get(it.channelId);
    let threadId: ThreadId;
    if (boundThreadId) {
      threadId = boundThreadId;
    } else {
      try {
        threadId = await this.resolveThreadForChannel(it.channelId);
      } catch {
        await it.respond('this channel is not bound to a thread', { ephemeral: true });
        return;
      }
    }
    const state = this.stateFor(threadId);

    const collected: string[] = [];
    const responder: Responder = async (text) => {
      collected.push(text);
    };
    try {
      await this.handleSessionCommand(cmd, it.channelId, threadId, state, responder);
    } catch {
      await it.respond('command failed', { ephemeral: true });
      return;
    }
    await it.respond(collected.length > 0 ? collected.join('\n\n') : '✓', {
      ephemeral: true,
    });
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

  // ─── session commands (/status, /new, /resume) ────────────────────────────

  private attachSubscriptions(): void {
    if (!this.bus || !this.threadBinding) return;
    const binding = this.threadBinding;
    this.subscription = this.bus.subscribe(
      (ev) => this.enqueueOutput(() => this.handleBusEvent(ev)),
      {
        ...(binding.kind === 'single' ? { threadId: binding.threadId } : {}),
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
      },
    );

    if (this.streamBus) {
      this.streamSubscription = this.streamBus.subscribe(
        (ev) => {
          this.queueStreamEvent(ev);
        },
        binding.kind === 'single' ? { threadId: binding.threadId } : {},
      );
    }
  }

  private async handleSessionCommand(
    cmd: SessionCommand,
    channelId: string,
    threadId: ThreadId,
    state: DiscordThreadState,
    respond: Responder,
  ): Promise<void> {
    if (cmd.kind === 'status') {
      await this.renderStatusForChannel(channelId, threadId, state.turnActive, respond);
      return;
    }
    if (cmd.kind === 'new') {
      if (!this.router) {
        await respond('/new requires a session router (not wired)');
        return;
      }
      await this.maybeAutoInterrupt(threadId, state, respond);
      await this.switchChannelToNewThread(channelId, threadId, respond);
      return;
    }
    if (cmd.kind === 'resume') {
      if (!this.router) {
        await respond('/resume requires a session router (not wired)');
        return;
      }
      // Bare `/resume` returns a listing rather than an error so the
      // user can pick without running /status first. With an arg we
      // honour the cached listing if present (so the indices the user
      // saw still apply) and fall back to a fresh scan otherwise.
      if (cmd.arg === undefined) {
        await this.renderStatusForChannel(channelId, threadId, state.turnActive, respond);
        await respond('select with /resume <index> or /resume <id-prefix>');
        return;
      }
      let listed = this.channelLastListed.get(channelId) ?? [];
      if (listed.length === 0) {
        listed = recentThreads(await this.store.listThreads(), RECENT_LIMIT);
      }
      const resolved = resolveThreadRef(listed, cmd.arg);
      if (!resolved.ok) {
        await respond(resolved.message);
        return;
      }
      if (resolved.threadId === threadId) {
        await respond(`already on ${shortId(resolved.threadId)}`);
        return;
      }
      await this.maybeAutoInterrupt(threadId, state, respond);
      await this.switchChannelToExistingThread(channelId, threadId, resolved.threadId, respond);
      return;
    }
  }

  private async renderStatusForChannel(
    channelId: string,
    threadId: ThreadId,
    turnActive: boolean,
    respond: Responder,
  ): Promise<void> {
    const threads = await this.store.listThreads();
    const recent = await attachPreviews(this.store, recentThreads(threads, RECENT_LIMIT));
    this.channelLastListed.set(channelId, recent);
    const current = threads.find((t) => t.id === threadId);
    const lines: string[] = [];
    const titleSuffix = current?.title ? ` "${current.title}"` : '';
    const turnLabel = turnActive ? 'turn: running' : 'turn: idle';
    lines.push(`📍 current: \`${shortId(threadId)}\`${titleSuffix} — ${turnLabel}`);
    if (recent.length === 0) {
      lines.push('recent: (none)');
    } else {
      lines.push('recent:');
      recent.forEach((t, i) => {
        const idx = i + 1;
        const marker = t.threadId === threadId ? ' ← current' : '';
        const title = t.title ? ` "${t.title}"` : '';
        lines.push(`  ${idx}. \`${shortId(t.threadId)}\`${title}${marker}`);
        if (t.preview) lines.push(`       › ${t.preview}`);
      });
      lines.push('/resume <index|id-prefix> to switch · /new for a fresh thread');
    }
    await respond(lines.join('\n'));
  }

  /**
   * single-mode switch: configured channel rebinds to a brand-new thread.
   * per-channel switch: archive the old thread's title (so the startup scan
   * stops mapping the channel to it) and create a new thread that inherits
   * `discord:<channelId>`.
   */
  private async switchChannelToNewThread(
    channelId: string,
    oldThreadId: ThreadId,
    respond: Responder,
  ): Promise<void> {
    if (!this.router || !this.threadBinding) return;
    const binding = this.threadBinding;
    if (binding.kind === 'per-channel') {
      await this.archiveOldChannelThread(channelId, oldThreadId);
      const newId = await this.router.createThread({
        title: `${DISCORD_THREAD_TITLE_PREFIX}${channelId}`,
      });
      this.bindChannel(channelId, newId);
      this.resetThreadState(oldThreadId);
      await respond(`switched to new thread \`${shortId(newId)}\``);
    } else {
      // single mode: re-subscribe with the new threadId.
      const newId = await this.router.createThread();
      this.subscription?.unsubscribe();
      this.streamSubscription?.unsubscribe();
      this.subscription = undefined;
      this.streamSubscription = undefined;
      this.threadBinding = { kind: 'single', threadId: newId };
      this.bindChannel(channelId, newId);
      this.resetThreadState(oldThreadId);
      this.attachSubscriptions();
      await respond(`switched to new thread \`${shortId(newId)}\``);
    }
  }

  private async switchChannelToExistingThread(
    channelId: string,
    oldThreadId: ThreadId,
    targetThreadId: ThreadId,
    respond: Responder,
  ): Promise<void> {
    if (!this.router || !this.threadBinding) return;
    const binding = this.threadBinding;
    await this.router.adoptThread(targetThreadId);
    if (binding.kind === 'per-channel') {
      await this.archiveOldChannelThread(channelId, oldThreadId);
      // Hand the discord:<channelId> title to the target so the next
      // restart's startup scan rebinds the channel to it.
      try {
        await this.store.updateThread(targetThreadId, {
          title: `${DISCORD_THREAD_TITLE_PREFIX}${channelId}`,
        });
      } catch {
        // updateThread can fail if the thread vanished underneath us;
        // the bind below still works for the live process.
      }
      this.bindChannel(channelId, targetThreadId);
      this.resetThreadState(oldThreadId);
      await respond(`resumed thread \`${shortId(targetThreadId)}\``);
    } else {
      this.subscription?.unsubscribe();
      this.streamSubscription?.unsubscribe();
      this.subscription = undefined;
      this.streamSubscription = undefined;
      this.threadBinding = { kind: 'single', threadId: targetThreadId };
      this.bindChannel(channelId, targetThreadId);
      this.resetThreadState(oldThreadId);
      this.attachSubscriptions();
      await respond(`resumed thread \`${shortId(targetThreadId)}\``);
    }
  }

  private async archiveOldChannelThread(channelId: string, oldThreadId: ThreadId): Promise<void> {
    try {
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      await this.store.updateThread(oldThreadId, {
        title: `${ARCHIVED_TITLE_PREFIX}${channelId}:${stamp}`,
      });
    } catch {
      // If the rename fails, the new thread still claims discord:<channelId>;
      // worst case the startup scan finds two and the later one wins.
    }
    this.threadChannels.delete(oldThreadId);
  }

  private resetThreadState(threadId: ThreadId): void {
    const state = this.states.get(threadId);
    if (!state) return;
    if (state.live?.pendingTimer) clearTimeout(state.live.pendingTimer);
    state.live = undefined;
    state.streamed = { reply: '', preamble: '', reasoning: '' };
    state.flushed = false;
    state.toolCallRefs.clear();
    state.turnActive = false;
  }

  private async maybeAutoInterrupt(
    threadId: ThreadId,
    state: DiscordThreadState,
    respond: Responder,
  ): Promise<void> {
    if (!state.turnActive) return;
    await this.publishInterrupt(threadId, 'session switch');
    await respond('interrupting current turn before switching');
  }

  private async safeSendNotice(channelId: string, text: string): Promise<void> {
    // Discord subtext (`-#`) only applies to the line it's on, so a
    // multi-line notice (e.g. /status output) needs the prefix per
    // line. Single-line notices behave the same as before.
    const prefixed = text
      .split('\n')
      .map((l) => `-# ${l}`)
      .join('\n');
    try {
      await this.transport.sendText(channelId, prefixed);
    } catch {
      // Notice is cosmetic — never crash on transport failure.
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
    await this.drainPendingStreamBeforeBusEvent(ev.threadId);
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

  private queueStreamEvent(ev: StreamEvent): void {
    const channelId = this.threadChannels.get(ev.threadId);
    if (!channelId) return;

    const batch = this.streamBatchFor(ev.threadId);
    if (ev.kind === 'sampling_flush') {
      batch.flush = true;
      this.scheduleStreamDrain(ev.threadId, true);
      return;
    }

    if (ev.kind === 'reasoning_delta') {
      // Discord renders persisted reasoning only; do not let partial
      // reasoning deltas build up a serialized backlog.
      return;
    }

    const channel: StreamChannel = ev.channel ?? 'reply';
    const last = batch.segments[batch.segments.length - 1];
    if (last && last.channel === channel) {
      last.text += ev.text;
    } else {
      batch.segments.push({ channel, text: ev.text });
    }
    this.scheduleStreamDrain(ev.threadId, false);
  }

  private streamBatchFor(threadId: ThreadId): PendingStreamBatch {
    let batch = this.pendingStreamBatches.get(threadId);
    if (!batch) {
      batch = {
        segments: [],
        flush: false,
        timer: undefined,
        drainQueued: false,
        drainInFlight: false,
      };
      this.pendingStreamBatches.set(threadId, batch);
    }
    return batch;
  }

  private scheduleStreamDrain(threadId: ThreadId, immediate: boolean): void {
    const batch = this.streamBatchFor(threadId);
    if (batch.drainQueued || batch.drainInFlight) return;

    if (immediate) {
      if (batch.timer) {
        clearTimeout(batch.timer);
        batch.timer = undefined;
      }
      batch.drainQueued = true;
      void this.enqueueOutput(() => this.drainStreamBatch(threadId));
      return;
    }

    if (batch.timer) return;
    batch.timer = setTimeout(() => {
      batch.timer = undefined;
      if (batch.drainQueued || batch.drainInFlight) return;
      batch.drainQueued = true;
      void this.enqueueOutput(() => this.drainStreamBatch(threadId));
    }, STREAM_BATCH_INTERVAL_MS);
  }

  private async drainStreamBatch(threadId: ThreadId): Promise<void> {
    const batch = this.pendingStreamBatches.get(threadId);
    if (!batch) return;

    batch.drainQueued = false;
    batch.drainInFlight = true;
    if (batch.timer) {
      clearTimeout(batch.timer);
      batch.timer = undefined;
    }

    try {
      for (;;) {
        const segments = batch.segments;
        const flush = batch.flush;
        batch.segments = [];
        batch.flush = false;
        if (segments.length === 0 && !flush) break;

        const channelId = this.threadChannels.get(threadId);
        if (channelId) {
          const state = this.stateFor(threadId);
          await this.handleStreamBatch(state, channelId, { segments, flush });
        }

        if (batch.segments.length === 0 && !batch.flush) break;
      }
    } finally {
      batch.drainInFlight = false;
      if (batch.segments.length > 0 || batch.flush) {
        this.scheduleStreamDrain(threadId, batch.flush);
      } else if (!batch.timer && !batch.drainQueued) {
        this.pendingStreamBatches.delete(threadId);
      }
    }
  }

  private async drainPendingStreamBeforeBusEvent(threadId: ThreadId): Promise<void> {
    const batch = this.pendingStreamBatches.get(threadId);
    if (!batch) return;
    if (batch.segments.length === 0 && !batch.flush) return;
    if (batch.drainInFlight) return;
    if (batch.timer) {
      clearTimeout(batch.timer);
      batch.timer = undefined;
    }
    await this.drainStreamBatch(threadId);
  }

  private async handleStreamBatch(
    state: DiscordThreadState,
    channelId: string,
    batch: { segments: Array<{ channel: StreamChannel; text: string }>; flush: boolean },
  ): Promise<void> {
    if (state.flushed && batch.segments.length > 0) {
      state.streamed.reply = '';
      state.streamed.preamble = '';
      state.streamed.reasoning = '';
      state.flushed = false;
    }

    for (const segment of batch.segments) {
      await this.appendDelta(state, channelId, segment.channel, segment.text);
    }

    if (batch.flush) {
      await this.flushLive(state);
      state.flushed = true;
    }
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
      editInFlight: false,
      editPromise: undefined,
      queuedEdit: undefined,
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
    if (state.live.editInFlight) {
      state.live.queuedEdit = { channel: state.live.channel, text: state.live.text };
      return;
    }
    const elapsed = Date.now() - state.live.lastEditAt;
    const wait = Math.max(0, this.editIntervalMs - elapsed);
    state.live.pendingTimer = setTimeout(() => {
      void this.fireScheduledEdit(state);
    }, wait);
  }

  private async fireScheduledEdit(state: DiscordThreadState): Promise<void> {
    if (!state.live) return;
    state.live.pendingTimer = undefined;
    if (state.live.editInFlight) {
      state.live.queuedEdit = { channel: state.live.channel, text: state.live.text };
      return;
    }
    await this.editLiveNow(state, state.live.text);
  }

  private async editLiveNow(state: DiscordThreadState, text: string): Promise<void> {
    const live = state.live;
    if (!live) return;
    if (live.editInFlight) {
      live.queuedEdit = { channel: live.channel, text };
      return;
    }
    live.editInFlight = true;
    const channel = live.channel;
    const rendered = renderForChannel(channel, text);
    const editPromise = this.transport.editText(live.ref, rendered);
    live.editPromise = editPromise;
    try {
      await editPromise;
      if (state.live === live) live.lastEditAt = Date.now();
    } catch {
      // Drop edit failures silently — the persisted reply event will
      // post a fallback message at sampling end.
    } finally {
      live.editInFlight = false;
      if (live.editPromise === editPromise) live.editPromise = undefined;
      if (state.live === live && live.queuedEdit) {
        const next = live.queuedEdit;
        live.queuedEdit = undefined;
        live.channel = next.channel;
        live.text = next.text;
        this.scheduleEdit(state);
      }
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
    live.queuedEdit = undefined;
    if (live.editPromise) {
      try {
        await live.editPromise;
      } catch {
        // editLiveNow handles failures; this await is only ordering.
      }
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

function formatAgeShort(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return 'now';
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h`;
  return `${Math.floor(hr / 24)}d`;
}

function truncateTo(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1)}…`;
}
