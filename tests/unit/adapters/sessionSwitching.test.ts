import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';

import { DiscordAdapter, DISCORD_THREAD_TITLE_PREFIX } from '@harness/adapters/discord.js';
import type {
  DiscordAutocompleteChoice,
  DiscordAutocompleteHandler,
  DiscordIncomingAutocomplete,
  DiscordIncomingHandler,
  DiscordIncomingInteraction,
  DiscordIncomingMessage,
  DiscordEmbed,
  DiscordInteractionHandler,
  DiscordMessageRef,
  DiscordSlashCommandSpec,
  DiscordTransport,
} from '@harness/adapters/discordTransport.js';
import type { SessionRouter } from '@harness/adapters/adapter.js';
import { TerminalAdapter } from '@harness/adapters/terminal.js';
import { EventBus } from '@harness/bus/eventBus.js';
import { newRootTraceparent } from '@harness/core/traceparent.js';
import { newThreadId, type ThreadId } from '@harness/core/ids.js';
import { MemorySessionStore } from '@harness/store/index.js';
import type { HarnessEvent } from '@harness/core/events.js';

/**
 * /status, /new, /resume across the terminal and Discord adapters.
 *
 * Terminal: the only in-process consumer of the bound thread, so a switch
 *   means unsubscribe + resubscribe. We assert the next user line lands
 *   on the new thread (not the old one).
 *
 * Discord per-channel: the channel→thread mapping is stored in thread
 *   titles (`discord:<channelId>`). After /new the old thread must be
 *   renamed (so the startup scan no longer maps the channel to it) and
 *   the new thread must claim the original title.
 */

function flush(): Promise<void> {
  return new Promise((r) => setImmediate(r));
}
async function settle(times = 4): Promise<void> {
  for (let i = 0; i < times; i++) await flush();
}

class FakeTransport implements DiscordTransport {
  sent: { channelId: string; text: string }[] = [];
  edits: { ref: DiscordMessageRef; text: string }[] = [];
  registeredCommands: DiscordSlashCommandSpec[] = [];
  registeredGuildId: string | undefined;
  private nextId = 1;
  private incoming: DiscordIncomingHandler | undefined;
  private interaction: DiscordInteractionHandler | undefined;
  private autocomplete: DiscordAutocompleteHandler | undefined;

  async start(opts: {
    onMessage: DiscordIncomingHandler;
    slashCommands?: DiscordSlashCommandSpec[];
    devGuildId?: string;
    onInteraction?: DiscordInteractionHandler;
    onAutocomplete?: DiscordAutocompleteHandler;
  }): Promise<void> {
    this.incoming = opts.onMessage;
    if (opts.slashCommands) this.registeredCommands = [...opts.slashCommands];
    this.registeredGuildId = opts.devGuildId;
    this.interaction = opts.onInteraction;
    this.autocomplete = opts.onAutocomplete;
  }
  async stop(): Promise<void> {
    this.incoming = undefined;
    this.interaction = undefined;
    this.autocomplete = undefined;
  }
  async sendText(channelId: string, text: string): Promise<DiscordMessageRef> {
    const ref: DiscordMessageRef = { id: `m${this.nextId++}`, channelId };
    this.sent.push({ channelId, text });
    return ref;
  }
  async sendEmbed(channelId: string, _embed: DiscordEmbed): Promise<DiscordMessageRef> {
    return { id: `m${this.nextId++}`, channelId };
  }
  async editText(ref: DiscordMessageRef, text: string): Promise<void> {
    this.edits.push({ ref, text });
  }
  async startTyping(_channelId: string): Promise<void> {}
  push(msg: DiscordIncomingMessage): void {
    if (!this.incoming) throw new Error('transport not started');
    this.incoming(msg);
  }
  /** Test helper — synthesise a slash-command interaction. */
  async pushInteraction(
    name: string,
    channelId: string,
    options: Record<string, string | undefined> = {},
  ): Promise<{ replies: string[] }> {
    if (!this.interaction) throw new Error('no interaction handler registered');
    const replies: string[] = [];
    const it: DiscordIncomingInteraction = {
      channelId,
      userId: 'user-1',
      userIsBot: false,
      name,
      options,
      respond: async (content) => {
        replies.push(content);
      },
    };
    await this.interaction(it);
    return { replies };
  }
  /** Test helper — synthesise an autocomplete request. */
  async pushAutocomplete(
    name: string,
    channelId: string,
    optionName: string,
    query: string,
  ): Promise<{ choices: DiscordAutocompleteChoice[] }> {
    if (!this.autocomplete) throw new Error('no autocomplete handler registered');
    let received: DiscordAutocompleteChoice[] = [];
    const req: DiscordIncomingAutocomplete = {
      channelId,
      name,
      optionName,
      query,
      respond: async (choices) => {
        received = choices;
      },
    };
    await this.autocomplete(req);
    return { choices: received };
  }
}

