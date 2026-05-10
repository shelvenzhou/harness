import { describe, expect, it } from 'vitest';

import { DiscordAdapter } from '@harness/adapters/discord.js';
import type {
  DiscordIncomingHandler,
  DiscordIncomingMessage,
  DiscordEmbed,
  DiscordMessageRef,
  DiscordTransport,
} from '@harness/adapters/discordTransport.js';
import { EventBus } from '@harness/bus/eventBus.js';
import { StreamBus } from '@harness/bus/streamBus.js';
import {
  newEventId,
  newThreadId,
  newTurnId,
  type ToolCallId,
  type ThreadId,
} from '@harness/core/ids.js';
import { newRootTraceparent } from '@harness/core/traceparent.js';
import { MemorySessionStore } from '@harness/store/index.js';
import type { HarnessEvent } from '@harness/core/events.js';

/**
 * The DiscordAdapter must:
 *   - convert inbound channel messages into user_turn_start/user_input;
 *   - render text deltas live by editing a single Discord message,
 *     opening a continuation when the soft cap is hit;
 *   - render reasoning only from persisted events, not partial deltas;
 *   - dedupe a persisted reply that matches what we already streamed;
 *   - surface tool calls as compact status lines;
 *   - only listen to the bound channel and ignore bot authors.
 */

const CHANNEL = 'C123';

interface SentEntry {
  kind: 'text' | 'embed';
  channelId: string;
  text?: string;
  embed?: DiscordEmbed;
  ref: DiscordMessageRef;
}

interface EditEntry {
  ref: DiscordMessageRef;
  text: string;
}

class FakeDiscordTransport implements DiscordTransport {
  sent: SentEntry[] = [];
  edits: EditEntry[] = [];
  typing = 0;
  sendTextDelayMs = 0;
  editTextDelayMs = 0;
  private nextId = 1;
  private incoming: DiscordIncomingHandler | undefined;

  async start(opts: { onMessage: DiscordIncomingHandler }): Promise<void> {
    this.incoming = opts.onMessage;
  }
  async stop(): Promise<void> {
    this.incoming = undefined;
  }
  async sendText(channelId: string, text: string): Promise<DiscordMessageRef> {
    if (this.sendTextDelayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.sendTextDelayMs));
    }
    const ref: DiscordMessageRef = { id: `m${this.nextId++}`, channelId };
    this.sent.push({ kind: 'text', channelId, text, ref });
    return ref;
  }
  async sendEmbed(channelId: string, embed: DiscordEmbed): Promise<DiscordMessageRef> {
    const ref: DiscordMessageRef = { id: `m${this.nextId++}`, channelId };
    this.sent.push({ kind: 'embed', channelId, embed, ref });
    return ref;
  }
  async editText(ref: DiscordMessageRef, text: string): Promise<void> {
    if (this.editTextDelayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.editTextDelayMs));
    }
    this.edits.push({ ref, text });
  }
  async startTyping(_channelId: string): Promise<void> {
    this.typing += 1;
  }

  /** Test helper — push a synthetic inbound message. */
  push(msg: DiscordIncomingMessage): void {
    if (!this.incoming) throw new Error('transport not started');
    this.incoming(msg);
  }
}

async function makeAdapter(
  opts: {
    editIntervalMs?: number;
    sendTextDelayMs?: number;
    editTextDelayMs?: number;
    channelId?: string;
    threadBinding?: Parameters<DiscordAdapter['start']>[0]['threadBinding'];
  } = {},
) {
  const bus = new EventBus();
  const streamBus = new StreamBus();
  const store = new MemorySessionStore();
  const tid = newThreadId();
  await store.createThread({ id: tid, rootTraceparent: newRootTraceparent() });
  const transport = new FakeDiscordTransport();
  transport.sendTextDelayMs = opts.sendTextDelayMs ?? 0;
  transport.editTextDelayMs = opts.editTextDelayMs ?? 0;
  const adapter = new DiscordAdapter({
    store,
    transport,
    ...(opts.channelId !== undefined ? { channelId: opts.channelId } : { channelId: CHANNEL }),
    editIntervalMs: opts.editIntervalMs ?? 0,
  });
  await adapter.start({
    bus,
    streamBus,
    threadBinding: opts.threadBinding ?? { kind: 'single', threadId: tid },
  });
  return { adapter, bus, streamBus, store, transport, threadId: tid };
}

