import { createInterface, type Interface as ReadlineInterface } from 'node:readline';

import { newEventId } from '@harness/core/ids.js';
import type { EventBus } from '@harness/bus/eventBus.js';
import type { StreamBus, StreamSubscription } from '@harness/bus/streamBus.js';
import type { ThreadId } from '@harness/core/ids.js';
import type { SessionStore } from '@harness/store/sessionStore.js';

import type { Adapter, AdapterStartOptions } from './adapter.js';
import { RawLineReader } from './rawLineReader.js';

/**
 * Terminal adapter — stdin/stdout REPL.
 *
 * - Each line of stdin becomes either a `user_turn_start` (if no turn is
 *   active) or a `user_input` (steer into the active turn).
 * - Subscribes to `reply`, `preamble`, `turn_complete`,
 *   `compaction_event`, and `interrupt`; streams them to stdout with
 *   minimal formatting. The interrupt subscription matters: the
 *   runner takes a moment to unwind in-flight sampling after an
 *   abort, and the user needs visible feedback during that window.
 * - First Ctrl-C publishes an `interrupt` event (soft cancel of the
 *   in-flight turn). Second Ctrl-C inside the doubleInterruptMs
 *   window stops the adapter and resolves a shutdown promise so the
 *   CLI host can exit cleanly. Lifted out of the CLI shell because
 *   the previous "expected to be caught externally" contract was
 *   never wired and double-Ctrl-C just killed the process.
 *
 * Phase 1 ships single-thread binding only.
 */

export interface TerminalAdapterOptions {
  store: SessionStore;
  input?: NodeJS.ReadableStream;
  output?: NodeJS.WritableStream;
  /**
   * Window inside which a second Ctrl-C is treated as "exit now"
   * rather than a redundant interrupt. Default 2000ms.
   */
  doubleInterruptMs?: number;
}

export class TerminalAdapter implements Adapter {
  readonly id = 'terminal';

  private rl: ReadlineInterface | undefined;
  private rawReader: RawLineReader | undefined;
  private bus?: EventBus;
  private threadId?: ThreadId;
  private subscription?: { unsubscribe(): void };
  private streamSubscription?: StreamSubscription;
  private turnActive = false;
  /**
   * Per-channel streaming state. We track the text already streamed
   * inline so the persisted reply/preamble events can be deduped (we
   * already showed it). Re-keyed on every sampling_flush.
   */
  private streamed: { reply: string; preamble: string; reasoning: string } = {
    reply: '',
    preamble: '',
    reasoning: '',
  };
  /**
   * Which channel currently owns the open stdout line — needed to
   * decide whether the next delta of a *different* channel should
   * print on a new line. 'none' means no streamed line is open.
   */
  private openChannel: 'reply' | 'preamble' | 'reasoning' | 'none' = 'none';
  /**
   * Set by sampling_flush: the next delta starts a fresh sampling and
   * the streamed buffers (still kept around for dedupe against the
   * persisted events from the previous sampling) need to be reset
   * before we append more.
   */
  private flushed = false;
  private readonly store: SessionStore;
  private readonly input: NodeJS.ReadableStream;
  private readonly output: NodeJS.WritableStream;
  private readonly doubleInterruptMs: number;
  private lastSigintAt = 0;
  private sigintHandler: (() => void) | undefined;
  private readonly shutdownPromise: Promise<void>;
  private resolveShutdown!: () => void;

  constructor(opts: TerminalAdapterOptions) {
    this.store = opts.store;
    this.input = opts.input ?? process.stdin;
    this.output = opts.output ?? process.stdout;
    this.doubleInterruptMs = opts.doubleInterruptMs ?? 2_000;
    this.shutdownPromise = new Promise<void>((resolve) => {
      this.resolveShutdown = resolve;
    });
  }

  /**
   * Resolves when the adapter has been asked to shut down (e.g. via
   * double Ctrl-C). The CLI host awaits this before exiting so the
   * process can drain in-flight work.
   */
  whenShutdown(): Promise<void> {
    return this.shutdownPromise;
  }

