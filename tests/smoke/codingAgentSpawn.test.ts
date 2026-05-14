import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
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
 * Smoke: parent (scripted provider) spawns a `cc` child against a
 * fake `claude` binary that emits the stream-json shape the
 * `CodingAgentProvider` parses. Verifies the M1 contract:
 *
 *   - the cc factory is reachable via `provider:'cc'`
 *   - the binary is invoked with `-p <task> --output-format stream-json --verbose`
 *   - `system/init.session_id` round-trips into
 *     `subtask_complete.providerSessionId` on the parent
 *   - `result.result` becomes the child's reply (the parent's
 *     `subtask_complete.summary`)
 *   - on a follow-up spawn carrying `providerSessionId`, the binary
 *     receives `--resume <id>`
 *
 * The "binary" is a Node script that records its argv and prints
 * two NDJSON events (system init + result) to stdout. A tiny shell
 * launcher invokes it so we can pass the launcher path as the cc
 * binary path.
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

// Unix seconds for 2026-05-09T18:30:00Z (the "session resets at 6:30pm UTC"
// vibe from cc's /usage screen). Used by the fake binary's rate_limit_event.
const FIVE_HOUR_RESET_UNIX = Math.floor(Date.UTC(2026, 4, 9, 18, 30, 0) / 1000);
const SEVEN_DAY_RESET_UNIX = Math.floor(Date.UTC(2026, 4, 16, 14, 0, 0) / 1000);

function setupFakeCc(workdir: string, sessionId: string, replyText: string): string {
  const argvLog = join(workdir, 'last-argv.json');
  const script = join(workdir, 'fake-cc.cjs');
  writeFileSync(
    script,
    [
      `const fs = require('fs');`,
      `fs.writeFileSync(${JSON.stringify(argvLog)}, JSON.stringify(process.argv.slice(2)));`,
      `process.stdout.write(JSON.stringify({ type: 'system', subtype: 'init', session_id: ${JSON.stringify(sessionId)}, model: 'fake-claude-x' }) + '\\n');`,
      `process.stdout.write(JSON.stringify({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed', resetsAt: ${FIVE_HOUR_RESET_UNIX}, rateLimitType: 'five_hour', utilization: 0.61, surpassedThreshold: 0.5, isUsingOverage: false } }) + '\\n');`,
      `process.stdout.write(JSON.stringify({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed_warning', resetsAt: ${SEVEN_DAY_RESET_UNIX}, rateLimitType: 'seven_day', utilization: 0.89, surpassedThreshold: 0.75, isUsingOverage: false } }) + '\\n');`,
      `process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, duration_ms: 5, num_turns: 3, total_cost_usd: 0.0123, usage: { input_tokens: 11, output_tokens: 22, cache_read_input_tokens: 5 }, result: ${JSON.stringify(replyText)}, session_id: ${JSON.stringify(sessionId)} }) + '\\n');`,
    ].join('\n'),
  );
  const launcher = join(workdir, 'cc-launcher.sh');
  writeFileSync(launcher, `#!/bin/sh\nexec ${process.execPath} ${script} "$@"\n`);
  chmodSync(launcher, 0o755);
  return launcher;
}

/**
 * Fake codex binary that emits the empirically-observed `exec --json`
 * event sequence: thread.started → turn.started → optional internal
 * items (file_change, reasoning) → final agent_message → turn.completed.
 * Exercises the codex branch added in CodingAgentProvider's pump.
 */
function setupFakeCodex(workdir: string, threadId: string, replyText: string): string {
  const argvLog = join(workdir, 'last-argv.json');
  const script = join(workdir, 'fake-codex.cjs');
  writeFileSync(
    script,
    [
      `const fs = require('fs');`,
      `fs.writeFileSync(${JSON.stringify(argvLog)}, JSON.stringify(process.argv.slice(2)));`,
      `process.stdout.write(JSON.stringify({ type: 'thread.started', thread_id: ${JSON.stringify(threadId)} }) + '\\n');`,
      `process.stdout.write(JSON.stringify({ type: 'turn.started' }) + '\\n');`,
      // Intermediate agent_message — should be superseded by the later one.
      `process.stdout.write(JSON.stringify({ type: 'item.completed', item: { id: 'item_0', type: 'agent_message', text: 'I will do the task.' } }) + '\\n');`,
      // Internal file_change item — must be traced, but not surfaced as reply.
      `process.stdout.write(JSON.stringify({ type: 'item.started', item: { id: 'item_1', type: 'file_change', status: 'in_progress' } }) + '\\n');`,
      `process.stdout.write(JSON.stringify({ type: 'item.completed', item: { id: 'item_1', type: 'file_change', status: 'completed' } }) + '\\n');`,
      // Final agent_message — the one we expect as the reply.
      `process.stdout.write(JSON.stringify({ type: 'item.completed', item: { id: 'item_2', type: 'agent_message', text: ${JSON.stringify(replyText)} } }) + '\\n');`,
      `process.stdout.write(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 42, cached_input_tokens: 17, output_tokens: 8, reasoning_output_tokens: 0 } }) + '\\n');`,
    ].join('\n'),
  );
  const launcher = join(workdir, 'codex-launcher.sh');
  writeFileSync(launcher, `#!/bin/sh\nexec ${process.execPath} ${script} "$@"\n`);
  chmodSync(launcher, 0o755);
  return launcher;
}

