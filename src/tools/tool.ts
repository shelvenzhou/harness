import type { ZodTypeAny, z } from 'zod';

import type { ElidedMeta } from '@harness/core/events.js';
import type { EventId, HandleRef, ThreadId, ToolCallId, TurnId } from '@harness/core/ids.js';
import type { MemoryStore } from '@harness/memory/types.js';

/**
 * Tool interface. See design-docs/03-tools.md.
 *
 * Tools are the harness's primary extension point. The runtime itself
 * should not grow new capabilities; new capabilities should land as tools
 * (or as compositions of existing tools via `spawn`).
 */

export interface ToolExecutionContext {
  threadId: ThreadId;
  turnId: TurnId;
  toolCallId: ToolCallId;
  /** Abortable; the runtime cancels this on interrupt or budget breach. */
  signal: AbortSignal;
  /** Emit a log/progress line (not a reply to the user). Purely diagnostic. */
  log(line: string): void;
  /** Register a large payload as elidable, returning a handle. */
  registerHandle(kind: string, payload: unknown, meta?: Record<string, unknown>): HandleRef;
  /** Escape hatch for tools that need to inspect or append raw events. */
  services: ToolServices;
}

export interface ToolServices {
  /** Stored event id of the current tool_call event; useful for backrefs. */
  toolCallEventId?: EventId;
  /** Persistent memory store (KV + ingestion + search). */
  memory?: MemoryStore;
}

export interface ToolResult<Output = unknown> {
  ok: boolean;
  output?: Output;
  error?: { kind: string; message: string; retryable?: boolean };
  /** If set, the persisted tool_result event gets this elided metadata. */
  elided?: ElidedMeta;
  originalBytes?: number;
  bytesSent?: number;
}

export interface Tool<S extends ZodTypeAny = ZodTypeAny, Output = unknown> {
  readonly name: string;
  /**
   * LLM-facing description. **Include decision hints** (when to use, when
   * not to use) per the design doc — the model reads this to decide.
   */
  readonly description: string;
  readonly schema: S;
  /**
   * 'safe' tools can run in parallel with other safe tools of the same kind.
   * 'serial' tools (e.g. shell that mutates cwd) queue per thread.
   */
  readonly concurrency: 'safe' | 'serial';
  /**
   * When true, the runner dispatches the tool as a *session*: persists
   * `tool_call` and a paired `tool_result {sessionId, status:'running'}`
   * atomically inside dispatch, then runs `execute` in the background.
   * The agent reads the captured output via the `session` tool once a
   * `session_complete` event lands (waitable via `wait({matcher:'session'})`).
   *
   * Design note: this flag exists to keep the persisted message history
   * always well-formed. Without atomic pairing, an in-flight async tool
   * leaves a `tool_call` on disk with no matching `tool_result` — a new
   * `user_turn_start` arriving in that window forms an OpenAI-illegal
   * projection ("tool_calls without responses").
   */
  readonly async?: boolean;
  execute(args: z.infer<S>, ctx: ToolExecutionContext): Promise<ToolResult<Output>>;
}

// ─── tool spec for provider tool list ──────────────────────────────────────

import { zodToJsonSchema } from './zodToJsonSchema.js';
import type { ToolSpec } from '@harness/llm/provider.js';

export function toToolSpec(tool: Tool): ToolSpec {
  const raw = zodToJsonSchema(tool.schema) as Record<string, unknown>;
  // OpenAI function-calling (and most tool-use APIs) require the top-level
  // parameters schema to be an object. If a tool's root schema produced
  // something else (e.g. a union), wrap it.
  const argsSchema =
    raw && typeof raw === 'object' && raw['type'] === 'object'
      ? raw
      : { type: 'object', properties: {}, additionalProperties: true };
  return {
    name: tool.name,
    description: tool.description,
    argsSchema,
  };
}
