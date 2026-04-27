import type { ToolCallId } from '@harness/core/ids.js';

import type { Tool, ToolExecutionContext, ToolResult } from './tool.js';
import type { ToolRegistry } from './registry.js';

/**
 * ToolExecutor — the worker edge of the runtime.
 *
 * - Runs `safe` tools concurrently.
 * - Runs `serial` tools one-at-a-time **per thread** (cwd / env safety).
 * - Buffers results in the order they were submitted so downstream
 *   consumers see a deterministic sequence (Codex's FuturesOrdered).
 * - Every execution gets its own AbortController; the parent signal is
 *   forwarded (for ActiveTurn interrupts) but individual tools may also
 *   time out independently in the future.
 */

export interface ToolCallRequest {
  toolCallId: ToolCallId;
  name: string;
  args: unknown;
  ctx: ToolExecutionContext;
}

export interface ToolExecutionError {
  kind: 'unknown_tool' | 'schema' | 'execute' | 'aborted';
  message: string;
}

export interface BufferedResult {
  toolCallId: ToolCallId;
  result: ToolResult;
}

export class ToolExecutor {
  private perThreadSerial = new Map<string, Promise<unknown>>();

  constructor(private readonly registry: ToolRegistry) {}

  async execute(req: ToolCallRequest): Promise<ToolResult> {
    const tool = this.registry.get(req.name);
    if (!tool) {
      return {
        ok: false,
        error: { kind: 'unknown_tool', message: `no tool named ${req.name}` },
      };
    }
    const parsed = this.safeParse(tool, req.args);
    if (!parsed.ok) {
      return {
        ok: false,
        error: { kind: 'schema', message: parsed.error },
      };
    }

    const run = () => this.executeInner(tool, parsed.args, req.ctx);
    if (tool.concurrency === 'safe') return run();
    return this.runSerialForThread(req.ctx.threadId, run);
  }

  private async executeInner(
    tool: Tool,
    args: unknown,
    ctx: ToolExecutionContext,
  ): Promise<ToolResult> {
    try {
      if (ctx.signal.aborted) {
        return { ok: false, error: { kind: 'aborted', message: 'aborted before start' } };
      }
      return await tool.execute(args, ctx);
    } catch (err) {
      return {
        ok: false,
        error: {
          kind: 'execute',
          message: err instanceof Error ? err.message : String(err),
        },
      };
    }
  }

  private async runSerialForThread<T>(threadId: string, fn: () => Promise<T>): Promise<T> {
    const prior = this.perThreadSerial.get(threadId) ?? Promise.resolve();
    let release: () => void;
    const next = new Promise<void>((r) => (release = r));
    this.perThreadSerial.set(
      threadId,
      prior.then(() => next),
    );
    try {
      await prior;
      return await fn();
    } finally {
      release!();
      if (this.perThreadSerial.get(threadId) === next) {
        this.perThreadSerial.delete(threadId);
      }
    }
  }

  /**
   * Execute a batch of calls concurrently (safe) and/or serialised (per
   * tool's concurrency setting). Yields results in input order — matching
   * Codex's FuturesOrdered semantics.
   */
  async executeBatch(requests: ToolCallRequest[]): Promise<BufferedResult[]> {
    const promises = requests.map(async (req) => ({
      toolCallId: req.toolCallId,
      result: await this.execute(req),
    }));
    return Promise.all(promises);
  }

  private safeParse(
    tool: Tool,
    args: unknown,
  ): { ok: true; args: unknown } | { ok: false; error: string } {
    const reparsed = maybeRecoverRawJson(args);
    if (!reparsed.ok) {
      return { ok: false, error: reparsed.error };
    }
    try {
      const parsed = tool.schema.parse(reparsed.args);
      return { ok: true, args: parsed };
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }
}

function maybeRecoverRawJson(
  args: unknown,
): { ok: true; args: unknown } | { ok: false; error: string } {
  if (
    !args ||
    typeof args !== 'object' ||
    !('_raw' in args) ||
    typeof (args as { _raw?: unknown })._raw !== 'string'
  ) {
    return { ok: true, args };
  }
  const raw = (args as { _raw: string })._raw;
  try {
    return { ok: true, args: JSON.parse(raw) };
  } catch (err) {
    const preview = raw.length > 200 ? raw.slice(0, 200) + '...' : raw;
    return {
      ok: false,
      error:
        'tool arguments were not valid JSON when received by the runtime; ' +
        'this usually means the model was cut off mid-tool-call (for example by max_tokens). ' +
        `raw=${preview} parse_error=${err instanceof Error ? err.message : String(err)}`,
    };
  }
}