async function settle(ms: number): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

async function waitForSubtask(runtime: Awaited<ReturnType<typeof bootstrap>>): Promise<void> {
  for (let i = 0; i < 100; i++) {
    await settle(40);
    const events = await runtime.store.readAll(runtime.rootThreadId);
    if (events.some((e) => e.kind === 'subtask_complete')) return;
  }
  throw new Error('subtask_complete never fired');
}

function spawnScript(args: {
  toolCallId: string;
  task: string;
  cwd: string;
  provider?: 'cc' | 'codex';
  providerSessionId?: string;
  permissionMode?: 'default' | 'bypass';
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
          provider: args.provider ?? 'cc',
          cwd: args.cwd,
          ...(args.providerSessionId !== undefined
            ? { providerSessionId: args.providerSessionId }
            : {}),
          ...(args.permissionMode !== undefined
            ? { permissionMode: args.permissionMode }
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

describe.skipIf(process.platform === 'win32')('smoke: spawn(provider:"cc")', () => {
  it('round-trips session_id and reply through the cc factory', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'harness-cc-'));
    const worktree = join(tmp, 'wt');
    mkdirSync(worktree);
    const SESSION = 'sess_fake_abc';
    const REPLY = 'design draft: do X then Y';
    const launcher = setupFakeCc(tmp, SESSION, REPLY);

    const TASK = 'Outline a 2-line design for fizzbuzz.';
    const runtime = await bootstrap({
      provider: new ScriptedProvider(
        spawnScript({ toolCallId: 'tc1', task: TASK, cwd: worktree }),
      ),
      systemPrompt: 'sys',
      codingAgents: { cc: { binaryPath: launcher } },
    });

    const seed = await runtime.store.append({
      threadId: runtime.rootThreadId,
      kind: 'user_turn_start',
      payload: { text: 'please design fizzbuzz' },
    });
    runtime.bus.publish(seed);
    await waitForSubtask(runtime);

    const events = await runtime.store.readAll(runtime.rootThreadId);
    const subtask = events.find((e) => e.kind === 'subtask_complete');
    expect(subtask).toBeDefined();
    const payload = subtask!.payload as {
      status: string;
      summary?: string;
      providerSessionId?: string;
    };
    expect(payload.status).toBe('completed');
    expect(payload.summary).toBe(REPLY);
    expect(payload.providerSessionId).toBe(SESSION);

    const argv = JSON.parse(readFileSync(join(tmp, 'last-argv.json'), 'utf8')) as string[];
    expect(argv.slice(0, 2)).toEqual(['-p', TASK]);
    expect(argv).toContain('--output-format');
    expect(argv).toContain('stream-json');
    expect(argv).toContain('--verbose');
    expect(argv).not.toContain('--resume');
    // permissionMode unset → cc default permission system stays intact.
    expect(argv).not.toContain('--permission-mode');
    expect(argv).not.toContain('--add-dir');

    // Registry populated for the parent's `usage` tool to read.
    const snap = runtime.providerUsageRegistry.get('cc');
    expect(snap).toBeDefined();
    expect(snap!.lastSessionId).toBe(SESSION);
    expect(snap!.lastModel).toBe('fake-claude-x');
    expect(snap!.lastTurns).toBe(3);
    expect(snap!.lastCostUsd).toBeCloseTo(0.0123, 5);
    expect(snap!.lastTokens).toEqual({
      inputTokens: 11,
      outputTokens: 22,
      cacheReadInputTokens: 5,
    });
    // Account-level windowed quota: cc's `rate_limit_event` for the
    // 5-hour rolling session and the 7-day rolling week.
    expect(snap!.fiveHour).toEqual({
      utilization: 0.61,
      resetsAt: new Date(FIVE_HOUR_RESET_UNIX * 1000).toISOString(),
      status: 'allowed',
      surpassedThreshold: 0.5,
      isUsingOverage: false,
    });
    expect(snap!.sevenDay).toEqual({
      utilization: 0.89,
      resetsAt: new Date(SEVEN_DAY_RESET_UNIX * 1000).toISOString(),
      status: 'allowed_warning',
      surpassedThreshold: 0.75,
      isUsingOverage: false,
    });

    // Second spawn carrying providerSessionId → expect --resume <id>.
    const runtime2 = await bootstrap({
      provider: new ScriptedProvider(
        spawnScript({
          toolCallId: 'tc2',
          task: 'Now add the implementation outline.',
          cwd: worktree,
          providerSessionId: SESSION,
        }),
      ),
      systemPrompt: 'sys',
      codingAgents: { cc: { binaryPath: launcher } },
    });
    const seed2 = await runtime2.store.append({
      threadId: runtime2.rootThreadId,
      kind: 'user_turn_start',
      payload: { text: 'please continue' },
    });
    runtime2.bus.publish(seed2);
    await waitForSubtask(runtime2);

    const argv2 = JSON.parse(readFileSync(join(tmp, 'last-argv.json'), 'utf8')) as string[];
    const resumeIdx = argv2.indexOf('--resume');
    expect(resumeIdx).toBeGreaterThanOrEqual(0);
    expect(argv2[resumeIdx + 1]).toBe(SESSION);
  }, 30_000);

  it('translates permissionMode:"bypass" to --permission-mode bypassPermissions + --add-dir', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'harness-cc-'));
    const worktree = join(tmp, 'wt');
    mkdirSync(worktree);
    const launcher = setupFakeCc(tmp, 'sess_perm', 'ok');

    const runtime = await bootstrap({
      provider: new ScriptedProvider(
        spawnScript({
          toolCallId: 'tc_perm',
          task: 'do edits',
          cwd: worktree,
          permissionMode: 'bypass',
        }),
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
    await waitForSubtask(runtime);

    const argv = JSON.parse(readFileSync(join(tmp, 'last-argv.json'), 'utf8')) as string[];
    const permIdx = argv.indexOf('--permission-mode');
    expect(permIdx).toBeGreaterThanOrEqual(0);
    expect(argv[permIdx + 1]).toBe('bypassPermissions');
    const addDirIdx = argv.indexOf('--add-dir');
    expect(addDirIdx).toBeGreaterThanOrEqual(0);
    expect(argv[addDirIdx + 1]).toBe(worktree);

    // spawn_request event records the requested mode for audit.
    const events = await runtime.store.readAll(runtime.rootThreadId);
    const spawnReq = events.find((e) => e.kind === 'spawn_request');
    if (!spawnReq) throw new Error('spawn_request event missing');
    expect(
      (spawnReq.payload as { permissionMode?: string }).permissionMode,
    ).toBe('bypass');
  }, 30_000);

  it('translates permissionMode:"bypass" for provider:"codex"', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'harness-codex-'));
    const worktree = join(tmp, 'wt');
    mkdirSync(worktree);
    const launcher = setupFakeCc(tmp, 'sess_codex_perm', 'ok');

    const runtime = await bootstrap({
      provider: new ScriptedProvider(
        spawnScript({
          toolCallId: 'tc_codex_perm',
          task: 'do edits',
          cwd: worktree,
          provider: 'codex',
          permissionMode: 'bypass',
        }),
      ),
      systemPrompt: 'sys',
      codingAgents: { codex: { binaryPath: launcher } },
    });
    const seed = await runtime.store.append({
      threadId: runtime.rootThreadId,
      kind: 'user_turn_start',
      payload: { text: 'go' },
    });
    runtime.bus.publish(seed);
    await waitForSubtask(runtime);

    const argv = JSON.parse(readFileSync(join(tmp, 'last-argv.json'), 'utf8')) as string[];
    expect(argv.slice(0, 2)).toEqual(['exec', '--json']);
    expect(argv).toContain('--dangerously-bypass-approvals-and-sandbox');
    expect(argv).not.toContain('--permission-mode');
    expect(argv).not.toContain('bypassPermissions');

    const events = await runtime.store.readAll(runtime.rootThreadId);
    const spawnReq = events.find((e) => e.kind === 'spawn_request');
    if (!spawnReq) throw new Error('spawn_request event missing');
    expect(
      (spawnReq.payload as { provider?: string; permissionMode?: string }).provider,
    ).toBe('codex');
    expect(
      (spawnReq.payload as { permissionMode?: string }).permissionMode,
    ).toBe('bypass');
  }, 30_000);

  it('round-trips codex thread_id + final agent_message through the codex factory', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'harness-codex-'));
    const worktree = join(tmp, 'wt');
    mkdirSync(worktree);
    const THREAD = '019e2426-b4e1-7862-b72c-067ca5a3e4c8';
    const REPLY = 'Done. Created src/foo.ts.';
    const launcher = setupFakeCodex(tmp, THREAD, REPLY);

    const runtime = await bootstrap({
      provider: new ScriptedProvider(
        spawnScript({
          toolCallId: 'tc_codex_evt',
          task: 'do x',
          cwd: worktree,
          provider: 'codex',
        }),
      ),
      systemPrompt: 'sys',
      codingAgents: { codex: { binaryPath: launcher } },
    });
    const seed = await runtime.store.append({
      threadId: runtime.rootThreadId,
      kind: 'user_turn_start',
      payload: { text: 'go' },
    });
    runtime.bus.publish(seed);
    await waitForSubtask(runtime);

    const events = await runtime.store.readAll(runtime.rootThreadId);
    const subtask = events.find((e) => e.kind === 'subtask_complete');
    if (!subtask) throw new Error('subtask_complete event missing');
    const payload = subtask.payload as {
      status: string;
      summary?: string;
      providerSessionId?: string;
    };
    expect(payload.status).toBe('completed');
    // Final agent_message wins — the intermediate "I will do the task." is dropped.
    expect(payload.summary).toBe(REPLY);
    expect(payload.providerSessionId).toBe(THREAD);

    // Usage from turn.completed.usage flows into the registry.
    const snap = runtime.providerUsageRegistry.get('codex');
    if (!snap) throw new Error('codex usage snapshot missing');
    expect(snap.lastSessionId).toBe(THREAD);
    expect(snap.lastTokens).toEqual({
      inputTokens: 42,
      outputTokens: 8,
      cacheReadInputTokens: 17,
    });

    const argv = JSON.parse(readFileSync(join(tmp, 'last-argv.json'), 'utf8')) as string[];
    expect(argv.slice(0, 2)).toEqual(['exec', '--json']);
    expect(argv[2]).toContain('sys');
    expect(argv[2]).toContain('do x');

    const spawnReq = events.find((e) => e.kind === 'spawn_request');
    if (!spawnReq) throw new Error('spawn_request event missing');
    const childThreadId = (spawnReq.payload as { childThreadId: string }).childThreadId;
    const childEvents = await runtime.store.readAll(childThreadId as never);
    const reasoning = childEvents.find((e) => e.kind === 'reasoning');
    if (!reasoning) throw new Error('codex reasoning event missing');
    expect((reasoning.payload as { text?: string }).text).toContain(
      '[codex item.completed file_change completed]',
    );
  }, 30_000);

  it('rejects spawn(provider:"cc") with no cwd via SpawnRefused', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'harness-cc-'));
    const launcher = setupFakeCc(tmp, 'sess_x', 'unused');

    const runtime = await bootstrap({
      provider: new ScriptedProvider([
        [
          { kind: 'tool_call_begin', toolCallId: 'tc_bad' as never, name: 'spawn' },
          {
            kind: 'tool_call_end',
            toolCallId: 'tc_bad' as never,
            args: { task: 'do x', budget: {}, provider: 'cc' /* cwd missing */ },
          },
          { kind: 'end', stopReason: 'tool_use' },
        ],
        [{ kind: 'text_delta', text: 'ack', channel: 'reply' }, { kind: 'end', stopReason: 'end_turn' }],
      ]),
      systemPrompt: 'sys',
      codingAgents: { cc: { binaryPath: launcher } },
    });

    const seed = await runtime.store.append({
      threadId: runtime.rootThreadId,
      kind: 'user_turn_start',
      payload: { text: 'please go' },
    });
    runtime.bus.publish(seed);

    for (let i = 0; i < 50; i++) {
      await settle(40);
      const events = await runtime.store.readAll(runtime.rootThreadId);
      const tr = events.find(
        (e) =>
          e.kind === 'tool_result' &&
          (e.payload as { ok?: boolean }).ok === false,
      );
      if (tr) {
        const err = (tr.payload as { error?: { kind?: string } }).error;
        expect(err?.kind).toBe('provider_factory_failed');
        return;
      }
    }
    throw new Error('expected tool_result.ok=false from provider_factory_failed');
  }, 15_000);
});
