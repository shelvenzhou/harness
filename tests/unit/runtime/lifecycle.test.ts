import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  consumeHandoff,
  deletePidFile,
  deleteReadyFile,
  handoffFilePath,
  pidFilePath,
  readPidFile,
  readReadyFile,
  readyFilePath,
  writeHandoff,
  writePidFile,
  writeReadyFile,
} from '@harness/runtime/lifecycle.js';

describe('lifecycle file handshake', () => {
  it('round-trips the ready file (write → read → delete)', () => {
    const root = mkdtempSync(join(tmpdir(), 'harness-lifecycle-'));
    writeReadyFile(root, {
      pid: 12345,
      sha: 'deadbeef',
      ref: 'main',
      startedAt: '2026-05-09T00:00:00Z',
    });
    const path = readyFilePath(root);
    expect(existsSync(path)).toBe(true);
    const round = readReadyFile(root);
    expect(round).toEqual({
      pid: 12345,
      sha: 'deadbeef',
      ref: 'main',
      startedAt: '2026-05-09T00:00:00Z',
    });
    deleteReadyFile(root);
    expect(existsSync(path)).toBe(false);
    expect(readReadyFile(root)).toBeUndefined();
  });

  it('consumes the handoff file (read + delete)', () => {
    const root = mkdtempSync(join(tmpdir(), 'harness-lifecycle-handoff-'));
    writeHandoff(root, {
      fromSha: 'aaaa111',
      toSha: 'bbbb222',
      ref: 'feat/x',
      outcome: 'success',
      writtenAt: '2026-05-09T00:01:00Z',
    });
    expect(existsSync(handoffFilePath(root))).toBe(true);

    const first = consumeHandoff(root);
    expect(first?.fromSha).toBe('aaaa111');
    expect(first?.toSha).toBe('bbbb222');
    expect(first?.outcome).toBe('success');

    // Second consume must be empty — the file was deleted by the first.
    expect(existsSync(handoffFilePath(root))).toBe(false);
    expect(consumeHandoff(root)).toBeUndefined();
  });

  it('handles missing files cleanly (no throws)', () => {
    const root = mkdtempSync(join(tmpdir(), 'harness-lifecycle-empty-'));
    expect(readReadyFile(root)).toBeUndefined();
    expect(consumeHandoff(root)).toBeUndefined();
    expect(readPidFile(root)).toBeUndefined();
    // Deletes are best-effort.
    deleteReadyFile(root);
    deletePidFile(root);
  });

  it('writes pid as plain integer string', () => {
    const root = mkdtempSync(join(tmpdir(), 'harness-lifecycle-pid-'));
    writePidFile(root, 4242);
    expect(readFileSync(pidFilePath(root), 'utf8').trim()).toBe('4242');
    expect(readPidFile(root)).toBe(4242);
  });

  it('writeReadyFile is atomic against partial bytes (rename in place)', () => {
    // We can't realistically race the renameSync, but we can verify
    // the on-disk shape is valid JSON immediately after write.
    const root = mkdtempSync(join(tmpdir(), 'harness-lifecycle-atomic-'));
    writeReadyFile(root, { pid: 1, startedAt: 'now' });
    const raw = readFileSync(readyFilePath(root), 'utf8');
    expect(() => JSON.parse(raw)).not.toThrow();
  });
});
