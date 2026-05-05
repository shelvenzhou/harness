/**
 * RawLineReader — minimal raw-mode line editor used by TerminalAdapter
 * when stdin is a real TTY.
 *
 * Why not Node's `readline`?
 *   - readline emits one `line` per `\n`, which means a multi-line paste
 *     becomes many separate user inputs (one turn per line).
 *   - readline cannot be told to fold a bracketed-paste block into a
 *     single line: even if the terminal sends `ESC [200~ … ESC [201~`,
 *     the embedded newlines still trigger separate `line` events.
 *
 * What we support:
 *   - Bracketed paste mode (xterm CSI ?2004h). Bytes between
 *     `ESC [200~` and `ESC [201~` go straight into the input buffer with
 *     newlines preserved; the user must press Enter on the trailing
 *     empty line to submit.
 *   - `"""` heredoc fence for typed multi-line input. A line whose
 *     trimmed content is exactly `"""` toggles the fence; another `"""`
 *     submits the accumulated content.
 *   - Backspace (BS / DEL), Enter, Ctrl-C (SIGINT), Ctrl-D (EOF on
 *     empty buffer). Arrow keys / history are intentionally out of
 *     scope — we never had them with readline either, and adding them
 *     would balloon this module.
 *
 * What we don't do:
 *   - Cursor movement inside the buffer. Editing happens at the tail.
 *   - Resize-aware redraw. We rely on the terminal wrapping itself.
 */

import type { EventEmitter } from 'node:events';

export interface RawLineReaderOptions {
  input: NodeJS.ReadStream;
  output: NodeJS.WritableStream;
  prompt?: string;
  /** Continuation prompt rendered for lines after the first. */
  continuationPrompt?: string;
}

export type RawLineReaderEvent =
  | { kind: 'line'; text: string }
  | { kind: 'sigint' }
  | { kind: 'eof' };

export type RawLineReaderListener = (event: RawLineReaderEvent) => void;

const PASTE_START = '\x1b[200~';
const PASTE_END = '\x1b[201~';

export class RawLineReader {
  private readonly input: NodeJS.ReadStream;
  private readonly output: NodeJS.WritableStream;
  private readonly prompt: string;
  private readonly contPrompt: string;

  private buf = '';
  private rawStash = '';
  private inPaste = false;
  private heredocActive = false;
  /** Number of terminal rows we last rendered, so we can erase them. */
  private renderedRows = 1;
  /** Column count we cached at last render — used for wrap math. */
  private lastCols = 80;

  private listeners: RawLineReaderListener[] = [];
  private dataHandler: ((chunk: Buffer | string) => void) | undefined;
  private started = false;
  private resizeHandler: (() => void) | undefined;

  constructor(opts: RawLineReaderOptions) {
    this.input = opts.input;
    this.output = opts.output;
    this.prompt = opts.prompt ?? '» ';
    this.contPrompt = opts.continuationPrompt ?? '· ';
  }

  on(listener: RawLineReaderListener): () => void {
    this.listeners.push(listener);
    return () => {
      this.listeners = this.listeners.filter((l) => l !== listener);
    };
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    if (typeof this.input.setRawMode === 'function') this.input.setRawMode(true);
    this.input.setEncoding('utf8');
    // Enable bracketed paste mode. We disable it in stop() so the
    // terminal isn't left in a non-default state if the host process
    // continues running (CLI exits the process anyway, but tests reuse
    // streams).
    this.output.write('\x1b[?2004h');
    this.lastCols = this.colCount();
    this.dataHandler = (chunk) => {
      this.feed(typeof chunk === 'string' ? chunk : chunk.toString('utf8'));
    };
    this.input.on('data', this.dataHandler);
    // If stdout is resized we just refresh — wrap math depends on cols.
    const out = this.output as unknown as EventEmitter & { columns?: number };
    if (typeof out.on === 'function') {
      this.resizeHandler = () => {
        this.lastCols = this.colCount();
      };
      out.on('resize', this.resizeHandler);
    }
    this.refresh();
  }

