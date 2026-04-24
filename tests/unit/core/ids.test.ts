import { describe, it, expect } from 'vitest';

import {
  newEventId,
  newHandleRef,
  newThreadId,
  newToolCallId,
  newTurnId,
} from '@harness/core/ids.js';
import { childOf, newRootTraceparent, tryParse } from '@harness/core/traceparent.js';

describe('core/ids', () => {
  it('mints distinct ids per call', () => {
    expect(newThreadId()).not.toEqual(newThreadId());
    expect(newTurnId()).not.toEqual(newTurnId());
    expect(newEventId()).not.toEqual(newEventId());
    expect(newToolCallId()).not.toEqual(newToolCallId());
    expect(newHandleRef()).not.toEqual(newHandleRef());
  });

  it('uses expected prefixes', () => {
    expect(newThreadId()).toMatch(/^thr_/);
    expect(newTurnId()).toMatch(/^trn_/);
    expect(newEventId()).toMatch(/^evt_/);
    expect(newToolCallId()).toMatch(/^tc_/);
    expect(newHandleRef()).toMatch(/^h_/);
  });
});

describe('core/traceparent', () => {
  it('parses a root traceparent', () => {
    const tp = newRootTraceparent();
    const parsed = tryParse(tp);
    expect(parsed).toBeDefined();
    expect(parsed?.traceId.length).toBe(32);
    expect(parsed?.parentId.length).toBe(16);
  });

  it('childOf shares traceId, differs in parentId', () => {
    const parent = newRootTraceparent();
    const child = childOf(parent);
    const p = tryParse(parent);
    const c = tryParse(child);
    expect(p?.traceId).toEqual(c?.traceId);
    expect(p?.parentId).not.toEqual(c?.parentId);
  });

  it('childOf without parent still yields a valid traceparent', () => {
    const tp = childOf(undefined);
    expect(tryParse(tp)).toBeDefined();
  });
});
