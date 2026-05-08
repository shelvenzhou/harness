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

/**
 * Slash command spec. Mirrors the subset of Discord application command
 * fields the adapter needs — name, description, and a single optional
 * string parameter (used by `/resume target:<string>`).
 */
export interface DiscordSlashCommandSpec {
  name: string;
  description: string;
  /** Optional single string parameter (Discord option type 3). */
  option?: {
    name: string;
    description: string;
    required?: boolean;
    /** Enable Discord-side autocomplete dropdown for this option. */
    autocomplete?: boolean;
  };
}

export interface DiscordAutocompleteChoice {
  /** Label shown in the Discord client (≤100 chars). */
  name: string;
  /** Value returned to the bot when the user picks this choice. */
  value: string;
}

export interface DiscordIncomingAutocomplete {
  channelId: string;
  /** Slash command name (e.g. 'resume'). */
  name: string;
  /** Option name being typed (e.g. 'target'). */
  optionName: string;
  /** Current text the user has typed. May be empty. */
  query: string;
  /** Send up to 25 choices. Discord requires a response within 3s. */
  respond(choices: DiscordAutocompleteChoice[]): Promise<void>;
}

export type DiscordAutocompleteHandler = (
  request: DiscordIncomingAutocomplete,
) => void | Promise<void>;

export interface DiscordIncomingInteraction {
  channelId: string;
  userId: string;
  userIsBot: boolean;
  /** Slash command name (without the leading slash). */
  name: string;
  /** Parsed string options keyed by option name. */
  options: Record<string, string | undefined>;
  /**
   * Send the user-visible response. May be called once. The transport
   * implementation decides whether the reply is ephemeral; the adapter
   * just hands over the text. Empty string is allowed and renders as a
   * minimal "ack" reply.
   */
  respond(content: string, opts?: { ephemeral?: boolean }): Promise<void>;
}