  async start(opts: AdapterStartOptions): Promise<void> {
    if (opts.threadBinding.kind !== 'single') {
      throw new Error('TerminalAdapter only supports single thread binding in phase 1');
    }
    this.bus = opts.bus;
    this.threadId = opts.threadBinding.threadId;

    this.subscription = opts.bus.subscribe(
      (ev) => this.onBusEvent(ev),
      {
        threadId: this.threadId,
        kinds: ['reply', 'preamble', 'reasoning', 'turn_complete', 'compaction_event', 'interrupt'],
      },
    );

    if (opts.streamBus) {
      this.streamSubscription = opts.streamBus.subscribe(
        (ev) => this.onStreamEvent(ev),
        { threadId: this.threadId },
      );
    }

    // SIGINT: first hit interrupts the turn, second within the window
    // shuts the adapter down. Without this the CLI shell killed the
    // process on the first Ctrl-C and the runtime never saw the
    // interrupt event, so any pending state (timers, child agents)
    // was orphaned on exit.
    this.sigintHandler = () => {
      void this.onSigint();
    };
    process.on('SIGINT', this.sigintHandler);

    if (this.isTty(this.input)) {
      // Real TTY → raw-mode editor with bracketed-paste + heredoc
      // multi-line. Tests use PassThrough streams (not a TTY) and fall
      // through to the readline path below.
      this.rawReader = new RawLineReader({
        input: this.input as NodeJS.ReadStream,
        output: this.output,
      });
      this.rawReader.on((ev) => {
        if (ev.kind === 'line') void this.onLine(ev.text);
        else if (ev.kind === 'sigint') void this.onSigint();
        else if (ev.kind === 'eof') void this.shutdownAndExit();
      });
      this.rawReader.start();
    } else {
      // Non-TTY (piped input, tests): readline gives us line-based
      // input. terminal:true keeps CJK backspace consistent with the
      // displayed columns — see commit fa42452.
      this.rl = createInterface({
        input: this.input,
        output: this.output,
        terminal: true,
      });
      this.rl.setPrompt('» ');
      this.rl.on('line', (line) => {
        void this.onLine(line);
      });
      // In terminal:true mode on a real TTY, readline puts stdin into
      // raw mode and surfaces Ctrl-C as a 'SIGINT' event on the rl
      // interface — but on PassThrough inputs (tests) it doesn't, so
      // we still need this binding for synthesized process.emit calls.
      this.rl.on('SIGINT', this.sigintHandler);
      this.writePrompt();
    }
  }

  async stop(): Promise<void> {
    this.subscription?.unsubscribe();
    this.streamSubscription?.unsubscribe();
    if (this.sigintHandler) {
      process.removeListener('SIGINT', this.sigintHandler);
      this.sigintHandler = undefined;
    }
    if (this.rawReader) {
      this.rawReader.stop();
      this.rawReader = undefined;
    }
    this.rl?.close();
    this.resolveShutdown();
  }

  private async shutdownAndExit(): Promise<void> {
    this.output.write('\n[exiting]\n');
    await this.stop();
    process.exit(0);
  }

  private isTty(stream: NodeJS.ReadableStream): stream is NodeJS.ReadStream {
    return Boolean((stream as { isTTY?: boolean }).isTTY);
  }

  private async onSigint(): Promise<void> {
    const now = Date.now();
    if (now - this.lastSigintAt < this.doubleInterruptMs) {
      this.output.write('\n[exiting]\n');
      await this.stop();
      return;
    }
    this.lastSigintAt = now;
    this.output.write('\n[interrupting — press Ctrl-C again to exit]\n');
    if (this.bus && this.threadId) {
      await this.publishInterrupt();
    }
  }

  private writePrompt(): void {
    if (this.rawReader) {
      this.rawReader.refresh();
    } else if (this.rl) {
      this.rl.prompt();
    } else {
      this.output.write('» ');
    }
  }

  private async onLine(line: string): Promise<void> {
    if (!this.bus || !this.threadId) return;
    const text = line.trim();
    if (!text) {
      this.writePrompt();
      return;
    }
    if (text === '/exit' || text === '/quit') {
      await this.stop();
      process.exit(0);
      return;
    }
    if (text === '/interrupt') {
      await this.publishInterrupt();
      return;
    }

    if (this.turnActive) {
      await this.publishUserInput(text);
    } else {
      this.turnActive = true;
      await this.publishUserTurnStart(text);
    }
  }

  private async publishUserTurnStart(text: string): Promise<void> {
    const event = await this.store.append({
      id: newEventId(),
      threadId: this.threadId!,
      kind: 'user_turn_start',
      payload: { text },
    });
    this.bus!.publish(event);
  }

