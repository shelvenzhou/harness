import type { HarnessEvent } from '@harness/core/events.js';
import type {
  ProjectedContent,
  ProjectedItem,
} from '@harness/llm/provider.js';

import type { HandleRegistry } from './handleRegistry.js';

/**
 * Deterministic projection rules (Level 1 pruning).
 *
 * Converts an event sequence into the `ProjectedItem[]` that a provider
 * will consume. Rules per kind are in design-docs/04-context.md.
 */

export interface PruningOptions {
  /** Keep last N reasoning blocks verbatim; drop older. */
  keepLastReasoning?: number;
  /** Max bytes preserved inline for tool_result output (else elide). */
  inlineToolResultLimit?: number;
  handles?: HandleRegistry;
}

const DEFAULTS: Required<Omit<PruningOptions, 'handles'>> = {
  keepLastReasoning: 2,
  inlineToolResultLimit: 1024,
};

export function projectEvents(
  events: readonly HarnessEvent[],
  opts: PruningOptions = {},
): ProjectedItem[] {
  const { keepLastReasoning, inlineToolResultLimit } = { ...DEFAULTS, ...opts };
  const handles = opts.handles;
  const reasoningIndices: number[] = [];
  for (let i = 0; i < events.length; i++) {
    if (events[i]!.kind === 'reasoning') reasoningIndices.push(i);
  }
  const reasoningKeepAfter = Math.max(0, reasoningIndices.length - keepLastReasoning);
  const reasoningToKeep = new Set(reasoningIndices.slice(reasoningKeepAfter));

  const items: ProjectedItem[] = [];
  for (let i = 0; i < events.length; i++) {
    const ev = events[i]!;
    const projected = projectEvent(ev, i, {
      keepReasoning: reasoningToKeep.has(i),
      inlineToolResultLimit,
      ...(handles !== undefined ? { handles } : {}),
    });
    if (projected) items.push(projected);
  }
  return items;
}

interface ProjectOneOpts {
  keepReasoning: boolean;
  inlineToolResultLimit: number;
  handles?: HandleRegistry;
}

function projectEvent(
  ev: HarnessEvent,
  _idx: number,
  opts: ProjectOneOpts,
): ProjectedItem | null {
  switch (ev.kind) {
    case 'user_turn_start':
    case 'user_input': {
      const p = ev.payload as { text: string };
      return userText(p.text, ev.id);
    }
    case 'preamble': {
      const p = ev.payload as { text: string };
      return assistantText(p.text, ev.id);
    }
    case 'reply': {
      const p = ev.payload as { text: string; internal?: boolean };
      if (p.internal) return null;
      return assistantText(p.text, ev.id);
    }
    case 'reasoning': {
      if (!opts.keepReasoning) return null;
      const p = ev.payload as { text: string };
      return {
        role: 'assistant',
        content: [{ kind: 'text', text: `[reasoning] ${p.text}` }],
        cacheTag: ev.id,
      };
    }
    case 'tool_call': {
      const p = ev.payload as { toolCallId: string; name: string; args: unknown };
      return {
        role: 'assistant',
        content: [
          {
            kind: 'tool_use',
            toolCallId: p.toolCallId as never,
            name: p.name,
            args: p.args,
          } satisfies ProjectedContent,
        ],
        cacheTag: ev.id,
      };
    }
    case 'tool_result': {
      return projectToolResult(ev, opts);
    }
    case 'spawn_request': {
      const p = ev.payload as { childThreadId: string; role?: string; task: string };
      const roleSuffix = p.role !== undefined ? ` role=${p.role}` : '';
      return {
        role: 'assistant',
        content: [
          {
            kind: 'text',
            text: `[spawn child=${p.childThreadId}${roleSuffix}] ${p.task}`,
          },
        ],
        cacheTag: ev.id,
      };
    }
    case 'subtask_complete': {
      const p = ev.payload as { childThreadId: string; status: string; summary?: string };
      return {
        role: 'user',
        content: [
          {
            kind: 'text',
            text: `[subtask ${p.childThreadId} ${p.status}] ${p.summary ?? ''}`,
          },
        ],
        cacheTag: ev.id,
      };
    }
    // control-plane events that shouldn't project into the prompt
    case 'interrupt':
    case 'rollback':
    case 'fork':
    case 'compact_request':
    case 'shutdown':
    case 'timer_fired':
    case 'external_event':
    case 'turn_complete':
    case 'sampling_complete':
    case 'compaction_event':
    case 'rollback_marker':
      return null;
    default:
      return null;
  }
}

function projectToolResult(ev: HarnessEvent, opts: ProjectOneOpts): ProjectedItem {
  const p = ev.payload as {
    toolCallId: string;
    ok: boolean;
    output?: unknown;
    error?: { kind: string; message: string };
  };
  const elided = ev.elided;
  const pinned =
    elided && opts.handles?.get(elided.handle)?.pinnedForNextSampling === true;

  let content: ProjectedContent;
  if (elided && !pinned) {
    content = {
      kind: 'elided',
      handle: elided.handle,
      originKind: elided.kind,
      summary: describeElision(elided.kind, elided.meta),
    };
  } else {
    const body = p.ok ? p.output : { error: p.error };
    const json = JSON.stringify(body);
    if (json.length > opts.inlineToolResultLimit && !pinned) {
      content = {
        kind: 'tool_result',
        toolCallId: p.toolCallId as never,
        ok: p.ok,
        output: json.slice(0, opts.inlineToolResultLimit) + '…',
        ...(p.error !== undefined ? { error: p.error.message } : {}),
      };
    } else {
      content = {
        kind: 'tool_result',
        toolCallId: p.toolCallId as never,
        ok: p.ok,
        ...(p.output !== undefined ? { output: p.output } : {}),
        ...(p.error !== undefined ? { error: p.error.message } : {}),
      };
    }
  }
  return {
    role: 'tool_result',
    content: [content],
    cacheTag: ev.id,
  };
}

function describeElision(kind: string, meta: Record<string, unknown>): string {
  const parts: string[] = [`[${kind}]`];
  for (const [k, v] of Object.entries(meta)) parts.push(`${k}=${String(v)}`);
  return parts.join(' ');
}

function userText(text: string, tag: string): ProjectedItem {
  return {
    role: 'user',
    content: [{ kind: 'text', text }],
    cacheTag: tag,
  };
}

function assistantText(text: string, tag: string): ProjectedItem {
  return {
    role: 'assistant',
    content: [{ kind: 'text', text }],
    cacheTag: tag,
  };
}

/**
 * Rough token estimate. bytes/3 is a reasonable approximation for English
 * text; 4/3 safety margin matches Claude Code's estimateMessageTokens.
 */
export function estimateTokens(items: ProjectedItem[]): number {
  let bytes = 0;
  for (const item of items) {
    for (const c of item.content) {
      if (c.kind === 'text') bytes += c.text.length;
      else bytes += JSON.stringify(c).length;
    }
  }
  return Math.ceil(((bytes / 3) * 4) / 3);
}
