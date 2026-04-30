import type { ThreadId } from '@harness/core/ids.js';

/**
 * Per-runner registry of long-running tool sessions.
 *
 * A "session" is the bookkeeping for an async tool (web_fetch, shell, …).
 * The runner persists `tool_call` + `tool_result {sessionId, status:'running'}`
 * atomically at dispatch time, then runs the actual work in the background.
 * When the work finishes the runner publishes a `session_complete` event;
 * the agent reads the captured output via the `session` tool.
 *
 * The registry is in-memory and process-scoped. Sessions do not survive
 * a process restart. (Future work: persist if/when needed — `session_complete`
 * is already in the event log, so a resume could reconstruct terminal
 * state, but the captured output is currently in-memory only.)
 */

export type SessionStatus = 'running' | 'done' | 'errored';

export interface Session {
  id: string;
  threadId: ThreadId;
  toolName: string;
  status: SessionStatus;
  startedAt: string;
  endedAt?: string;
  /** Captured output (full); may be large. Truncated by the `session` tool. */
  output?: unknown;
  error?: { kind: string; message: string };
  /** Filled in on completion. */
  totalTokens?: number;
}

let nextSessionId = 1;

export function newSessionId(): string {
  return `sess_${Date.now().toString(36)}_${(nextSessionId++).toString(36)}`;
}

export class SessionRegistry {
  private sessions = new Map<string, Session>();

  create(input: { threadId: ThreadId; toolName: string; id?: string }): Session {
    const id = input.id ?? newSessionId();
    const session: Session = {
      id,
      threadId: input.threadId,
      toolName: input.toolName,
      status: 'running',
      startedAt: new Date().toISOString(),
    };
    this.sessions.set(id, session);
    return session;
  }

  get(sessionId: string): Session | undefined {
    return this.sessions.get(sessionId);
  }

  /**
   * Mark a session terminal. Returns the updated session, or undefined if
   * the id was unknown (the runner should not normally hit this — it owns
   * both the create and the complete sides — but be defensive against
   * double-completion from racy tool implementations).
   */
  complete(
    sessionId: string,
    result: { ok: true; output?: unknown } | { ok: false; error: { kind: string; message: string } },
  ): Session | undefined {
    const s = this.sessions.get(sessionId);
    if (!s) return undefined;
    if (s.status !== 'running') return s;
    s.status = result.ok ? 'done' : 'errored';
    s.endedAt = new Date().toISOString();
    if (result.ok) {
      s.output = result.output;
    } else {
      s.error = result.error;
    }
    return s;
  }

  list(): Session[] {
    return [...this.sessions.values()];
  }

  size(): number {
    return this.sessions.size;
  }
}