  private async publishUserInput(text: string): Promise<void> {
    const event = await this.store.append({
      id: newEventId(),
      threadId: this.threadId!,
      kind: 'user_input',
      payload: { text },
    });
    this.bus!.publish(event);
  }

  private async publishInterrupt(): Promise<void> {
    const event = await this.store.append({
      id: newEventId(),
      threadId: this.threadId!,
      kind: 'interrupt',
      payload: { reason: 'user requested interrupt' },
    });
    this.bus!.publish(event);
  }

  private onBusEvent(ev: Parameters<Parameters<EventBus['subscribe']>[0]>[0]): void {
    switch (ev.kind) {
      case 'preamble': {
        const p = ev.payload as { text: string };
        // sampling_flush already closed the open line — if the
        // persisted text matches what we streamed, suppress the
        // re-print entirely. Otherwise fall back to a fresh dimmed
        // block.
        if (this.streamed.preamble === p.text && p.text.length > 0) {
          this.streamed.preamble = '';
        } else {
          this.closeOpenChannel();
          this.writeBlock('› ', p.text, { dim: true });
        }
        break;
      }
      case 'reply': {
        const p = ev.payload as { text: string; internal?: boolean };
        if (p.internal) break;
        if (this.streamed.reply === p.text && p.text.length > 0) {
          this.streamed.reply = '';
        } else {
          this.closeOpenChannel();
          this.writeBlock('▸ ', p.text, { dim: false });
        }
        break;
      }
      case 'reasoning': {
        // Reasoning is normally streamed live via `reasoning_delta`.
        // The persisted reasoning event still arrives — suppress if
        // we already showed it; otherwise emit a dimmed block so
        // users on non-streaming providers see it.
        const p = ev.payload as { text: string };
        if (this.streamed.reasoning === p.text && p.text.length > 0) {
          this.streamed.reasoning = '';
        } else {
          this.closeOpenChannel();
          this.writeBlock('✻ ', p.text, { dim: true });
        }
        break;
      }
      case 'turn_complete': {
        const p = ev.payload as { status: string; summary?: string; reason?: string };
        if (p.status !== 'completed') {
          const details =
            p.summary && p.reason
              ? `${p.summary} (reason=${p.reason})`
              : p.summary ?? p.reason;
          if (details) {
            this.output.write(`\x1b[2m[turn ${p.status}: ${details}]\x1b[0m\n`);
          } else {
            this.output.write(`\x1b[2m[turn ${p.status}]\x1b[0m\n`);
          }
        }
        this.writeTurnSeparator();
        this.turnActive = false;
        this.writePrompt();
        break;
      }
      case 'compaction_event': {
        const p = ev.payload as {
          reason: string;
          tokensBefore: number;
          tokensAfter: number;
        };
        this.output.write(
          `\x1b[2m[compacted reason=${p.reason} ${p.tokensBefore}→${p.tokensAfter} tok]\x1b[0m\n`,
        );
        break;
      }
      case 'interrupt': {
        // Visible feedback while the runner unwinds the in-flight
        // sampling — without this, double-Ctrl-C felt like a freeze.
        const p = ev.payload as { reason?: string };
        const reason = p.reason ? ` (${p.reason})` : '';
        this.output.write(`\x1b[2m[interrupt${reason}]\x1b[0m\n`);
        break;
      }
      default:
        break;
    }
  }

  private onStreamEvent(ev: import('@harness/bus/streamBus.js').StreamEvent): void {
    if (ev.kind === 'sampling_flush') {
      // Don't clear streamed buffers here — the persisted reply /
      // preamble / reasoning events for *this* sampling haven't fired
      // yet, and they need streamed.X to be intact for dedupe. We
      // just close the open visual line so further prints don't merge
      // into it, and arm a reset for the next sampling's first delta.
      this.closeOpenChannel();
      this.flushed = true;
      return;
    }
    // First delta after a flush starts a new sampling — reset what
    // any leftover dedupe never matched against.
    if (this.flushed) {
      this.streamed.reply = '';
      this.streamed.preamble = '';
      this.streamed.reasoning = '';
      this.flushed = false;
    }
    if (ev.kind === 'reasoning_delta') {
      this.openChannelIfNeeded('reasoning');
      this.streamed.reasoning += ev.text;
      this.output.write(ev.text);
      return;
    }
    // text_delta — channel is best-effort. Untagged deltas land in
    // 'reply' so the user sees them immediately; if the parser later
    // reclassifies as preamble, the persisted preamble event won't
    // match `streamed.reply` and we fall back to a fresh dimmed
    // print. Cosmetic glitch, no correctness impact.
    const channel: 'reply' | 'preamble' = ev.channel ?? 'reply';
    this.openChannelIfNeeded(channel);
    this.streamed[channel] += ev.text;
    this.output.write(ev.text);
  }

