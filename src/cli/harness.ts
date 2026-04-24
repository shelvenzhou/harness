#!/usr/bin/env node
import { parseArgs } from 'node:util';

import 'dotenv/config';

import type { LlmProvider } from '@harness/llm/provider.js';
import { OpenAIProvider } from '@harness/llm/openaiProvider.js';
import { bootstrap } from '@harness/runtime/bootstrap.js';
import { TerminalAdapter } from '@harness/adapters/terminal.js';

/**
 * `harness` CLI. Reads .env for OpenAI credentials; CLI flags override.
 */

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      provider: { type: 'string' },
      model: { type: 'string' },
      'base-url': { type: 'string' },
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

  const providerName = values.provider ?? process.env['HARNESS_PROVIDER'] ?? 'openai';
  const provider = buildProvider({
    name: providerName,
    ...(typeof values.model === 'string' ? { model: values.model } : {}),
    ...(typeof values['base-url'] === 'string' ? { baseURL: values['base-url'] } : {}),
  });

  const systemPrompt =
    typeof values.system === 'string'
      ? values.system
      : (process.env['HARNESS_SYSTEM_PROMPT'] ?? 'You are a helpful agent. Respond concisely.');

  const storeRoot =
    typeof values['store-root'] === 'string'
      ? values['store-root']
      : process.env['HARNESS_STORE_ROOT'];

  const runtime = await bootstrap({
    provider,
    systemPrompt,
    ...(storeRoot !== undefined ? { storeRoot } : {}),
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

interface BuildProviderArgs {
  name: string;
  model?: string;
  baseURL?: string;
}

function buildProvider(args: BuildProviderArgs): LlmProvider {
  switch (args.name) {
    case 'openai': {
      const apiKey = process.env['OPENAI_API_KEY'];
      if (!apiKey) {
        throw new Error(
          'OPENAI_API_KEY is required. Copy .env.example to .env and fill it in.',
        );
      }
      const model = args.model ?? process.env['OPENAI_MODEL'];
      const baseURL = args.baseURL ?? process.env['OPENAI_BASE_URL'];
      const maxTokens = envNumber('OPENAI_MAX_TOKENS');
      const temperature = envNumber('OPENAI_TEMPERATURE');
      return new OpenAIProvider({
        apiKey,
        ...(model !== undefined ? { model } : {}),
        ...(baseURL !== undefined ? { baseURL } : {}),
        ...(maxTokens !== undefined ? { defaultMaxTokens: maxTokens } : {}),
        ...(temperature !== undefined ? { defaultTemperature: temperature } : {}),
      });
    }
    default:
      throw new Error(`unknown provider: ${args.name}`);
  }
}

function envNumber(key: string): number | undefined {
  const raw = process.env[key];
  if (raw === undefined || raw === '') return undefined;
  const n = Number(raw);
  return Number.isFinite(n) ? n : undefined;
}

function printUsage(): void {
  process.stdout.write(
    [
      'Usage: harness [--provider openai] [--model <id>] [--base-url <url>] [--system <prompt>] [--store-root <dir>]',
      '',
      'Environment (also loaded from .env):',
      '  OPENAI_API_KEY       required',
      '  OPENAI_MODEL         default gpt-4o-mini',
      '  OPENAI_BASE_URL      override endpoint (OpenAI-compatible)',
      '  OPENAI_MAX_TOKENS    default 1024',
      '  OPENAI_TEMPERATURE   default 0.7',
      '  HARNESS_PROVIDER     default openai',
      '  HARNESS_SYSTEM_PROMPT',
      '  HARNESS_STORE_ROOT   persist session events to this directory',
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
