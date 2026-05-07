import type { Client, Message, TextBasedChannel } from 'discord.js';

/**
 * DiscordTransport — minimal seam between the DiscordAdapter and a real
 * Discord client. Same shape as the stream injection in TerminalAdapter
 * (PassThrough in tests, process.stdin in prod): the adapter logic stays
 * unit-testable with a fake transport, the real one wraps `discord.js`.
 *
 * The interface is deliberately tiny — just the operations the adapter
 * actually needs. Anything richer (reactions, threads, files) gets added
 * here when a feature requires it.
 *
 * `discord.js` types are imported statically (erased at compile) but the
 * runtime module is lazy-loaded inside `start()` so this file can be
 * imported in environments that don't have the package available yet.
 */

type SendableChannel = TextBasedChannel & {
  send: (...args: unknown[]) => Promise<Message>;
  sendTyping?: () => Promise<void>;
};

export interface DiscordMessageRef {
  /** Discord message snowflake. */
  id: string;
  /** Channel id the message lives in. */
  channelId: string;
}

export interface DiscordIncomingMessage {
  channelId: string;
  authorId: string;
  authorIsBot: boolean;
  /** The bot user's id when known; useful for stripping raw mention markup. */
  botUserId?: string;
  /** True when this message explicitly mentions the connected bot. */
  mentionedBot?: boolean;
  /** Text content; mentions are left as raw `<@id>` markup. */
  content: string;
}

export type DiscordIncomingHandler = (msg: DiscordIncomingMessage) => void;

export interface DiscordEmbed {
  title?: string;
  description?: string;
  /** 0xRRGGBB. */
  color?: number;
  fields?: Array<{ name: string; value: string; inline?: boolean }>;
  footer?: string;
}

export interface DiscordTransport {
  start(opts: {
    onMessage: DiscordIncomingHandler;
    onReady?: () => void;
  }): Promise<void>;
  stop(): Promise<void>;
  sendText(channelId: string, text: string): Promise<DiscordMessageRef>;
  sendEmbed(channelId: string, embed: DiscordEmbed): Promise<DiscordMessageRef>;
  editText(ref: DiscordMessageRef, text: string): Promise<void>;
  startTyping(channelId: string): Promise<void>;
}

/**
 * Real discord.js-backed transport. Lazy-imports discord.js so that
 * environments without the package (or without `node-fetch`'s peer deps)
 * can still load the adapter module — the import only fires on `start()`.
 */
export class RealDiscordTransport implements DiscordTransport {
  private readonly token: string;
  // Typed loosely — discord.js types are not pulled into the public
  // surface of the adapter, and lazy-loading keeps the unit tests
  // independent of the real client.
  private client: unknown | undefined;

  constructor(opts: { token: string }) {
    this.token = opts.token;
  }

  async start(opts: {
    onMessage: DiscordIncomingHandler;
    onReady?: () => void;
  }): Promise<void> {
    const djs = await import('discord.js');
    const { Client, Events, GatewayIntentBits, Partials } = djs;
    const client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.DirectMessages,
      ],
      partials: [Partials.Channel],
    });
    client.on(Events.MessageCreate, (msg: Message) => {
      const botUser = client.user;
      opts.onMessage({
        channelId: msg.channelId,
        authorId: msg.author.id,
        authorIsBot: msg.author.bot,
        ...(botUser?.id !== undefined ? { botUserId: botUser.id } : {}),
        mentionedBot: botUser ? msg.mentions.has(botUser) : false,
        content: msg.content,
      });
    });
    if (opts.onReady) {
      client.once(Events.ClientReady, () => opts.onReady?.());
    }
    await client.login(this.token);
    this.client = client;
  }

  async stop(): Promise<void> {
    const c = this.client as Client | undefined;
    if (!c) return;
    await c.destroy();
    this.client = undefined;
  }

  async sendText(channelId: string, text: string): Promise<DiscordMessageRef> {
    const ch = await this.fetchSendable(channelId);
    const msg = await ch.send(text);
    return { id: msg.id, channelId: msg.channelId };
  }

  async sendEmbed(channelId: string, embed: DiscordEmbed): Promise<DiscordMessageRef> {
    const djs = await import('discord.js');
    const eb = new djs.EmbedBuilder();
    if (embed.title !== undefined) eb.setTitle(embed.title);
    if (embed.description !== undefined) eb.setDescription(embed.description);
    if (embed.color !== undefined) eb.setColor(embed.color);
    if (embed.fields !== undefined && embed.fields.length > 0) eb.addFields(...embed.fields);
    if (embed.footer !== undefined) eb.setFooter({ text: embed.footer });
    const ch = await this.fetchSendable(channelId);
    const msg = await ch.send({ embeds: [eb] });
    return { id: msg.id, channelId: msg.channelId };
  }

  async editText(ref: DiscordMessageRef, text: string): Promise<void> {
    const ch = await this.fetchSendable(ref.channelId);
    const msg = await ch.messages.fetch(ref.id);
    await msg.edit({ content: text, embeds: [] });
  }

  async startTyping(channelId: string): Promise<void> {
    const ch = await this.fetchSendable(channelId);
    if (typeof ch.sendTyping === 'function') await ch.sendTyping();
  }

  private async fetchSendable(channelId: string): Promise<SendableChannel> {
    const c = this.client as Client | undefined;
    if (!c) throw new Error('DiscordTransport: client not started');
    const ch = await c.channels.fetch(channelId);
    if (!ch || !('send' in ch) || typeof (ch as { send?: unknown }).send !== 'function') {
      throw new Error(`DiscordTransport: channel ${channelId} is not text-sendable`);
    }
    return ch as SendableChannel;
  }
}