async function makePerChannelAdapter(opts: { editIntervalMs?: number } = {}) {
  const bus = new EventBus();
  const streamBus = new StreamBus();
  const store = new MemorySessionStore();
  const transport = new FakeDiscordTransport();
  const bindings = new Map<string, ThreadId>();
  const adapter = new DiscordAdapter({
    store,
    transport,
    editIntervalMs: opts.editIntervalMs ?? 0,
  });
  await adapter.start({
    bus,
    streamBus,
    threadBinding: {
      kind: 'per-channel',
      resolve: async (channelId) => {
        const existing = bindings.get(channelId);
        if (existing) return existing;
        const tid = newThreadId();
        await store.createThread({
          id: tid,
          rootTraceparent: newRootTraceparent(),
          title: `discord:${channelId}`,
        });
        bindings.set(channelId, tid);
        return tid;
      },
    },
  });
  return { adapter, bus, streamBus, store, transport, bindings };
}

function flush(): Promise<void> {
  return new Promise((r) => setImmediate(r));
}

async function settle(times = 4): Promise<void> {
  for (let i = 0; i < times; i++) await flush();
}

function makeReplyEvent(threadId: ThreadId, text: string): HarnessEvent {
  return {
    id: newEventId(),
    threadId,
    kind: 'reply',
    createdAt: new Date().toISOString(),
    payload: { text },
  } as HarnessEvent;
}

function makeReasoningEvent(threadId: ThreadId, text: string): HarnessEvent {
  return {
    id: newEventId(),
    threadId,
    kind: 'reasoning',
    createdAt: new Date().toISOString(),
    payload: { text },
  } as HarnessEvent;
}

function makeToolCallEvent(threadId: ThreadId, name: string, args: unknown): HarnessEvent {
  return {
    id: newEventId(),
    threadId,
    kind: 'tool_call',
    createdAt: new Date().toISOString(),
    payload: { toolCallId: 'tc-abc' as ToolCallId, name, args },
  } as HarnessEvent;
}

function makeToolResultEvent(threadId: ThreadId, ok: boolean, output: unknown): HarnessEvent {
  return {
    id: newEventId(),
    threadId,
    kind: 'tool_result',
    createdAt: new Date().toISOString(),
    payload: { toolCallId: 'tc-abc' as ToolCallId, ok, output },
  } as HarnessEvent;
}

function makeTurnCompleteEvent(threadId: ThreadId, summary?: string): HarnessEvent {
  return {
    id: newEventId(),
    threadId,
    kind: 'turn_complete',
    createdAt: new Date().toISOString(),
    payload: { status: 'completed', ...(summary !== undefined ? { summary } : {}) },
  } as HarnessEvent;
}

