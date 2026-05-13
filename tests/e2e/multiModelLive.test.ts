import { describe, expect, it } from 'vitest';
import 'dotenv/config';

import { OpenAIProvider, type OpenAIApiMode } from '@harness/llm/openaiProvider.js';
import type {
  ProjectedContent,
  ProjectedItem,
  SamplingDelta,
  StablePrefix,
} from '@harness/llm/provider.js';

/**
 * Live multi-model provider coverage.
 *
 * Skipped unless HARNESS_E2E=1 and at least one runnable model config
 * is present. By default this runs every HARNESS_MODEL_ALIASES entry
 * with an available api key; set HARNESS_E2E_MODEL_ALIASES=main,deepseek
 * to narrow an expensive run.
 *
 * Each configured model gets two real provider samples. The second
 * sample echoes the first assistant message, including typed reasoning
 * when the provider streamed it. This specifically covers
 * OpenAI-compatible thinking models such as DeepSeek, which reject
 * follow-up Chat Completions requests if assistant reasoning_content is
 * dropped from history.
 */

interface LiveModelConfig {
  alias: string;
  model: string;
  apiKeyEnv: string;
  apiMode?: OpenAIApiMode;
  baseURL?: string;
  chatMaxTokensParam?: 'max_completion_tokens' | 'max_tokens';
}

interface SampleResult {
  text: string;
  reasoning: string;
  stopReason?: Extract<SamplingDelta, { kind: 'end' }>['stopReason'];
}

const shouldRun = process.env['HARNESS_E2E'] === '1';
const liveModels = discoverLiveModelConfigs();

describe.skipIf(!shouldRun || liveModels.length === 0)('e2e: configured live models', () => {
  for (const config of liveModels) {
    it(
      `${config.alias} (${config.model}) supports two-turn provider sampling`,
      async () => {
        const provider = makeProvider(config);
        const firstUser: ProjectedItem = user('Reply with exactly: alpha');
        const first = await sampleOnce(provider, [firstUser]);
        expect(first.text.trim().length).toBeGreaterThan(0);

        if (expectsReasoningContent(config.model)) {
          expect(first.reasoning.trim().length).toBeGreaterThan(0);
        }

        const assistantContent: ProjectedContent[] = [
          ...(first.reasoning ? [{ kind: 'reasoning' as const, text: first.reasoning }] : []),
          { kind: 'text' as const, text: first.text },
        ];
        const second = await sampleOnce(provider, [
          firstUser,
          { role: 'assistant', content: assistantContent },
          user('Reply with exactly: beta'),
        ]);

        // eslint-disable-next-line no-console
        console.log(
          `live model ${config.alias}: model=${config.model} apiMode=${config.apiMode ?? 'default'} ` +
            `reasoningChars=${first.reasoning.length} firstStop=${first.stopReason ?? '?'} ` +
            `secondStop=${second.stopReason ?? '?'}`,
        );
        expect(second.text.trim().length).toBeGreaterThan(0);
      },
      90_000,
    );
  }
});

function discoverLiveModelConfigs(): LiveModelConfig[] {
  const selectedAliases = splitAliases(
    process.env['HARNESS_E2E_MODEL_ALIASES'] ?? process.env['HARNESS_MODEL_ALIASES'],
  );
  if (selectedAliases.length === 0) {
    const global = globalConfig('openai');
    return global ? [global] : [];
  }

  return selectedAliases
    .map((alias) => aliasConfig(alias) ?? globalAliasConfig(alias))
    .filter((config): config is LiveModelConfig => config !== undefined);
}

function aliasConfig(alias: string): LiveModelConfig | undefined {
  const raw = process.env[`HARNESS_MODEL_${envSuffix(alias)}`];
  if (!raw) return undefined;
  const parts = raw.split('|').map((v) => v.trim());
  const provider = parts[0];
  const model = parts[1];
  if (provider !== 'openai' || !model) return undefined;

  const apiKeyEnv = parts[4] || 'OPENAI_API_KEY';
  if (!process.env[apiKeyEnv]) return undefined;

  const suffix = envSuffix(alias);
  const apiMode = parseApiMode(parts[2]);
  const baseURL = parts[3] || undefined;
  const chatMaxTokensParam =
    parseChatMaxTokensParam(process.env[`OPENAI_CHAT_MAX_TOKENS_PARAM_${suffix}`]) ??
    parseChatMaxTokensParam(process.env['OPENAI_CHAT_MAX_TOKENS_PARAM']);

  return {
    alias,
    model,
    apiKeyEnv,
    ...(apiMode !== undefined ? { apiMode } : {}),
    ...(baseURL !== undefined ? { baseURL } : {}),
    ...(chatMaxTokensParam !== undefined ? { chatMaxTokensParam } : {}),
  };
}

