import type { ThreadId } from '@harness/core/ids.js';
import type { Thread } from '@harness/core/thread.js';
import type { SessionStore } from '@harness/store/sessionStore.js';

/**
 * Shared parsing + formatting for the /status, /new, /resume slash
 * commands implemented by the terminal and discord adapters. Keeping
 * the surface in one place ensures both adapters stay in sync on what
 * the commands do (and how thread refs are resolved).
 */

export type SessionCommand =
  | { kind: 'status' }
  | { kind: 'new' }
  | { kind: 'resume'; arg: string | undefined };

/**
 * Recognise a leading slash command if `text` is exactly /status, /new,
 * or /resume (with optional argument for the latter). Anything else
 * returns undefined and the adapter forwards the line as user input.
 */
export function parseSessionCommand(text: string): SessionCommand | undefined {
  const trimmed = text.trim();
  if (trimmed === '/status') return { kind: 'status' };
  if (trimmed === '/new') return { kind: 'new' };
  if (trimmed === '/resume') return { kind: 'resume', arg: undefined };
  if (trimmed.startsWith('/resume ')) {
    const arg = trimmed.slice('/resume '.length).trim();
    return { kind: 'resume', arg: arg.length > 0 ? arg : undefined };
  }
  return undefined;
}

export interface ListedThread {
  threadId: ThreadId;
  title: string | undefined;
  updatedAt: string;
  /**
   * Short snippet of the first user_turn_start text in the thread, so
   * /status and /resume listings hint at what the conversation was
   * about. Optional — populated by `attachPreviews()` on demand;
   * undefined when the helper was skipped.
   */
  preview?: string;
}

/** Truncated preview length surfaced in listings. Discord autocomplete
 * choice names cap at 100 chars and we leave room for index + age. */
export const PREVIEW_MAX_LEN = 80;

/**
 * Read the first `user_turn_start` event of each thread and stash a
 * truncated preview onto the listing. Failure to read a thread (e.g.
 * concurrent compaction) silently leaves the preview undefined — the
 * caller still has id/title/updatedAt to render.
 */
export async function attachPreviews(
  store: SessionStore,
  listed: readonly ListedThread[],
  maxLen: number = PREVIEW_MAX_LEN,
): Promise<ListedThread[]> {
  const out: ListedThread[] = [];
  for (const t of listed) {
    let preview: string | undefined;
    try {
      const events = await store.readAll(t.threadId);
      for (const ev of events) {
        if (ev.kind === 'user_turn_start') {
          const text = (ev.payload as { text?: unknown }).text;
          if (typeof text === 'string' && text.length > 0) {
            preview = truncate(text.replace(/\s+/g, ' ').trim(), maxLen);
            break;
          }
        }
      }
    } catch {
      // Best-effort: skip preview on read error.
    }
    out.push({ ...t, ...(preview !== undefined ? { preview } : {}) });
  }
  return out;
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1)}…`;
}

/**
 * Sort threads most-recently-updated first and cap at `limit`. Threads
 * marked archived (status='archived') are dropped — /status / /resume
 * should not surface archived threads from per-channel /new.
 */
export function recentThreads(threads: readonly Thread[], limit: number): ListedThread[] {
  return [...threads]
    .filter((t) => t.status !== 'archived')
    .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0))
    .slice(0, limit)
    .map((t) => ({ threadId: t.id, title: t.title, updatedAt: t.updatedAt }));
}

export interface ResolveResult {
  ok: true;
  threadId: ThreadId;
}
export interface ResolveError {
  ok: false;
  reason: 'missing-arg' | 'not-found' | 'ambiguous';
  message: string;
}

/**
 * Resolve a /resume argument to a concrete ThreadId. Accepts either:
 *   - a 1-based index into the `listed` array (matches /status output)
 *   - a thread-id prefix (case-sensitive, must uniquely match)
 *
 * `listed` must be the same list the user just saw via /status, so the
 * indices line up.
 */
export function resolveThreadRef(
  listed: readonly ListedThread[],
  arg: string | undefined,
): ResolveResult | ResolveError {
  if (!arg) {
    return {
      ok: false,
      reason: 'missing-arg',
      message: 'usage: /resume <index> or /resume <thread-id-prefix>',
    };
  }
  const asInt = Number.parseInt(arg, 10);
  if (Number.isInteger(asInt) && String(asInt) === arg.trim()) {
    if (asInt < 1 || asInt > listed.length) {
      return {
        ok: false,
        reason: 'not-found',
        message: `index ${asInt} out of range (have ${listed.length})`,
      };
    }
    return { ok: true, threadId: listed[asInt - 1]!.threadId };
  }
  const matches = listed.filter((t) => t.threadId.startsWith(arg));
  if (matches.length === 0) {
    return { ok: false, reason: 'not-found', message: `no thread matches "${arg}"` };
  }
  if (matches.length > 1) {
    return {
      ok: false,
      reason: 'ambiguous',
      message: `prefix "${arg}" is ambiguous (${matches.length} matches)`,
    };
  }
  return { ok: true, threadId: matches[0]!.threadId };
}

export interface FormatStatusInput {
  currentThreadId: ThreadId;
  currentTitle: string | undefined;
  turnActive: boolean;
  recent: readonly ListedThread[];
  /** "now" used to render relative timestamps. Defaults to Date.now(). */
  now?: number;
}

/**
 * Plain-text status block, suitable for the terminal adapter. Discord
 * formats its own variant since it wants markdown subtext.
 */
export function formatStatus(input: FormatStatusInput): string {
  const lines: string[] = [];
  const titleSuffix = input.currentTitle ? ` "${input.currentTitle}"` : '';
  const turnLabel = input.turnActive ? 'turn: running' : 'turn: idle';
  lines.push(`current: ${shortId(input.currentThreadId)}${titleSuffix} — ${turnLabel}`);
  lines.push(`         (${input.currentThreadId})`);
  if (input.recent.length === 0) {
    lines.push('recent: (none)');
  } else {
    lines.push('recent:');
    const now = input.now ?? Date.now();
    input.recent.forEach((t, i) => {
      const idx = String(i + 1).padStart(2, ' ');
      const marker = t.threadId === input.currentThreadId ? ' (current)' : '';
      const title = t.title ? ` "${t.title}"` : '';
      const age = formatAge(now - Date.parse(t.updatedAt));
      lines.push(`  ${idx}. ${shortId(t.threadId)}${marker}${title} — ${age}`);
      if (t.preview) lines.push(`       › ${t.preview}`);
    });
  }
  return lines.join('\n');
}

export function shortId(id: string): string {
  // thr_<12chars>; show enough to be unique-ish in lists but compact.
  return id.length > 12 ? id.slice(0, 12) : id;
}

function formatAge(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return 'just now';
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  return `${day}d ago`;
}
