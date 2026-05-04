import { createInterface, type Interface as ReadlineInterface } from 'node:readline';

import { newEventId } from '@harness/core/ids.js';
import type { EventBus } from '@harness/bus/eventBus.js';
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
  private turnActive = false;
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
        kinds: ['reply', 'preamble', 'turn_complete', 'compaction_event', 'interrupt'],
      },
    );

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
        this.output.write(`\x1b[2m› ${p.text}\x1b[0m\n`);
        break;
      }
      case 'reply': {
        const p = ev.payload as { text: string; internal?: boolean };
        if (p.internal) break;
        this.output.write(`▸ ${p.text}\n`);
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
}
