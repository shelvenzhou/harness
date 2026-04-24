#!/usr/bin/env node
import { parseArgs } from 'node:util';

import { AnthropicProvider } from '@harness/llm/anthropicProvider.js';
import { MockProvider } from '@harness/llm/mockProvider.js';
import type { LlmProvider, SamplingDelta } from '@harness/llm/provider.js';
import { bootstrap } from '@harness/runtime/bootstrap.js';
import { TerminalAdapter } from '@harness/adapters/terminal.js';

/**
 * `harness` CLI.
 *
 * Phase 1: a thin REPL that wires MockProvider (or AnthropicProvider)
 * through a terminal adapter. Enough to verify the full event path.
 */

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      provider: { type: 'string' },
      model: { type: 'string' },
      system: { type: 'string' },
      'store-root': { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
    allowPositionals: true,
  });

  if (values.help) {
    printUsage();
    return;
  }

  const providerName = values.provider ?? process.env['HARNESS_PROVIDER'] ?? 'mock';
  const provider = buildProvider(providerName, typeof values.model === 'string' ? values.model : undefined);
  const systemPrompt =
    typeof values.system === 'string'
      ? values.system
      : 'You are a helpful agent. Respond concisely.';

  const runtime = await bootstrap({
    provider,
    systemPrompt,
    ...(typeof values['store-root'] === 'string' ? { storeRoot: values['store-root'] } : {}),
  });

  const adapter = new TerminalAdapter({ store: runtime.store });
  await adapter.start({
    bus: runtime.bus,
    threadBinding: { kind: 'single', threadId: runtime.rootThreadId },
  });

  process.stdout.write(
    `harness started. provider=${provider.id} thread=${runtime.rootThreadId}. Type your message, /exit to quit.\n`,
  );
}

function buildProvider(name: string, model?: string): LlmProvider {
  switch (name) {
    case 'mock':
      return demoMockProvider();
    case 'anthropic': {
      const apiKey = process.env['ANTHROPIC_API_KEY'];
      if (!apiKey) {
        throw new Error('ANTHROPIC_API_KEY is required for provider=anthropic');
      }
      return new AnthropicProvider({
        apiKey,
        ...(model !== undefined ? { model } : {}),
      });
    }
    default:
      throw new Error(`unknown provider: ${name}`);
  }
}

/**
 * Scripted mock provider that echoes the user's latest text and ends the
 * turn. Good enough to verify the event loop end-to-end without a real API.
 */
function demoMockProvider(): MockProvider {
  return new MockProvider({
    react: (req) => {
      const last = req.tail[req.tail.length - 1];
      const text =
        last?.content.find(
          (c): c is { kind: 'text'; text: string } => c.kind === 'text',
        )?.text ?? '(no input)';
      const deltas: SamplingDelta[] = [
        { kind: 'text_delta', text: `mock: I heard "${text}".`, channel: 'reply' },
        { kind: 'end', stopReason: 'end_turn' },
      ];
      return deltas;
    },
  });
}

function printUsage(): void {
  process.stdout.write(
    [
      'Usage: harness [--provider mock|anthropic] [--model <id>] [--system <prompt>] [--store-root <dir>]',
      '',
      'Environment:',
      '  HARNESS_PROVIDER     default provider id',
      '  ANTHROPIC_API_KEY    required when provider=anthropic',
      '',
      'Interactive commands:',
      '  /exit, /quit         leave the REPL',
      '  /interrupt           cancel the running turn',
      '',
    ].join('\n'),
  );
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