  stop(): void {
    if (!this.started) return;
    this.started = false;
    if (this.dataHandler) {
      this.input.off('data', this.dataHandler);
      this.dataHandler = undefined;
    }
    if (this.resizeHandler) {
      const out = this.output as unknown as EventEmitter;
      out.off?.('resize', this.resizeHandler);
      this.resizeHandler = undefined;
    }
    this.output.write('\x1b[?2004l');
    if (typeof this.input.setRawMode === 'function') this.input.setRawMode(false);
  }

  /**
   * Force a redraw of the current buffer (e.g. after some bus event
   * wrote to stdout above the prompt and we want the prompt back).
   */
  refresh(): void {
    this.eraseRendered();
    this.renderBuf();
  }

  private feed(chunk: string): void {
    this.rawStash += chunk;
    while (this.rawStash.length > 0) {
      if (this.inPaste) {
        const endIdx = this.rawStash.indexOf(PASTE_END);
        if (endIdx === -1) {
          // Hold back enough bytes to detect a split end marker.
          const safe = Math.max(0, this.rawStash.length - (PASTE_END.length - 1));
          if (safe === 0) return;
          this.appendChars(this.rawStash.slice(0, safe));
          this.rawStash = this.rawStash.slice(safe);
          return;
        }
        this.appendChars(this.rawStash.slice(0, endIdx));
        this.rawStash = this.rawStash.slice(endIdx + PASTE_END.length);
        this.inPaste = false;
        this.refresh();
        continue;
      }

      if (this.rawStash.startsWith(PASTE_START)) {
        this.rawStash = this.rawStash.slice(PASTE_START.length);
        this.inPaste = true;
        continue;
      }
      // Could be partial start/end marker — wait for more bytes.
      if (PASTE_START.startsWith(this.rawStash) || PASTE_END.startsWith(this.rawStash)) {
        return;
      }

      const consumed = this.processOne(this.rawStash);
      if (consumed === 0) return; // need more bytes for an in-flight escape
      this.rawStash = this.rawStash.slice(consumed);
    }
  }

  /** Consume a single key/sequence. Returns bytes consumed, 0 if partial. */
  private processOne(s: string): number {
    const c = s[0];
    if (c === undefined) return 0;
    // Ctrl-C
    if (c === '\x03') {
      this.emit({ kind: 'sigint' });
      return 1;
    }
    // Ctrl-D — EOF on empty buffer; otherwise ignored.
    if (c === '\x04') {
      if (this.buf.length === 0) this.emit({ kind: 'eof' });
      return 1;
    }
    // CR or LF → submit current buffer (or fence-toggle if heredoc).
    if (c === '\r' || c === '\n') {
      this.onEnter();
      return 1;
    }
    // Backspace / DEL.
    if (c === '\x7f' || c === '\b') {
      if (this.buf.length > 0) {
        this.buf = this.buf.slice(0, -1);
        this.refresh();
      }
      return 1;
    }
    // Escape sequences (CSI, SS3, Alt-prefix) — handle Alt+Enter and
    // the Kitty/WezTerm CSI u shift+enter as "insert newline"; eat
    // everything else (arrows, function keys) without acting. This
    // MUST come before the C0 drop below, since ESC (0x1b) is itself
    // a C0 control and would otherwise be eaten silently.
    if (c === '\x1b') {
      if (s.length < 2) return 0;
      const next = s[1];
      // Alt+Enter / Option+Return: ESC + CR or ESC + LF. This is the
      // most portable "newline without submit" key — every terminal
      // emulator surfaces Option/Alt+Return as the meta-prefixed CR.
      if (next === '\r' || next === '\n') {
        this.appendChars('\n');
        return 2;
      }
      if (next === '[' || next === 'O') {
        let i = 2;
        while (i < s.length) {
          const code = s.charCodeAt(i);
          // CSI final byte is in 0x40..0x7e.
          if (code >= 0x40 && code <= 0x7e) {
            // Kitty keyboard protocol: ESC [ <keycode> ; <mods> u.
            // Modifiers are bit-encoded with shift=1 (so mods=2 means
            // "shift only", mods=4 alt, mods=6 alt+shift, etc.). Any
            // modified Enter is treated as "insert newline" — the
            // unmodified Enter is delivered as plain CR and never
            // reaches this branch.
            if (code === 0x75 /* 'u' */) {
              const seq = s.slice(2, i);
              const m = /^(\d+)(?:;(\d+))?$/.exec(seq);
              if (m && (m[1] === '13' || m[1] === '10')) {
                this.appendChars('\n');
                return i + 1;
              }
            }
            return i + 1;
          }
          i++;
        }
        return 0; // partial CSI
      }
      // ESC + single char — eat both.
      return 2;
    }
    // Drop other C0 controls except TAB, which we render as a literal.
    if (c < ' ' && c !== '\t') {
      return 1;
    }
    // Regular character (handles UTF-8 because input is set to utf8).
    this.appendChars(c);
    return 1;
  }

