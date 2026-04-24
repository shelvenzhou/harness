import { describe, it, expect } from 'vitest';

import { newHandleRef, newThreadId, newToolCallId, newTurnId } from '@harness/core/ids.js';
import { shellTool } from '@harness/tools/impl/shell.js';
import type { ToolExecutionContext } from '@harness/tools/tool.js';

function ctx(signal = new AbortController().signal): ToolExecutionContext {
  return {
    threadId: newThreadId(),
    turnId: newTurnId(),
    toolCallId: newToolCallId(),
    signal,
    log: () => void 0,
    registerHandle: () => newHandleRef(),
    services: {},
  };
}

describe('shellTool', () => {
  it('captures stdout and returns ok on exit 0', async () => {
    const r = await shellTool.execute({ cmd: "echo -n 'hi'" }, ctx());
    expect(r.ok).toBe(true);
    expect(r.output?.exitCode).toBe(0);
    expect(r.output?.stdout).toBe('hi');
  });

  it('propagates non-zero exit as ok=false', async () => {
    const r = await shellTool.execute({ cmd: 'exit 7' }, ctx());
    expect(r.ok).toBe(false);
    expect(r.output?.exitCode).toBe(7);
  });

  it('kills the process on timeout', async () => {
    const r = await shellTool.execute({ cmd: 'sleep 5', timeoutMs: 150 }, ctx());
    expect(r.output?.timedOut).toBe(true);
    expect(r.ok).toBe(false);
  }, 5_000);

  it('truncates large output and registers an elided handle', async () => {
    const handles: string[] = [];
    const r = await shellTool.execute(
      { cmd: "head -c 10000 /dev/urandom | base64", maxOutputBytes: 512 },
      {
        ...ctx(),
        registerHandle: (_k, _p, _m) => {
          const h = newHandleRef();
          handles.push(h);
          return h;
        },
      },
    );
    expect(r.ok).toBe(true);
    expect(r.output?.truncated).toBe(true);
    expect(r.elided).toBeDefined();
    expect(handles.length).toBe(1);
  });

  it('honours AbortSignal', async () => {
    const ac = new AbortController();
    const p = shellTool.execute({ cmd: 'sleep 5' }, ctx(ac.signal));
    setTimeout(() => ac.abort(), 50);
    const r = await p;
    // Aborted processes exit via signal; either way, not ok.
    expect(r.ok).toBe(false);
  }, 5_000);
});