function makeIncoming(channelId: string, content: string, mentioned = false): DiscordIncomingMessage {
  return {
    channelId,
    authorId: 'user-1',
    authorIsBot: false,
    content,
    mentionedBot: mentioned,
    botUserId: 'bot-1',
  };
}

describe('TerminalAdapter session commands', () => {
  it('/new switches the bound thread; subsequent input lands on the new thread', async () => {
    const bus = new EventBus();
    const store = new MemorySessionStore();
    const oldId = newThreadId();
    await store.createThread({ id: oldId, rootTraceparent: newRootTraceparent() });

    const router: SessionRouter = {
      createThread: async () => {
        const id = newThreadId();
        await store.createThread({ id, rootTraceparent: newRootTraceparent() });
        return id;
      },
      adoptThread: async () => {},
    };

    const input = new PassThrough();
    const output = new PassThrough();
    const adapter = new TerminalAdapter({ store, input, output });
    await adapter.start({
      bus,
      threadBinding: { kind: 'single', threadId: oldId },
      router,
    });

    const userTurns: HarnessEvent[] = [];
    bus.subscribe(
      (ev) => {
        userTurns.push(ev);
      },
      { kinds: ['user_turn_start'] },
    );

    input.write('/new\n');
    await settle();
    input.write('hello\n');
    await settle();

    expect(userTurns).toHaveLength(1);
    expect(userTurns[0]!.threadId).not.toBe(oldId);

    await adapter.stop();
  });

  it('/resume <id-prefix> switches to an existing thread', async () => {
    const bus = new EventBus();
    const store = new MemorySessionStore();
    const a = newThreadId();
    const b = newThreadId();
    await store.createThread({ id: a, rootTraceparent: newRootTraceparent() });
    await store.createThread({ id: b, rootTraceparent: newRootTraceparent() });

    const adopted: ThreadId[] = [];
    const router: SessionRouter = {
      createThread: async () => newThreadId(),
      adoptThread: async (id) => {
        adopted.push(id);
      },
    };

    const input = new PassThrough();
    const output = new PassThrough();
    const adapter = new TerminalAdapter({ store, input, output });
    await adapter.start({
      bus,
      threadBinding: { kind: 'single', threadId: a },
      router,
    });

    const userTurns: HarnessEvent[] = [];
    bus.subscribe(
      (ev) => {
        userTurns.push(ev);
      },
      { kinds: ['user_turn_start'] },
    );

    input.write(`/resume ${b.slice(0, 8)}\n`);
    await settle();
    input.write('on b now\n');
    await settle();

    expect(adopted).toEqual([b]);
    expect(userTurns).toHaveLength(1);
    expect(userTurns[0]!.threadId).toBe(b);

    await adapter.stop();
  });
});