  private openChannelIfNeeded(channel: 'reply' | 'preamble' | 'reasoning'): void {
    if (this.openChannel === channel) return;
    this.closeOpenChannel();
    if (channel === 'reply') {
      this.output.write('▸ ');
    } else if (channel === 'preamble') {
      this.output.write('\x1b[2m› ');
    } else {
      this.output.write('\x1b[2m✻ ');
    }
    this.openChannel = channel;
  }

  private closeOpenChannel(): void {
    if (this.openChannel === 'none') return;
    if (this.openChannel === 'reply') this.output.write('\n');
    else this.output.write('\x1b[0m\n');
    this.openChannel = 'none';
  }

  /**
   * Render a multi-paragraph block with a leading prefix on the first
   * line and a hanging indent on subsequent visual lines, soft-wrapped
   * to the terminal's column width. Used for the persisted
   * reply / preamble / reasoning fallbacks (when nothing was streamed
   * inline). We don't apply this to the streaming path: deltas arrive
   * unaligned with word boundaries, and re-flowing them mid-stream
   * would require column tracking we don't have.
   */
  private writeBlock(prefix: string, text: string, opts: { dim: boolean }): void {
    const cols = this.colCount();
    // Reserve at least 20 chars for content; on tiny terminals we
    // give up on wrapping and just emit the raw text.
    const indent = ' '.repeat(prefix.length);
    const width = Math.max(20, cols - prefix.length);
    const open = opts.dim ? '\x1b[2m' : '';
    const close = opts.dim ? '\x1b[0m' : '';
    const paragraphs = text.split('\n');
    let firstLine = true;
    for (const para of paragraphs) {
      if (para.length === 0) {
        // Preserve blank lines in the original text.
        this.output.write(firstLine ? `${open}${prefix}${close}\n` : `${open}${close}\n`);
        firstLine = false;
        continue;
      }
      const wrapped = wrapToWidth(para, width);
      for (let i = 0; i < wrapped.length; i++) {
        const lead = firstLine && i === 0 ? prefix : indent;
        this.output.write(`${open}${lead}${wrapped[i]}${close}\n`);
      }
      firstLine = false;
    }
  }

  /**
   * Faint horizontal divider before the next prompt. Visually
   * separates assistant turns so longer outputs don't run together.
   */
  private writeTurnSeparator(): void {
    const cols = Math.min(this.colCount(), 80);
    if (cols <= 4) return;
    this.output.write(`\x1b[2m${'─'.repeat(cols)}\x1b[0m\n`);
  }

  private colCount(): number {
    const out = this.output as unknown as { columns?: number };
    return out.columns && out.columns > 0 ? out.columns : 80;
  }
}

/**
 * Greedy soft-wrap on whitespace boundaries. A single token longer
 * than the column budget is emitted on its own line untouched — we
 * prefer spilling over to mid-token splits since URLs and code
 * fragments are common in agent output.
 */
function wrapToWidth(text: string, width: number): string[] {
  if (width <= 0 || text.length <= width) return [text];
  const out: string[] = [];
  const tokens = text.split(/(\s+)/);
  let line = '';
  for (const tok of tokens) {
    if (tok.length === 0) continue;
    if (line.length + tok.length > width) {
      if (line.length > 0) {
        out.push(line.replace(/\s+$/, ''));
        line = '';
      }
      if (tok.length > width) {
        // Token alone exceeds width — emit it whole.
        out.push(tok);
        continue;
      }
    }
    if (line.length === 0 && /^\s+$/.test(tok)) continue;
    line += tok;
  }
  if (line.length > 0) out.push(line.replace(/\s+$/, ''));
  return out.length > 0 ? out : [''];
}