function globalAliasConfig(alias: string): LiveModelConfig | undefined {
  if (alias !== 'openai' && alias !== 'default') return undefined;
  return globalConfig(alias);
}

function globalConfig(alias: string): LiveModelConfig | undefined {
  if (!process.env['OPENAI_API_KEY']) return undefined;
  const apiMode = parseApiMode(process.env['OPENAI_API_MODE']);
  const baseURL = process.env['OPENAI_BASE_URL'];
  const chatMaxTokensParam = parseChatMaxTokensParam(
    process.env['OPENAI_CHAT_MAX_TOKENS_PARAM'],
  );
  return {
    alias,
    model: process.env['OPENAI_MODEL'] ?? 'gpt-4o-mini',
    apiKeyEnv: 'OPENAI_API_KEY',
    ...(apiMode !== undefined ? { apiMode } : {}),
    ...(baseURL !== undefined ? { baseURL } : {}),
    ...(chatMaxTokensParam !== undefined ? { chatMaxTokensParam } : {}),
  };
}

function makeProvider(config: LiveModelConfig): OpenAIProvider {
  return new OpenAIProvider({
    apiKey: process.env[config.apiKeyEnv]!,
    model: config.model,
    defaultMaxTokens: 1024,
    ...(config.apiMode !== undefined ? { apiMode: config.apiMode } : {}),
    ...(config.baseURL !== undefined ? { baseURL: config.baseURL } : {}),
    ...(config.chatMaxTokensParam !== undefined
      ? { chatMaxTokensParam: config.chatMaxTokensParam }
      : {}),
  });
}

async function sampleOnce(
  provider: OpenAIProvider,
  tail: ProjectedItem[],
): Promise<SampleResult> {
  const ctl = new AbortController();
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    ctl.abort();
  }, 60_000);
  const result: SampleResult = { text: '', reasoning: '' };

  try {
    for await (const delta of provider.sample(
      {
        prefix: prefix(),
        tail,
        maxTokens: 1024,
      },
      ctl.signal,
    )) {
      switch (delta.kind) {
        case 'text_delta':
          result.text += delta.text;
          break;
        case 'reasoning_delta':
          result.reasoning += delta.text;
          break;
        case 'end':
          result.stopReason = delta.stopReason;
          break;
        default:
          break;
      }
    }
  } finally {
    clearTimeout(timeout);
  }

  if (timedOut) throw new Error('live provider sample timed out');
  return result;
}

function prefix(): StablePrefix {
  return {
    systemPrompt:
      'You are a terse e2e test assistant. Reply with only the requested token.',
    tools: [],
  };
}

function user(text: string): ProjectedItem {
  return {
    role: 'user',
    content: [{ kind: 'text', text }],
  };
}

function splitAliases(raw: string | undefined): string[] {
  return (raw ?? '')
    .split(',')
    .map((v) => v.trim())
    .filter((v) => v.length > 0);
}

function envSuffix(alias: string): string {
  return alias.toUpperCase().replace(/[^A-Z0-9]/g, '_');
}

function parseApiMode(raw: string | undefined): OpenAIApiMode | undefined {
  const v = raw?.toLowerCase();
  if (v === 'responses' || v === 'chat_completions') return v;
  return undefined;
}

function parseChatMaxTokensParam(
  raw: string | undefined,
): 'max_completion_tokens' | 'max_tokens' | undefined {
  if (raw === 'max_completion_tokens' || raw === 'max_tokens') return raw;
  return undefined;
}

function expectsReasoningContent(model: string): boolean {
  return /deepseek.*(v4|pro|flash|reasoner)/i.test(model);
}
