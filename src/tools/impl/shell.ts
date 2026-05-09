import { spawn } from 'node:child_process';
import { z } from 'zod';

import type { Tool } from '../tool.js';

/**
 * Real shell tool.
 *
 * Spawns a `/bin/sh -lc <cmd>` (or `cmd.exe /s /c` on Windows), captures
 * stdout + stderr with a byte cap, kills the process on timeout, and
 * cooperates with `ctx.signal` so interrupts / budget breaches cancel
 * in-flight work.
 *
 * Output is registered as a handle when oversized so the LLM sees a
 * compact summary + tail and can `restore(handle)` to pull the full log.
 *
 * Phase 4 wraps this execution in the sandbox (Landlock / Seatbelt /
 * Windows restricted token) — the spawn call will move behind an
 * Executor interface at that point.
 */

const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_OUTPUT_BYTES = 64 * 1024;
const TAIL_INLINE_BYTES = 2048;

const ShellArgs = z.object({
  cmd: z
    .string()
    .describe('Command line. Interpreted by /bin/sh -lc (POSIX) or cmd.exe (Windows).'),
  cwd: z.string().optional().describe('Working directory; defaults to the runtime process cwd.'),
  timeoutMs: z.number().optional().describe('Hard timeout in ms (default 60000).'),
  maxOutputBytes: z
    .number()
    .optional()
    .describe('Cap captured bytes per output stream, stdout and stderr (default 65536 each).'),
});

interface ShellOutput {
  exitCode: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
  truncated: boolean;
  originalBytes: number;
  wallMs: number;
  timedOut: boolean;
}

export const shellTool: Tool<typeof ShellArgs, ShellOutput> = {
  name: 'shell',
  concurrency: 'serial',
  async: true,
  description: [
    'Start a shell command as a long-running session. Immediate tool result is `{sessionId,status:"running",toolName:"shell"}`; after `session_complete`, call `session({sessionId})` to read exit code + stdout/stderr.',
    'Args: `cmd`, optional `cwd`, `timeoutMs`, `maxOutputBytes`. Output is captured with byte caps; oversized results are elided and saved to a handle (use `restore` to pull the full log if needed).',
    'Use for side-effectful operations (build, test, git, git grep, curl when web_fetch will not do).',
    'Prefer `read` / `write` when you only need file I/O — those emit structured, diffable results.',
  ].join(' '),
  schema: ShellArgs,
  async execute(args, ctx) {
    const timeoutMs = args.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const maxOutputBytes = args.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
    const isWindows = process.platform === 'win32';
    const shell = isWindows ? 'cmd.exe' : '/bin/sh';
    const shellArgs = isWindows ? ['/s', '/c', args.cmd] : ['-c', args.cmd];

    const child = spawn(shell, shellArgs, {
      ...(args.cwd !== undefined ? { cwd: args.cwd } : {}),
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      // Put the child in its own process group on POSIX so we can signal
      // it + all its descendants (otherwise `sh -c 'sleep 5'` outlives a
      // SIGTERM sent only to the shell's pid).
      detached: !isWindows,
    });

    const killGroup = (sig: NodeJS.Signals) => {
      if (child.pid === undefined) return;
      try {
        if (isWindows) {
          child.kill(sig);
        } else {
          process.kill(-child.pid, sig);
        }
      } catch {
        /* no-op */
      }
    };

    const started = Date.now();
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let originalBytes = 0;
    const stdoutBufs: Buffer[] = [];
    const stderrBufs: Buffer[] = [];
    let truncated = false;

    const capture = (bufs: Buffer[], countRef: { n: number }) => (chunk: Buffer) => {
      originalBytes += chunk.byteLength;
      if (countRef.n >= maxOutputBytes) {
        truncated = true;
        return;
      }
      const allowed = Math.max(0, maxOutputBytes - countRef.n);
      if (chunk.byteLength > allowed) {
        bufs.push(chunk.subarray(0, allowed));
        countRef.n += allowed;
        truncated = true;
      } else {
        bufs.push(chunk);
        countRef.n += chunk.byteLength;
      }
    };
    const stdoutRef = { n: stdoutBytes };
    const stderrRef = { n: stderrBytes };
    child.stdout.on('data', capture(stdoutBufs, stdoutRef));
    child.stderr.on('data', capture(stderrBufs, stderrRef));

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      killGroup('SIGTERM');
      setTimeout(() => killGroup('SIGKILL'), 2_000).unref();
    }, timeoutMs);
    timer.unref();

    const onAbort = () => killGroup('SIGTERM');
    if (ctx.signal.aborted) onAbort();
    ctx.signal.addEventListener('abort', onAbort, { once: true });

    const { code, signalName } = await new Promise<{
      code: number | null;
      signalName: NodeJS.Signals | null;
    }>((resolve) => {
      child.on('close', (c, s) => resolve({ code: c, signalName: s }));
      child.on('error', () => resolve({ code: null, signalName: null }));
    });
    clearTimeout(timer);
    ctx.signal.removeEventListener('abort', onAbort);

    stdoutBytes = stdoutRef.n;
    stderrBytes = stderrRef.n;
    const stdout = Buffer.concat(stdoutBufs).toString('utf8');
    const stderr = Buffer.concat(stderrBufs).toString('utf8');
    const wallMs = Date.now() - started;

    const output: ShellOutput = {
      exitCode: code,
      signal: signalName,
      stdout,
      stderr,
      truncated,
      originalBytes,
      wallMs,
      timedOut,
    };

    // Register full body as a handle when the output was truncated or
    // large so the LLM sees a compact form in its context and can
    // restore() the full log if needed.
    const total = stdoutBytes + stderrBytes;
    if (truncated || total > TAIL_INLINE_BYTES) {
      const handle = ctx.registerHandle(
        'shell_output',
        { cmd: args.cmd, stdout, stderr, exitCode: code, timedOut },
        { cmd: args.cmd, exitCode: code, bytes: total, wallMs },
      );
      return {
        ok: code === 0 && !timedOut,
        output,
        elided: {
          handle,
          kind: 'shell_output',
          meta: {
            cmd: args.cmd,
            exitCode: code ?? 'null',
            bytes: total,
            timedOut,
            wallMs,
            tail: tail(stdout + stderr, 512),
          },
        },
        originalBytes,
        bytesSent: total,
      };
    }

    return {
      ok: code === 0 && !timedOut,
      output,
      originalBytes,
      bytesSent: total,
    };
  },
};

function tail(s: string, n: number): string {
  if (s.length <= n) return s;
  return '…' + s.slice(-n);
}