describe('DiscordAdapter session commands (per-channel)', () => {
  it('/new archives the old thread title and gives discord:<ch> to the new thread', async () => {
    const bus = new EventBus();
    const store = new MemorySessionStore();
    const transport = new FakeTransport();

    const channel = 'C-room';
    const router: SessionRouter = {
      createThread: async (input) => {
        const id = newThreadId();
        await store.createThread({
          id,
          rootTraceparent: newRootTraceparent(),
          ...(input?.title !== undefined ? { title: input.title } : {}),
        });
        return id;
      },
      adoptThread: async () => {},
    };

    const adapter = new DiscordAdapter({ store, transport, editIntervalMs: 0 });
    let originalId: ThreadId | undefined;
    await adapter.start({
      bus,
      threadBinding: {
        kind: 'per-channel',
        resolve: async (channelId) => {
          const id = newThreadId();
          originalId = id;
          await store.createThread({
            id,
            rootTraceparent: newRootTraceparent(),
            title: `${DISCORD_THREAD_TITLE_PREFIX}${channelId}`,
          });
          return id;
        },
      },
      router,
    });

    // First @mention seeds the channel→thread binding.
    transport.push(makeIncoming(channel, '<@bot-1> hi', true));
    await settle();

    // /new in the bound channel rotates the thread.
    transport.push(makeIncoming(channel, '/new'));
    await settle();

    const threads = await store.listThreads();
    const oldThread = threads.find((t) => t.id === originalId);
    const newThread = threads.find(
      (t) => t.id !== originalId && t.title === `${DISCORD_THREAD_TITLE_PREFIX}${channel}`,
    );
    expect(oldThread?.title?.startsWith('discord:archived:')).toBe(true);
    expect(newThread).toBeDefined();
  });

  it('/resume <idx> rebinds the channel after /status lists threads', async () => {
    const bus = new EventBus();
    const store = new MemorySessionStore();
    const transport = new FakeTransport();
    const channel = 'C-room';

    const adopted: ThreadId[] = [];
    const router: SessionRouter = {
      createThread: async () => newThreadId(),
      adoptThread: async (id) => {
        adopted.push(id);
      },
    };

    // Pre-create a second thread the user can resume into.
    const otherId = newThreadId();
    await store.createThread({
      id: otherId,
      rootTraceparent: newRootTraceparent(),
      title: 'previous chat',
    });

    const adapter = new DiscordAdapter({ store, transport, editIntervalMs: 0 });
    let firstChannelThread: ThreadId | undefined;
    await adapter.start({
      bus,
      threadBinding: {
        kind: 'per-channel',
        resolve: async (channelId) => {
          const id = newThreadId();
          firstChannelThread = id;
          await store.createThread({
            id,
            rootTraceparent: newRootTraceparent(),
            title: `${DISCORD_THREAD_TITLE_PREFIX}${channelId}`,
          });
          return id;
        },
      },
      router,
    });

    transport.push(makeIncoming(channel, '<@bot-1> hi', true));
    await settle();
    transport.push(makeIncoming(channel, '/status'));
    await settle();

    // /status is the most recent send; find the index for `previous chat`.
    const statusMsg = transport.sent.find((s) => s.text.includes('current:'));
    expect(statusMsg).toBeDefined();
    const idxLine = statusMsg!.text
      .split('\n')
      .find((l) => l.includes(`\`${otherId.slice(0, 12)}\``));
    expect(idxLine).toBeDefined();
    const idxMatch = idxLine!.match(/^-#\s+(\d+)\./);
    expect(idxMatch).not.toBeNull();
    const idx = idxMatch![1]!;

    transport.push(makeIncoming(channel, `/resume ${idx}`));
    await settle();

    expect(adopted).toEqual([otherId]);
    // Channel→thread binding now points at otherId (with discord:<ch> title).
    const refreshed = await store.getThread(otherId);
    expect(refreshed?.title).toBe(`${DISCORD_THREAD_TITLE_PREFIX}${channel}`);
    // First channel thread is archived.
    const oldThread = await store.getThread(firstChannelThread!);
    expect(oldThread?.title?.startsWith('discord:archived:')).toBe(true);
  });
});

describe('DiscordAdapter native slash interactions', () => {
  it('registers slash commands at start (status, new, resume, interrupt)', async () => {
    const bus = new EventBus();
    const store = new MemorySessionStore();
    const transport = new FakeTransport();
    const adapter = new DiscordAdapter({
      store,
      transport,
      editIntervalMs: 0,
      devGuildId: 'G1',
    });
    const tid = newThreadId();
    await store.createThread({ id: tid, rootTraceparent: newRootTraceparent() });
    await adapter.start({
      bus,
      threadBinding: { kind: 'single', threadId: tid },
      router: { createThread: async () => newThreadId(), adoptThread: async () => {} },
    });
    const names = transport.registeredCommands.map((c) => c.name).sort();
    expect(names).toEqual(['interrupt', 'new', 'resume', 'status']);
    expect(transport.registeredGuildId).toBe('G1');
    await adapter.stop();
  });

  it('/status interaction returns current + recent in a single ephemeral reply', async () => {
    const bus = new EventBus();
    const store = new MemorySessionStore();
    const transport = new FakeTransport();
    const channel = 'C-status';
    const tid = newThreadId();
    await store.createThread({
      id: tid,
      rootTraceparent: newRootTraceparent(),
      title: `${DISCORD_THREAD_TITLE_PREFIX}${channel}`,
    });
    const adapter = new DiscordAdapter({
      store,
      transport,
      channelId: channel,
      editIntervalMs: 0,
    });
    await adapter.start({
      bus,
      threadBinding: { kind: 'single', threadId: tid },
      router: { createThread: async () => newThreadId(), adoptThread: async () => {} },
    });
    const { replies } = await transport.pushInteraction('status', channel);
    expect(replies).toHaveLength(1);
    expect(replies[0]!).toContain('current:');
    expect(replies[0]!).toContain(tid.slice(0, 12));
    await adapter.stop();
  });

  it('/new interaction creates a fresh thread and reports it via interaction reply', async () => {
    const bus = new EventBus();
    const store = new MemorySessionStore();
    const transport = new FakeTransport();
    const channel = 'C-new';
    const tid = newThreadId();
    await store.createThread({
      id: tid,
      rootTraceparent: newRootTraceparent(),
      title: `${DISCORD_THREAD_TITLE_PREFIX}${channel}`,
    });
    const created: ThreadId[] = [];
    const router: SessionRouter = {
      createThread: async (input) => {
        const id = newThreadId();
        await store.createThread({
          id,
          rootTraceparent: newRootTraceparent(),
          ...(input?.title !== undefined ? { title: input.title } : {}),
        });
        created.push(id);
        return id;
      },
      adoptThread: async () => {},
    };
    const adapter = new DiscordAdapter({
      store,
      transport,
      channelId: channel,
      editIntervalMs: 0,
    });
    await adapter.start({
      bus,
      threadBinding: { kind: 'single', threadId: tid },
      router,
    });
    const { replies } = await transport.pushInteraction('new', channel);
    expect(created).toHaveLength(1);
    expect(replies).toHaveLength(1);
    expect(replies[0]!).toContain('switched');
    // The notice did NOT also leak to the channel as a regular message.
    expect(transport.sent).toHaveLength(0);
    await adapter.stop();
  });

  it('/interrupt interaction publishes an interrupt event for the bound thread', async () => {
    const bus = new EventBus();
    const store = new MemorySessionStore();
    const transport = new FakeTransport();
    const channel = 'C-int';
    const tid = newThreadId();
    await store.createThread({
      id: tid,
      rootTraceparent: newRootTraceparent(),
      title: `${DISCORD_THREAD_TITLE_PREFIX}${channel}`,
    });
    const interrupts: HarnessEvent[] = [];
    bus.subscribe(
      (ev) => {
        interrupts.push(ev);
      },
      { kinds: ['interrupt'] },
    );
    const adapter = new DiscordAdapter({
      store,
      transport,
      channelId: channel,
      editIntervalMs: 0,
    });
    await adapter.start({
      bus,
      threadBinding: { kind: 'single', threadId: tid },
      router: { createThread: async () => newThreadId(), adoptThread: async () => {} },
    });
    const { replies } = await transport.pushInteraction('interrupt', channel);
    expect(interrupts).toHaveLength(1);
    expect(interrupts[0]!.threadId).toBe(tid);
    expect(replies[0]!).toContain('interrupt');
    await adapter.stop();
  });
});

describe('Discord /resume UX improvements', () => {
  async function setupChannel(channel: string): Promise<{
    bus: EventBus;
    store: MemorySessionStore;
    transport: FakeTransport;
    adapter: DiscordAdapter;
    boundThreadId: ThreadId;
    otherId: ThreadId;
  }> {
    const bus = new EventBus();
    const store = new MemorySessionStore();
    const transport = new FakeTransport();
    const boundThreadId = newThreadId();
    await store.createThread({
      id: boundThreadId,
      rootTraceparent: newRootTraceparent(),
      title: `${DISCORD_THREAD_TITLE_PREFIX}${channel}`,
    });
    await store.append({
      threadId: boundThreadId,
      kind: 'user_turn_start',
      payload: { text: 'help me debug a memory leak in the worker pool' },
    });
    const otherId = newThreadId();
    await store.createThread({
      id: otherId,
      rootTraceparent: newRootTraceparent(),
      title: 'older work',
    });
    await store.append({
      threadId: otherId,
      kind: 'user_turn_start',
      payload: { text: 'rewrite the migration to be reversible' },
    });
    const adapter = new DiscordAdapter({
      store,
      transport,
      channelId: channel,
      editIntervalMs: 0,
    });
    await adapter.start({
      bus,
      threadBinding: { kind: 'single', threadId: boundThreadId },
      router: { createThread: async () => newThreadId(), adoptThread: async () => {} },
    });
    return { bus, store, transport, adapter, boundThreadId, otherId };
  }

  it('bare /resume returns the listing with previews instead of an error', async () => {
    const channel = 'C-bare';
    const { transport, otherId, adapter } = await setupChannel(channel);
    const { replies } = await transport.pushInteraction('resume', channel);
    const combined = replies.join('\n\n');
    expect(combined).toContain('current:');
    expect(combined).toContain('memory leak');
    expect(combined).toContain('rewrite the migration');
    expect(combined).toContain(otherId.slice(0, 12));
    expect(combined).toContain('select with /resume');
    await adapter.stop();
  });

  it('/resume autocomplete returns choices with previews and matches the query', async () => {
    const channel = 'C-auto';
    const { transport, otherId, boundThreadId, adapter } = await setupChannel(channel);
    const { choices: all } = await transport.pushAutocomplete('resume', channel, 'target', '');
    expect(all.map((c) => c.value).sort()).toEqual([boundThreadId, otherId].sort());
    const labels = all.map((c) => c.name).join(' | ');
    expect(labels).toContain('memory leak');
    expect(labels).toContain('rewrite the migration');

    const { choices: filtered } = await transport.pushAutocomplete(
      'resume',
      channel,
      'target',
      'migration',
    );
    expect(filtered).toHaveLength(1);
    expect(filtered[0]!.value).toBe(otherId);
    await adapter.stop();
  });

  it('/resume registers as autocomplete-enabled', async () => {
    const channel = 'C-reg';
    const { transport, adapter } = await setupChannel(channel);
    const resume = transport.registeredCommands.find((c) => c.name === 'resume');
    expect(resume?.option?.autocomplete).toBe(true);
    await adapter.stop();
  });
});
