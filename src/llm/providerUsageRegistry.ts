/**
 * Per-runtime registry of `LlmProvider` account state.
 *
 * Coding-agent providers (`CodingAgentProvider`) push a snapshot of
 * the account-level information they observed in a CLI run (last
 * session id, per-run token / cost stats, freshness timestamp). The
 * `usage` tool reads from this registry so the main agent can ask
 * "what do you currently know about cc / codex?" without round-
 * tripping through a `spawn` chat.
 *
 * Scope is intentionally small in M1:
 *
 *   - One snapshot per provider id (cc / codex / …); the most
 *     recent run's numbers replace the previous one. No history.
 *   - No active probing. The registry only holds what providers
 *     have voluntarily reported during normal sample() runs.
 *   - No `resetAt` / quota-exhausted bookkeeping. M2's quota
 *     coordination layer extends this same shape with `resetAt`,
 *     `kind: 'session'|'weekly'`, and `exhausted: boolean`.
 *
 * Providers that cannot introspect (raw OpenAI Chat) simply never
 * touch the registry; the corresponding key stays absent from
 * `entries()`.
 */
export interface ProviderTokenStats {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens?: number;
  cacheCreationInputTokens?: number;
}

export interface ProviderUsageSnapshot {
  /** Stable provider id (e.g. 'cc', 'codex'). */
  provider: string;
  /** Most recent session id surfaced by the provider, when available. */
  lastSessionId?: string;
  /** Tokens billed for the most recent run. */
  lastTokens?: ProviderTokenStats;
  /** Provider-reported cost for the most recent run, in USD. */
  lastCostUsd?: number;
  /** Number of internal turns the provider used on the most recent run. */
  lastTurns?: number;
  /** Wall-clock duration of the most recent run, in milliseconds. */
  lastDurationMs?: number;
  /** Model id reported by the provider on the most recent run. */
  lastModel?: string;
  /** ISO-8601 timestamp of the most recent registry update. */
  lastUpdateAt: string;
}

export interface ProviderUsagePatch {
  lastSessionId?: string;
  lastTokens?: ProviderTokenStats;
  lastCostUsd?: number;
  lastTurns?: number;
  lastDurationMs?: number;
  lastModel?: string;
}

export class ProviderUsageRegistry {
  private readonly snapshots = new Map<string, ProviderUsageSnapshot>();

  /**
   * Merge `patch` into the snapshot for `providerId`. Undefined fields
   * in `patch` do not clobber existing values — providers can push
   * partial updates as the CLI emits more data over the course of a
   * single run.
   */
  update(providerId: string, patch: ProviderUsagePatch): void {
    const prev = this.snapshots.get(providerId);
    const next: ProviderUsageSnapshot = {
      provider: providerId,
      lastUpdateAt: new Date().toISOString(),
      ...(prev ?? {}),
      ...stripUndefined(patch),
    };
    next.lastUpdateAt = new Date().toISOString();
    this.snapshots.set(providerId, next);
  }

  get(providerId: string): ProviderUsageSnapshot | undefined {
    return this.snapshots.get(providerId);
  }

  entries(): ProviderUsageSnapshot[] {
    return [...this.snapshots.values()];
  }

  has(providerId: string): boolean {
    return this.snapshots.has(providerId);
  }
}

function stripUndefined<T extends object>(o: T): Partial<T> {
  const out: Partial<T> = {};
  for (const [k, v] of Object.entries(o)) {
    if (v !== undefined) (out as Record<string, unknown>)[k] = v;
  }
  return out;
}
