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

function setupFakeCc(workdir: string, sessionId: string, replyText: string): string {
  const argvLog = join(workdir, 'last-argv.json');
  const script = join(workdir, 'fake-cc.cjs');
  writeFileSync(
    script,
    [
      `const fs = require('fs');`,
      `fs.writeFileSync(${JSON.stringify(argvLog)}, JSON.stringify(process.argv.slice(2)));`,
      `process.stdout.write(JSON.stringify({ type: 'system', subtype: 'init', session_id: ${JSON.stringify(sessionId)}, model: 'fake-claude-x' }) + '\\n');`,
      `process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, duration_ms: 5, num_turns: 3, total_cost_usd: 0.0123, usage: { input_tokens: 11, output_tokens: 22, cache_read_input_tokens: 5 }, result: ${JSON.stringify(replyText)}, session_id: ${JSON.stringify(sessionId)} }) + '\\n');`,
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
  providerSessionId?: string;
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
          ...(args.providerSessionId !== undefined
            ? { providerSessionId: args.providerSessionId }
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
