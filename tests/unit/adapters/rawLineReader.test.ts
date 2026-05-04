import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';

import { RawLineReader, type RawLineReaderEvent } from '@harness/adapters/rawLineReader.js';

/**
 * RawLineReader sits below TerminalAdapter and is what makes
 * multi-line input + bracketed paste actually work on real TTYs.
 * Tests use a fake ReadStream (PassThrough with isTTY/setRawMode
 * stubbed) so we can drive byte sequences deterministically.
 */

interface FakeTty extends PassThrough {
  isTTY: boolean;
  setRawMode: (raw: boolean) => void;
}

function makeReader() {
  const input = new PassThrough() as FakeTty;
  input.isTTY = true;
  input.setRawMode = () => {};
  const output = new PassThrough();
  // Drain output so write() never blocks.
  output.resume();
  const reader = new RawLineReader({
    input: input as unknown as NodeJS.ReadStream,
    output,
  });
  const events: RawLineReaderEvent[] = [];
  reader.on((ev) => events.push(ev));
  reader.start();
  return { reader, input, output, events };
}

async function tick(): Promise<void> {
  await new Promise((r) => setImmediate(r));
}

describe('RawLineReader', () => {
  it('emits a single line when Enter is pressed after typed input', async () => {
    const { reader, input, events } = makeReader();
    input.write('hello\r');
    await tick();
    expect(events).toEqual([{ kind: 'line', text: 'hello' }]);
    reader.stop();
  });

  it('handles backspace before submission', async () => {
    const { reader, input, events } = makeReader();
    input.write('abc\x7f\x7fX\r');
    await tick();
    expect(events).toEqual([{ kind: 'line', text: 'aX' }]);
    reader.stop();
  });

  it('treats a bracketed-paste block as a single multi-line buffer that is submitted on Enter', async () => {
    const { reader, input, events } = makeReader();
    // Paste markers wrap "line1\nline2\nline3"; embedded newlines must
    // NOT trigger a submit while the paste block is open.
    input.write('\x1b[200~line1\nline2\nline3\x1b[201~');
    await tick();
    expect(events).toHaveLength(0); // no submit yet — waiting for Enter
    input.write('\r');
    await tick();
    expect(events).toEqual([{ kind: 'line', text: 'line1\nline2\nline3' }]);
    reader.stop();
  });

  it('reassembles a paste even when start/end markers arrive split across data chunks', async () => {
    const { reader, input, events } = makeReader();
    // Split mid-marker — exercises the partial-marker hold-back path.
    input.write('\x1b[200~one\ntwo\x1b[2');
    await tick();
    input.write('01~final\r');
    await tick();
    expect(events).toEqual([{ kind: 'line', text: 'one\ntwofinal' }]);
    reader.stop();
  });

  it('uses """ heredoc fences so users can compose multi-line input by hand', async () => {
    const { reader, input, events } = makeReader();
    input.write('"""\r');
    await tick();
    expect(events).toHaveLength(0);
    input.write('first\r');
    input.write('second\r');
    input.write('"""\r');
    await tick();
    expect(events).toEqual([{ kind: 'line', text: 'first\nsecond' }]);
    reader.stop();
  });

  it('reports Ctrl-C as sigint and Ctrl-D on empty buffer as eof', async () => {
    const { reader, input, events } = makeReader();
    input.write('\x03');
    await tick();
    input.write('\x04');
    await tick();
    expect(events).toEqual([{ kind: 'sigint' }, { kind: 'eof' }]);
    reader.stop();
  });

  it('ignores Ctrl-D when the buffer has content', async () => {
    const { reader, input, events } = makeReader();
    input.write('abc\x04\r');
    await tick();
    expect(events).toEqual([{ kind: 'line', text: 'abc' }]);
    reader.stop();
  });
});
