import type { Action } from '@harness/core/actions.js';
import { newToolCallId } from '@harness/core/ids.js';
import type { ToolCallId } from '@harness/core/ids.js';

import type { SamplingDelta } from './provider.js';

/**
 * Translate a stream of SamplingDeltas into a list of high-level Actions.
 *
 * This is the only piece that interprets provider output. It is provider-
 * agnostic: any provider that produces the SamplingDelta contract gets
 * its output parsed here.
 */

export interface ParsedSampling {
  actions: Action[];
  /** Concatenated reasoning text (if any). Kept separate from reply actions. */
  reasoningText: string;
  stopReason?: 'end_turn' | 'max_tokens' | 'tool_use' | 'error';
  usage?: { promptTokens: number; cachedPromptTokens: number; completionTokens: number };
  ttftMs?: number;
}

export async function parseSampling(
  stream: AsyncIterable<SamplingDelta>,
): Promise<ParsedSampling> {
  let replyBuf = '';
  let replyChannel: 'reply' | 'preamble' | undefined;
  let reasoningBuf = '';
  const toolCallsInFlight = new Map<ToolCallId, { name: string; args?: unknown }>();
  const actions: Action[] = [];
  let stopReason: ParsedSampling['stopReason'];
  let usage: ParsedSampling['usage'];
  const startedAt = Date.now();
  let firstByteAt: number | undefined;

  const flushReply = (): void => {
    if (!replyBuf) return;
    if (replyChannel === 'preamble') {
      actions.push({ kind: 'preamble', text: replyBuf });
    } else {
      actions.push({ kind: 'reply', text: replyBuf });
    }
    replyBuf = '';
    replyChannel = undefined;
  };

  for await (const delta of stream) {
    if (firstByteAt === undefined && delta.kind !== 'usage' && delta.kind !== 'end') {
      firstByteAt = Date.now();
    }
    switch (delta.kind) {
      case 'text_delta': {
        // Channel change forces a flush so the two chunks don't merge.
        const ch = delta.channel ?? 'reply';
        if (replyChannel && replyChannel !== ch) flushReply();
        replyChannel = ch;
        replyBuf += delta.text;
        break;
      }
      case 'reasoning_delta':
        reasoningBuf += delta.text;
        break;
      case 'tool_call_begin':
        toolCallsInFlight.set(delta.toolCallId, { name: delta.name });
        break;
      case 'tool_call_arg_delta':
        // We don't accumulate arg partials here; providers that don't emit
        // `tool_call_end` with final args will need to do their own JSON
        // assembly before this parser.
        break;
      case 'tool_call_end': {
        const entry = toolCallsInFlight.get(delta.toolCallId);
        if (!entry) break;
        entry.args = delta.args;
        toolCallsInFlight.delete(delta.toolCallId);
        flushReply(); // any text before a tool call becomes its own reply
        actions.push({
          kind: 'tool_call',
          toolCallId: delta.toolCallId,
          name: entry.name,
          args: delta.args,
        });
        break;
      }
      case 'usage':
        usage = { ...delta.tokens };
        break;
      case 'end':
        stopReason = delta.stopReason;
        break;
    }
  }

  flushReply();

  // Mark the last reply as final — terminator heuristic; runner may
  // override based on stopReason.
  if (stopReason === 'end_turn') {
    for (let i = actions.length - 1; i >= 0; i--) {
      const a = actions[i]!;
      if (a.kind === 'reply') {
        a.final = true;
        break;
      }
    }
  }

  return {
    actions,
    reasoningText: reasoningBuf,
    ...(stopReason !== undefined ? { stopReason } : {}),
    ...(usage !== undefined ? { usage } : {}),
    ...(firstByteAt !== undefined ? { ttftMs: firstByteAt - startedAt } : {}),
  };
}

/** Generate a fresh ToolCallId; exposed for providers that need to invent one. */
export function mintToolCallId(): ToolCallId {
  return newToolCallId();
}