describe('DiscordAdapter', () => {
  it('publishes user_turn_start for inbound messages and starts typing', async () => {
    const { adapter, store, transport, threadId } = await makeAdapter();
    transport.push({
      channelId: CHANNEL,
      authorId: 'op',
      authorIsBot: false,
      content: 'hello',
    });
    await settle();
    const events = await store.readAll(threadId);
    const userTurn = events.find((e) => e.kind === 'user_turn_start');
    expect(userTurn).toBeDefined();
    expect((userTurn!.payload as { text: string }).text).toBe('hello');
    expect(transport.typing).toBe(1);
    await adapter.stop();
  });

  it('ignores messages from other channels and from bots', async () => {
    const { adapter, store, transport, threadId } = await makeAdapter();
    transport.push({ channelId: 'C999', authorId: 'op', authorIsBot: false, content: 'wrong' });
    transport.push({ channelId: CHANNEL, authorId: 'b', authorIsBot: true, content: 'echo' });
    await settle();
    const events = await store.readAll(threadId);
    expect(events.find((e) => e.kind === 'user_turn_start')).toBeUndefined();
    await adapter.stop();
  });

  it('in per-channel mode only binds a new channel from an @bot message', async () => {
    const { adapter, store, transport, bindings } = await makePerChannelAdapter();
    transport.push({
      channelId: 'C1',
      authorId: 'op',
      authorIsBot: false,
      mentionedBot: false,
      content: 'plain hello',
    });
    await settle();
    expect(bindings.size).toBe(0);

    transport.push({
      channelId: 'C1',
      authorId: 'op',
      authorIsBot: false,
      botUserId: 'bot',
      mentionedBot: true,
      content: '<@bot> hello',
    });
    await settle();

    const threadId = bindings.get('C1');
    expect(threadId).toBeDefined();
    const events = await store.readAll(threadId!);
    const userTurn = events.find((e) => e.kind === 'user_turn_start');
    expect((userTurn!.payload as { text: string }).text).toBe('hello');

    transport.push({
      channelId: 'C1',
      authorId: 'op',
      authorIsBot: false,
      mentionedBot: false,
      content: 'follow up',
    });
    await settle();
    const afterFollowup = await store.readAll(threadId!);
    const userInput = afterFollowup.find((e) => e.kind === 'user_input');
    expect((userInput!.payload as { text: string }).text).toBe('follow up');
    await adapter.stop();
  });

  it('routes different Discord channels to independent threads', async () => {
    const { adapter, store, transport, bindings } = await makePerChannelAdapter();
    transport.push({
      channelId: 'C1',
      authorId: 'op',
      authorIsBot: false,
      botUserId: 'bot',
      mentionedBot: true,
      content: '<@bot> one',
    });
    transport.push({
      channelId: 'C2',
      authorId: 'op',
      authorIsBot: false,
      botUserId: 'bot',
      mentionedBot: true,
      content: '<@bot> two',
    });
    await settle();

    const t1 = bindings.get('C1');
    const t2 = bindings.get('C2');
    expect(t1).toBeDefined();
    expect(t2).toBeDefined();
    expect(t1).not.toBe(t2);
    expect(
      (await store.readAll(t1!)).find((e) => e.kind === 'user_turn_start')?.payload,
    ).toMatchObject({
      text: 'one',
    });
    expect(
      (await store.readAll(t2!)).find((e) => e.kind === 'user_turn_start')?.payload,
    ).toMatchObject({
      text: 'two',
    });
    await adapter.stop();
  });

  it('publishes interrupt for /interrupt', async () => {
    const { adapter, store, transport, threadId } = await makeAdapter();
    transport.push({
      channelId: CHANNEL,
      authorId: 'op',
      authorIsBot: false,
      content: '/interrupt',
    });
    await settle();
    const events = await store.readAll(threadId);
    expect(events.find((e) => e.kind === 'interrupt')).toBeDefined();
    await adapter.stop();
  });

  it('streams reply deltas as message edits and dedupes the matching persisted reply', async () => {
    const { adapter, bus, streamBus, transport, threadId } = await makeAdapter();
    const turnId = newTurnId();
    streamBus.publish({ kind: 'text_delta', threadId, turnId, text: 'hel' });
    await settle();
    streamBus.publish({ kind: 'text_delta', threadId, turnId, text: 'lo' });
    await settle();
    streamBus.publish({ kind: 'sampling_flush', threadId, turnId });
    await settle();

    // Exactly one text message was sent (the live message), and at least
    // one edit landed with the final accumulated text.
    const texts = transport.sent.filter((s) => s.kind === 'text');
    expect(texts).toHaveLength(1);
    const lastEdit = transport.edits[transport.edits.length - 1];
    expect(lastEdit?.text).toBe('hello');

    // Persisted reply matching what was streamed must NOT post a fresh
    // message (dedupe).
    bus.publish(makeReplyEvent(threadId, 'hello'));
    await settle();
    const textsAfter = transport.sent.filter((s) => s.kind === 'text');
    expect(textsAfter).toHaveLength(1);
    await adapter.stop();
  });

  it('serializes back-to-back deltas into one live message', async () => {
    const { adapter, streamBus, transport, threadId } = await makeAdapter({
      sendTextDelayMs: 5,
    });
    const turnId = newTurnId();

    streamBus.publish({ kind: 'text_delta', threadId, turnId, text: 'Hello' });
    streamBus.publish({ kind: 'text_delta', threadId, turnId, text: '!' });
    streamBus.publish({ kind: 'text_delta', threadId, turnId, text: ' How' });
    streamBus.publish({ kind: 'text_delta', threadId, turnId, text: ' can' });
    streamBus.publish({ kind: 'sampling_flush', threadId, turnId });

    await new Promise((resolve) => setTimeout(resolve, 40));

    const texts = transport.sent.filter((s) => s.kind === 'text');
    expect(texts).toHaveLength(1);
    const lastEdit = transport.edits[transport.edits.length - 1];
    expect(lastEdit?.text).toBe('Hello! How can');
    await adapter.stop();
  });

  it('coalesces back-to-back stream deltas until flush', async () => {
    const { adapter, streamBus, transport, threadId } = await makeAdapter();
    const turnId = newTurnId();

    streamBus.publish({ kind: 'text_delta', threadId, turnId, text: 'one ' });
    streamBus.publish({ kind: 'text_delta', threadId, turnId, text: 'two ' });
    streamBus.publish({ kind: 'text_delta', threadId, turnId, text: 'three' });
    await settle();

    expect(transport.sent.filter((s) => s.kind === 'text')).toHaveLength(0);

    streamBus.publish({ kind: 'sampling_flush', threadId, turnId });
    await settle();

    const texts = transport.sent.filter((s) => s.kind === 'text');
    expect(texts).toHaveLength(1);
    expect(texts[0]!.text).toBe('one two three');
    await adapter.stop();
  });

  it('does not enqueue overlapping live edits while a previous edit is in flight', async () => {
    const { adapter, streamBus, transport, threadId } = await makeAdapter({
      editIntervalMs: 0,
      editTextDelayMs: 20,
    });
    const turnId = newTurnId();

    streamBus.publish({ kind: 'text_delta', threadId, turnId, text: 'a' });
    streamBus.publish({ kind: 'sampling_flush', threadId, turnId });
    await settle();

    streamBus.publish({ kind: 'text_delta', threadId, turnId, text: 'b' });
    streamBus.publish({ kind: 'text_delta', threadId, turnId, text: 'c' });
    streamBus.publish({ kind: 'text_delta', threadId, turnId, text: 'd' });
    streamBus.publish({ kind: 'sampling_flush', threadId, turnId });

    await new Promise((resolve) => setTimeout(resolve, 70));

    expect(transport.edits.length).toBeLessThanOrEqual(3);
    expect(transport.edits[transport.edits.length - 1]?.text).toBe('bcd');
    await adapter.stop();
  });

  it('drains pending stream text before rendering later bus events', async () => {
    const { adapter, bus, streamBus, transport, threadId } = await makeAdapter();
    const turnId = newTurnId();

    streamBus.publish({ kind: 'text_delta', threadId, turnId, text: 'pending reply' });
    bus.publish(makeToolCallEvent(threadId, 'shell', { cmd: 'pwd' }));
    await settle();

    const texts = transport.sent.filter((s) => s.kind === 'text');
    expect(texts).toHaveLength(2);
    expect(texts[0]!.text).toBe('pending reply');
    expect(texts[1]!.text).toBe('-# 🔧 shell `pwd`');
    await adapter.stop();
  });

  it('falls back to a fresh message when persisted reply does not match streamed text', async () => {
    const { adapter, bus, transport, threadId } = await makeAdapter();
    bus.publish(makeReplyEvent(threadId, 'unstreamed reply'));
    await settle();
    const texts = transport.sent.filter((s) => s.kind === 'text');
    expect(texts).toHaveLength(1);
    expect(texts[0]!.text).toBe('unstreamed reply');
    await adapter.stop();
  });

  it('renders tool calls as compact status lines and hides running results', async () => {
    const { adapter, bus, transport, threadId } = await makeAdapter();
    bus.publish(makeToolCallEvent(threadId, 'shell', { cmd: 'pwd', timeoutMs: 10000 }));
    await settle();
    bus.publish(
      makeToolResultEvent(threadId, true, {
        sessionId: 'sess_1',
        status: 'running',
        toolName: 'shell',
      }),
    );
    await settle();

    const texts = transport.sent.filter((s) => s.kind === 'text');
    expect(texts).toHaveLength(1);
    expect(texts[0]!.text).toBe('-# 🔧 shell `pwd`');
    expect(transport.sent.filter((s) => s.kind === 'embed')).toHaveLength(0);
    await adapter.stop();
  });

  it('hides internal wait tool chatter', async () => {
    const { adapter, bus, transport, threadId } = await makeAdapter();
    bus.publish(
      makeToolCallEvent(threadId, 'wait', { matcher: 'session', sessionIds: ['sess_1'] }),
    );
    await settle();
    bus.publish(makeToolResultEvent(threadId, true, { scheduled: true, matcher: 'session' }));
    await settle();

    expect(transport.sent).toHaveLength(0);
    await adapter.stop();
  });

  it('opens a continuation message when streamed text exceeds the soft cap', async () => {
    const { adapter, streamBus, transport, threadId } = await makeAdapter();
    const turnId = newTurnId();
    // 1900-char chunk (the soft cap) plus an overflow tail.
    const chunk1 = 'a'.repeat(1900);
    const chunk2 = 'bbbb';
    streamBus.publish({ kind: 'text_delta', threadId, turnId, text: chunk1 });
    await settle();
    streamBus.publish({ kind: 'text_delta', threadId, turnId, text: chunk2 });
    await settle();
    streamBus.publish({ kind: 'sampling_flush', threadId, turnId });
    await settle();

    const texts = transport.sent.filter((s) => s.kind === 'text');
    expect(texts).toHaveLength(2);
    // First send was the initial 'a'-only chunk; the second send is the
    // continuation carrying the overflowed tail.
    expect(texts[1]!.text).toContain('bbbb');
    await adapter.stop();
  });

  it('chunks persisted reasoning by rendered Discord length including quote prefixes', async () => {
    const { adapter, bus, transport, threadId } = await makeAdapter();
    const reasoning = Array.from({ length: 360 }, (_, i) => `line ${i}`).join('\n');

    bus.publish(makeReasoningEvent(threadId, reasoning));
    await settle();

    const texts = transport.sent.filter((s) => s.kind === 'text');
    expect(texts.length).toBeGreaterThan(1);
    for (const sent of texts) {
      expect(sent.text!.length).toBeLessThanOrEqual(1900);
    }
    for (const edit of transport.edits) {
      expect(edit.text.length).toBeLessThanOrEqual(1900);
    }
    expect(texts.at(-1)?.text).toContain('line 359');
    await adapter.stop();
  });

  it('does not render partial reasoning deltas before persisted reasoning arrives', async () => {
    const { adapter, bus, streamBus, transport, threadId } = await makeAdapter();
    const turnId = newTurnId();

    streamBus.publish({ kind: 'reasoning_delta', threadId, turnId, text: 'thinking partial' });
    streamBus.publish({ kind: 'sampling_flush', threadId, turnId });
    await settle();
    expect(transport.sent.filter((s) => s.kind === 'text')).toHaveLength(0);

    bus.publish(makeReasoningEvent(threadId, 'thinking partial plus persisted text'));
    await settle();

    const texts = transport.sent.filter((s) => s.kind === 'text');
    expect(texts).toHaveLength(1);
    expect(texts[0]!.text).toContain('thinking partial plus persisted text');
    await adapter.stop();
  });

  it('edits the tool_call status line to ✓ on a successful tool result', async () => {
    const { adapter, bus, transport, threadId } = await makeAdapter();
    bus.publish(makeToolCallEvent(threadId, 'shell', { cmd: 'pwd', timeoutMs: 10000 }));
    await settle();
    bus.publish(
      makeToolResultEvent(threadId, true, {
        sessionId: 'sess_1',
        status: 'done',
        toolName: 'shell',
        exitCode: 0,
      }),
    );
    await settle();

    const texts = transport.sent.filter((s) => s.kind === 'text');
    expect(texts).toHaveLength(1);
    const finalEdit = transport.edits[transport.edits.length - 1];
    expect(finalEdit?.text).toBe('-# ✓ shell `pwd`');
    expect(finalEdit?.ref.id).toBe(texts[0]!.ref.id);
    await adapter.stop();
  });

  it('greets and binds the channel on a bare @bot mention without starting a turn', async () => {
    const { adapter, store, transport, bindings } = await makePerChannelAdapter();
    transport.push({
      channelId: 'C1',
      authorId: 'op',
      authorIsBot: false,
      botUserId: 'bot',
      mentionedBot: true,
      content: '<@bot>',
    });
    await settle();

    const threadId = bindings.get('C1');
    expect(threadId).toBeDefined();
    const events = await store.readAll(threadId!);
    expect(events.find((e) => e.kind === 'user_turn_start')).toBeUndefined();
    const texts = transport.sent.filter((s) => s.kind === 'text');
    expect(texts).toHaveLength(1);
    expect(texts[0]!.text).toContain('ready');
    await adapter.stop();
  });

  it('renders a `[reasoning]` echo as a single gray reasoning block (live + persisted dedupe)', async () => {
    const { adapter, bus, streamBus, transport, threadId } = await makeAdapter();
    const turnId = newTurnId();
    const text =
      '[reasoning] **Waiting for shell command to complete**\n\nI’ve dispatched the `pwd` command.';

    for (const chunk of [
      '[reasoning]',
      ' **Waiting for shell',
      ' command to complete**',
      '\n\nI’ve dispatched the `pwd` command.',
    ]) {
      streamBus.publish({ kind: 'text_delta', threadId, turnId, text: chunk });
      await settle();
    }
    streamBus.publish({ kind: 'sampling_flush', threadId, turnId });
    await settle();
    bus.publish({
      id: newEventId(),
      threadId,
      kind: 'preamble',
      createdAt: new Date().toISOString(),
      payload: { text },
    } as HarnessEvent);
    await settle();

    const texts = transport.sent.filter((s) => s.kind === 'text');
    expect(texts).toHaveLength(1);
    const finalEdit = transport.edits[transport.edits.length - 1];
    // Final edit converts the streamed black reply into the gray quote-block
    // reasoning rendering (`> …`) with the `[reasoning]` marker stripped.
    expect(finalEdit?.text).toMatch(/^> /m);
    expect(finalEdit?.text).not.toContain('[reasoning]');
    expect(finalEdit?.text).not.toContain('🧠');
    expect(finalEdit?.text).toContain('Waiting for shell command to complete');
    await adapter.stop();
  });

  it('falls back to a gray reasoning render when a `[reasoning]` persisted event has no streamed match', async () => {
    const { adapter, bus, transport, threadId } = await makeAdapter();
    bus.publish({
      id: newEventId(),
      threadId,
      kind: 'preamble',
      createdAt: new Date().toISOString(),
      payload: { text: '[reasoning] **Plan**\n\nDo X then Y.' },
    } as HarnessEvent);
    await settle();

    const texts = transport.sent.filter((s) => s.kind === 'text');
    expect(texts.length).toBeGreaterThanOrEqual(1);
    expect(texts[0]!.text).toMatch(/^> /m);
    expect(texts[0]!.text).not.toContain('[reasoning]');
    expect(texts[0]!.text).not.toContain('🧠');
    await adapter.stop();
  });

  it('serializes stream flush before turn_complete and does not repeat completed summaries', async () => {
    const { adapter, bus, streamBus, transport, threadId } = await makeAdapter({
      sendTextDelayMs: 5,
    });
    const turnId = newTurnId();

    streamBus.publish({ kind: 'text_delta', threadId, turnId, text: 'Hello' });
    streamBus.publish({ kind: 'sampling_flush', threadId, turnId });
    bus.publish(makeTurnCompleteEvent(threadId, 'Hello'));

    await new Promise((resolve) => setTimeout(resolve, 30));

    const texts = transport.sent.filter((s) => s.kind === 'text');
    // Only the streamed reply renders — completed turns no longer post a
    // trailing divider, and the matching persisted summary is deduped.
    expect(texts).toHaveLength(1);
    expect(texts[0]!.text).toBe('Hello');
    expect(texts.some((s) => s.text?.includes('turn completed'))).toBe(false);
    await adapter.stop();
  });
});