export type DiscordInteractionHandler = (
  interaction: DiscordIncomingInteraction,
) => void | Promise<void>;

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
    /** Application commands to register on `ClientReady`. */
    slashCommands?: DiscordSlashCommandSpec[];
    /**
     * Optional guild id. When supplied, commands are registered as
     * guild-scoped (instant propagation, ideal for development). When
     * omitted, registration is global and Discord may take up to an
     * hour to surface them in clients.
     */
    devGuildId?: string;
    onInteraction?: DiscordInteractionHandler;
    /** Optional handler for Discord-side option autocomplete. */
    onAutocomplete?: DiscordAutocompleteHandler;
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
    slashCommands?: DiscordSlashCommandSpec[];
    devGuildId?: string;
    onInteraction?: DiscordInteractionHandler;
    onAutocomplete?: DiscordAutocompleteHandler;
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

    if (opts.onInteraction || opts.onAutocomplete) {
      const onCommand = opts.onInteraction;
      const onAuto = opts.onAutocomplete;
      client.on(Events.InteractionCreate, (interaction: unknown) => {
        const it = interaction as {
          isChatInputCommand?: () => boolean;
          isAutocomplete?: () => boolean;
          channelId?: string;
          user?: { id: string; bot: boolean };
          commandName?: string;
          options?: {
            getString?: (name: string, required?: boolean) => string | null;
            getFocused?: (
              getFull?: boolean,
            ) => string | { name: string; value: string } | null;
          };
          deferReply?: (opts: { ephemeral?: boolean }) => Promise<void>;
          editReply?: (content: string) => Promise<unknown>;
          reply?: (opts: { content: string; ephemeral?: boolean }) => Promise<unknown>;
          respond?: (choices: DiscordAutocompleteChoice[]) => Promise<unknown>;
          replied?: boolean;
          deferred?: boolean;
        };

        // Autocomplete request: user is typing into an option marked
        // `autocomplete: true`. Discord wants a response within 3s.
        if (onAuto && typeof it.isAutocomplete === 'function' && it.isAutocomplete()) {
          if (!it.channelId || !it.commandName) return;
          let optionName = '';
          let query = '';
          if (it.options?.getFocused) {
            const focused = it.options.getFocused(true);
            if (focused && typeof focused === 'object') {
              optionName = focused.name;
              query = focused.value;
            } else if (typeof focused === 'string') {
              query = focused;
            }
          }
          const respond = async (choices: DiscordAutocompleteChoice[]): Promise<void> => {
            try {
              await it.respond?.(choices.slice(0, 25));
            } catch {
              // Token may be stale; nothing to recover.
            }
          };
          void Promise.resolve(
            onAuto({
              channelId: it.channelId,
              name: it.commandName,
              optionName,
              query,
              respond,
            }),
          );
          return;
        }

        if (!onCommand) return;
        if (typeof it.isChatInputCommand !== 'function' || !it.isChatInputCommand()) return;
        if (!it.channelId || !it.user || !it.commandName) return;
        const optionNames = (opts.slashCommands ?? []).find((c) => c.name === it.commandName)
          ?.option?.name;
        const options: Record<string, string | undefined> = {};
        if (optionNames && it.options?.getString) {
          const v = it.options.getString(optionNames, false);
          options[optionNames] = v ?? undefined;
        }
        const respond = async (
          content: string,
          o?: { ephemeral?: boolean },
        ): Promise<void> => {
          const ephemeral = o?.ephemeral ?? true;
          try {
            if (!it.deferred && !it.replied && it.deferReply) {
              await it.deferReply({ ephemeral });
            }
            const text = content.length > 0 ? content : '✓';
            if (it.editReply) {
              await it.editReply(text);
            } else if (it.reply) {
              await it.reply({ content: text, ephemeral });
            }
          } catch {
            // Interaction may have expired (15-min token); nothing we
            // can do here. The adapter's normal channel-message path
            // still produced any side-effect notices.
          }
        };
        void Promise.resolve(
          onCommand({
            channelId: it.channelId,
            userId: it.user.id,
            userIsBot: it.user.bot,
            name: it.commandName,
            options,
            respond,
          }),
        );
      });
    }

    client.once(Events.ClientReady, () => {
      // Log on stdout so operators can verify command propagation at a
      // glance; failures (most often a missing `applications.commands`
      // OAuth scope) go to stderr with a re-invite hint instead of
      // taking the bot down — message-text commands keep working.
      void this.registerSlashCommands(client, opts.slashCommands, opts.devGuildId)
        .then((info) => {
          if (info) {
            const scope =
              info.scope === 'guild'
                ? `guild ${info.guildId}`
                : 'globally (may take up to 1h to propagate)';
            const names = info.names.length > 0 ? ` [${info.names.join(', ')}]` : '';
            process.stdout.write(
              `discord: registered ${info.names.length} slash commands → ${scope}${names}\n`,
            );
          }
        })
        .catch((err: unknown) => {
          const msg = err instanceof Error ? err.message : String(err);
          process.stderr.write(
            `discord: slash command registration failed: ${msg}\n` +
              `  hint: bot needs the 'applications.commands' OAuth scope; re-invite if missing.\n`,
          );
        });
      opts.onReady?.();
    });

    await client.login(this.token);
    this.client = client;
  }

  private async registerSlashCommands(
    client: unknown,
    specs: DiscordSlashCommandSpec[] | undefined,
    devGuildId: string | undefined,
  ): Promise<
    | { scope: 'guild'; guildId: string; names: string[] }
    | { scope: 'global'; names: string[] }
    | undefined
  > {
    if (!specs || specs.length === 0) return undefined;
    const djs = await import('discord.js');
    const { SlashCommandBuilder } = djs;
    const builders = specs.map((spec) => {
      const b = new SlashCommandBuilder().setName(spec.name).setDescription(spec.description);
      const opt = spec.option;
      if (opt) {
        b.addStringOption((o) => {
          o.setName(opt.name).setDescription(opt.description).setRequired(opt.required ?? false);
          if (opt.autocomplete) o.setAutocomplete(true);
          return o;
        });
      }
      return b.toJSON();
    });
    const c = client as {
      application?: { commands?: { set: (cmds: unknown[]) => Promise<unknown> } };
      guilds?: { fetch: (id: string) => Promise<{ commands: { set: (cmds: unknown[]) => Promise<unknown> } }> };
    };
    const names = specs.map((s) => s.name);
    if (devGuildId && c.guilds?.fetch) {
      const guild = await c.guilds.fetch(devGuildId);
      await guild.commands.set(builders);
      return { scope: 'guild', guildId: devGuildId, names };
    }
    if (c.application?.commands) {
      await c.application.commands.set(builders);
      return { scope: 'global', names };
    }
    return undefined;
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