  private appendChars(text: string): void {
    if (text.length === 0) return;
    this.buf += text;
    this.refresh();
  }

  private onEnter(): void {
    if (this.heredocActive) {
      // The fence closes when the user-just-typed line (the segment
      // after the last `\n`) is exactly `"""`. We can't trim the whole
      // buffer because earlier pasted lines have their own whitespace.
      const lastNl = this.buf.lastIndexOf('\n');
      const lastLine = lastNl === -1 ? this.buf : this.buf.slice(lastNl + 1);
      if (lastLine.trim() === '"""') {
        const text = lastNl === -1 ? '' : this.buf.slice(0, lastNl);
        this.buf = '';
        this.heredocActive = false;
        this.eraseRendered();
        this.emit({ kind: 'line', text });
        this.renderedRows = 1;
        this.renderBuf();
        return;
      }
      // Otherwise just commit a newline and keep editing.
      this.buf += '\n';
      this.refresh();
      return;
    }

    if (this.buf.trim() === '"""') {
      // Open fence: discard the typed `"""` and start accumulating.
      this.heredocActive = true;
      this.buf = '';
      this.refresh();
      return;
    }

    const text = this.buf;
    this.buf = '';
    this.eraseRendered();
    this.emit({ kind: 'line', text });
    this.renderedRows = 1;
    this.renderBuf();
  }

  private renderBuf(): void {
    const lines = this.buf.length > 0 ? this.buf.split('\n') : [''];
    let totalRows = 0;
    for (let i = 0; i < lines.length; i++) {
      const prefix = i === 0 ? this.prompt : this.contPrompt;
      const lineText = lines[i] ?? '';
      if (i > 0) this.output.write('\n');
      this.output.write(prefix + lineText);
      totalRows += this.rowsFor(prefix.length + lineText.length);
    }
    this.renderedRows = Math.max(1, totalRows);
  }

  private eraseRendered(): void {
    // Move to start of the current row.
    this.output.write('\r');
    // Erase from there down: walk up renderedRows-1 lines, clearing each.
    for (let i = 0; i < this.renderedRows - 1; i++) {
      this.output.write('\x1b[2K\x1b[1A');
    }
    this.output.write('\x1b[2K');
  }

  private rowsFor(visualLen: number): number {
    const cols = this.lastCols;
    if (cols <= 0) return 1;
    return Math.max(1, Math.ceil(visualLen / cols));
  }

  private colCount(): number {
    const out = this.output as unknown as { columns?: number };
    return out.columns && out.columns > 0 ? out.columns : 80;
  }

  private emit(event: RawLineReaderEvent): void {
    for (const listener of this.listeners) listener(event);
  }
}
