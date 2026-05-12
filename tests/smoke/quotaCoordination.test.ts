import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import type {
  LlmCapabilities,
  LlmProvider,
  SamplingDelta,
  SamplingRequest,
} from '@harness/llm/provider.js';
import { bootstrap } from '@harness/runtime/bootstrap.js';

/**
 * Smoke: M2 quota coordination.
 *
 *  - A fake `claude` binary emits a `rate_limit_event` with
 *    `status: 'blocked'` and then errors out → the child's
 *    `turn_complete.reason` becomes `quota_exhausted` and
 *    `subtask_complete.reason` / `resetAt` round-trip to the
 *    parent.
 *  - A subsequent spawn for the same provider short-circuits
 *    (no CLI process, immediate synthetic `subtask_complete`)
 *    until the resetAt elapses.
 *  - When the timer fires, the pool publishes
 *    `external_event{source:'provider_ready', …}` on the bus
 *    so a parent that was `wait`-ing can wake up.
 *  - `continueThreadId` reopen: the parent can pass the prior
 *    child's threadId and the pool reuses it instead of
 *    creating a new thread.
 */

class ScriptedProvider implements LlmProvider {
  readonly id = 'scripted';
  readonly capabilities: LlmCapabilities = {
    prefixCache: false,
    cacheEdits: false,
    nativeToolUse: true,
    nativeReasoning: false,
    maxContextTokens: 100_000,
  };
  private idx = 0;
  constructor(private readonly script: SamplingDelta[][]) {}
  async *sample(_req: SamplingRequest, signal: AbortSignal): AsyncIterable<SamplingDelta> {
    const deltas = this.script[Math.min(this.idx++, this.script.length - 1)] ?? [];
    for (const d of deltas) {
      if (signal.aborted) return;
      yield d;
    }
    if (!deltas.some((d) => d.kind === 'end')) yield { kind: 'end', stopReason: 'end_turn' };
  }
}

/**
 * Fake cc that emits a blocked rate_limit_event then errors out.
 * `resetUnix` is the unix-seconds timestamp the binary will report
 * — the parent's wait timer is driven off it.
 */
function setupBlockedCc(workdir: string, sessionId: string, resetUnix: number): string {
  const script = join(workdir, 'fake-cc.cjs');
  writeFileSync(
    script,
    [
      `const fs = require('fs');`,
      `process.stdout.write(JSON.stringify({ type: 'system', subtype: 'init', session_id: ${JSON.stringify(sessionId)}, model: 'fake-blocked' }) + '\\n');`,
      `process.stdout.write(JSON.stringify({ type: 'rate_limit_event', rate_limit_info: { status: 'blocked', resetsAt: ${resetUnix}, rateLimitType: 'five_hour', utilization: 1.0, surpassedThreshold: 1.0, isUsingOverage: false } }) + '\\n');`,
      `process.stdout.write(JSON.stringify({ type: 'result', subtype: 'error_during_execution', is_error: true, duration_ms: 5, num_turns: 0, result: 'rate limited', session_id: ${JSON.stringify(sessionId)} }) + '\\n');`,
    ].join('\n'),
  );
  const launcher = join(workdir, 'cc-launcher.sh');
  writeFileSync(launcher, `#!/bin/sh\nexec ${process.execPath} ${script} "$@"\n`);
  chmodSync(launcher, 0o755);
  return launcher;
}

async function settle(ms: number): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

async function waitForKind(
  runtime: Awaited<ReturnType<typeof bootstrap>>,
  kind: string,
  matcher: (ev: { payload: unknown }) => boolean = () => true,
): Promise<void> {
  for (let i = 0; i < 100; i++) {
    await settle(40);
    const events = await runtime.store.readAll(runtime.rootThreadId);
    if (events.some((e) => e.kind === kind && matcher(e))) return;
  }
  throw new Error(`event '${kind}' never appeared`);
}

function spawnScript(args: {
  toolCallId: string;
  task: string;
  cwd: string;
  continueThreadId?: string;
}): SamplingDelta[][] {
  return [
    [
      { kind: 'tool_call_begin', toolCallId: args.toolCallId as never, name: 'spawn' },
      {
        kind: 'tool_call_end',
        toolCallId: args.toolCallId as never,
        args: {
          task: args.task,
          role: 'designer',
          budget: {},
          provider: 'cc',
          cwd: args.cwd,
          ...(args.continueThreadId !== undefined
            ? { continueThreadId: args.continueThreadId }
            : {}),
        },
      },
      { kind: 'end', stopReason: 'tool_use' },
    ],
    [
      { kind: 'text_delta', text: 'ack', channel: 'reply' },
      { kind: 'end', stopReason: 'end_turn' },
    ],
  ];
}

describe.skipIf(process.platform === 'win32')('smoke: M2 quota coordination', () => {
  it('cc blocked event → subtask_complete carries quota_exhausted + resetAt', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'harness-m2-real-'));
    const worktree = join(tmp, 'wt');
    mkdirSync(worktree);
    const SESSION = 'sess_blocked_a';
    const RESET_UNIX = Math.floor(Date.now() / 1000) + 3600; // 1h out
    const RESET_ISO = new Date(RESET_UNIX * 1000).toISOString();
    const launcher = setupBlockedCc(tmp, SESSION, RESET_UNIX);

    const runtime = await bootstrap({
      provider: new ScriptedProvider(
        spawnScript({ toolCallId: 'tc1', task: 'try work', cwd: worktree }),
      ),
      systemPrompt: 'sys',
      codingAgents: { cc: { binaryPath: launcher } },
    });

    const seed = await runtime.store.append({
      threadId: runtime.rootThreadId,
      kind: 'user_turn_start',
      payload: { text: 'go' },
    });
    runtime.bus.publish(seed);
    await waitForKind(runtime, 'subtask_complete');

    const events = await runtime.store.readAll(runtime.rootThreadId);
    const subtask = events.find((e) => e.kind === 'subtask_complete');
    expect(subtask).toBeDefined();
    const payload = subtask!.payload as {
      status: string;
      reason?: string;
      resetAt?: string;
      providerSessionId?: string;
    };
    expect(payload.status).toBe('errored');
    expect(payload.reason).toBe('quota_exhausted');
    expect(payload.resetAt).toBe(RESET_ISO);
    expect(payload.providerSessionId).toBe(SESSION);
  }, 30_000);

  it('subsequent spawn while window is blocked → fail-fast subtask_complete, no CLI process', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'harness-m2-fastfail-'));
    const worktree = join(tmp, 'wt');
    mkdirSync(worktree);
    const SESSION = 'sess_blocked_b';
    const RESET_UNIX = Math.floor(Date.now() / 1000) + 3600;
    const launcher = setupBlockedCc(tmp, SESSION, RESET_UNIX);

    // Two spawns back to back. First triggers the cc child (which
    // reports blocked + errors), seeding the registry. Second one
    // should never invoke the CLI — the registry already says
    // blocked.
    const runtime = await bootstrap({
      provider: new ScriptedProvider([
        // turn 1: first spawn
        [
          { kind: 'tool_call_begin', toolCallId: 'tc1' as never, name: 'spawn' },
          {
            kind: 'tool_call_end',
            toolCallId: 'tc1' as never,
            args: {
              task: 'first',
              role: 'designer',
              budget: {},
              provider: 'cc',
              cwd: worktree,
            },
          },
          { kind: 'end', stopReason: 'tool_use' },
        ],
        // turn 1 continues: second spawn after first reports
        [
          { kind: 'tool_call_begin', toolCallId: 'tc2' as never, name: 'spawn' },
          {
            kind: 'tool_call_end',
            toolCallId: 'tc2' as never,
            args: {
              task: 'second',
              role: 'designer',
              budget: {},
              provider: 'cc',
              cwd: worktree,
            },
          },
          { kind: 'end', stopReason: 'tool_use' },
        ],
        // closing reply
        [
          { kind: 'text_delta', text: 'done', channel: 'reply' },
          { kind: 'end', stopReason: 'end_turn' },
        ],
      ]),
      systemPrompt: 'sys',
      codingAgents: { cc: { binaryPath: launcher } },
    });

    const seed = await runtime.store.append({
      threadId: runtime.rootThreadId,
      kind: 'user_turn_start',
      payload: { text: 'go twice' },
    });
    runtime.bus.publish(seed);

    // Wait for two subtask_complete events on the parent.
    for (let i = 0; i < 100; i++) {
      await settle(40);
      const events = await runtime.store.readAll(runtime.rootThreadId);
      if (events.filter((e) => e.kind === 'subtask_complete').length >= 2) break;
    }
    const events = await runtime.store.readAll(runtime.rootThreadId);
    const subtasks = events.filter((e) => e.kind === 'subtask_complete');
    expect(subtasks.length).toBeGreaterThanOrEqual(2);
    for (const st of subtasks) {
      const p = st.payload as { reason?: string; resetAt?: string };
      expect(p.reason).toBe('quota_exhausted');
      expect(p.resetAt).toBeDefined();
    }
    // The second subtask_complete must point at a fresh child
    // thread (a synthesised one). Both should be distinct.
    const childIds = subtasks.map((s) => (s.payload as { childThreadId: string }).childThreadId);
    expect(new Set(childIds).size).toBe(childIds.length);
  }, 30_000);

  it('provider_ready external_event fires when resetAt elapses', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'harness-m2-ready-'));
    const worktree = join(tmp, 'wt');
    mkdirSync(worktree);
    const SESSION = 'sess_blocked_c';
    // resetAt is 250ms in the future so the timer fires within the test.
    const RESET_UNIX = Math.floor((Date.now() + 250) / 1000);
    const launcher = setupBlockedCc(tmp, SESSION, RESET_UNIX);

    const events: Array<{ source?: unknown; data?: unknown }> = [];

    const runtime = await bootstrap({
      provider: new ScriptedProvider(
        spawnScript({ toolCallId: 'tc1', task: 'go', cwd: worktree }),
      ),
      systemPrompt: 'sys',
      codingAgents: { cc: { binaryPath: launcher } },
    });

    runtime.bus.subscribe(
      (ev) => {
        if (ev.kind === 'external_event') {
          events.push(ev.payload as { source?: unknown; data?: unknown });
        }
      },
      { kinds: ['external_event'] },
    );

    const seed = await runtime.store.append({
      threadId: runtime.rootThreadId,
      kind: 'user_turn_start',
      payload: { text: 'go' },
    });
    runtime.bus.publish(seed);
    await waitForKind(runtime, 'subtask_complete');

    // Wait for the timer to fire (resetAt + slack).
    for (let i = 0; i < 80; i++) {
      await settle(50);
      if (events.some((p) => p.source === 'provider_ready')) break;
    }
    const ready = events.find((p) => p.source === 'provider_ready');
    expect(ready, 'provider_ready external_event should have fired').toBeDefined();
    const data = ready!.data as { provider?: string; resetAt?: string };
    expect(data.provider).toBe('cc');
    expect(data.resetAt).toBe(new Date(RESET_UNIX * 1000).toISOString());
  }, 30_000);

  it('continueThreadId reopen: pool reuses an existing child thread', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'harness-m2-reopen-'));
    const worktree = join(tmp, 'wt');
    mkdirSync(worktree);
    // Use the "happy" fake cc from the M1 smoke shape (always succeeds).
    const SESSION = 'sess_reopen';
    const REPLY = 'second reply';
    const script = join(tmp, 'fake-cc.cjs');
    writeFileSync(
      script,
      [
        `const fs = require('fs');`,
        `process.stdout.write(JSON.stringify({ type: 'system', subtype: 'init', session_id: ${JSON.stringify(SESSION)}, model: 'fake' }) + '\\n');`,
        `process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, duration_ms: 1, num_turns: 1, result: ${JSON.stringify(REPLY)}, session_id: ${JSON.stringify(SESSION)} }) + '\\n');`,
      ].join('\n'),
    );
    const launcher = join(tmp, 'cc-launcher.sh');
    writeFileSync(launcher, `#!/bin/sh\nexec ${process.execPath} ${script} "$@"\n`);
    chmodSync(launcher, 0o755);

    // First spawn → captures childThreadId. Second spawn with
    // continueThreadId=<that id> → must reuse, not create a new one.
    const runtime = await bootstrap({
      provider: new ScriptedProvider([
        // turn 1: spawn
        [
          { kind: 'tool_call_begin', toolCallId: 'tc1' as never, name: 'spawn' },
          {
            kind: 'tool_call_end',
            toolCallId: 'tc1' as never,
            args: { task: 'go', role: 'designer', budget: {}, provider: 'cc', cwd: worktree },
          },
          { kind: 'end', stopReason: 'tool_use' },
        ],
        // turn 1 cont: reply
        [
          { kind: 'text_delta', text: 'ack', channel: 'reply' },
          { kind: 'end', stopReason: 'end_turn' },
        ],
      ]),
      systemPrompt: 'sys',
      codingAgents: { cc: { binaryPath: launcher } },
    });

    const seed = await runtime.store.append({
      threadId: runtime.rootThreadId,
      kind: 'user_turn_start',
      payload: { text: 'go' },
    });
    runtime.bus.publish(seed);
    await waitForKind(runtime, 'subtask_complete');

    const events = await runtime.store.readAll(runtime.rootThreadId);
    const firstSubtask = events.find((e) => e.kind === 'subtask_complete');
    const firstChildId = (firstSubtask!.payload as { childThreadId: string }).childThreadId;

    // Now call subagents.spawn directly with continueThreadId — the
    // operator-driven path uses the same API.
    const turnId = (firstSubtask as { turnId?: string }).turnId ?? 'turn_synthetic';
    const reusedId = await runtime.subagents.spawn({
      parentThreadId: runtime.rootThreadId,
      parentTurnId: turnId as never,
      task: 'continue',
      role: 'designer',
      provider: 'cc',
      cwd: worktree,
      continueThreadId: firstChildId as never,
      budget: {},
    });
    expect(reusedId).toBe(firstChildId);

    for (let i = 0; i < 100; i++) {
      await settle(40);
      const childEvents = await runtime.store.readAll(firstChildId as never);
      const userTurns = childEvents.filter((e) => e.kind === 'user_turn_start');
      const replies = childEvents.filter((e) => e.kind === 'reply');
      if (userTurns.length >= 2 && replies.length >= 2) return;
    }
    const childEvents = await runtime.store.readAll(firstChildId as never);
    const userTurnCount = childEvents.filter((e) => e.kind === 'user_turn_start').length;
    expect(userTurnCount, 'reopen should append a second user_turn_start to the same thread').toBe(
      2,
    );
  }, 30_000);
});
