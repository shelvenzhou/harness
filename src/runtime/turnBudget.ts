/**
 * Hard-wall token budget tracker for AgentRunner.
 *
 * Mechanism, not advice: when tripped, the turn terminates with
 * `errored` and a summary indicating which cap fired. The runner
 * checks before each sampling step (gates accumulated state from
 * prior steps) and again after each sampling that didn't emit tool
 * calls (catches a single oversized response that would otherwise
 * close the turn as `completed`).
 *
 * Tokens counted are `promptTokens + completionTokens` from each
 * `sampling_complete`. `cachedPromptTokens` is included in
 * `promptTokens` by convention.
 */

export interface TokenBudget {
  /** Hard cap on cumulative tokens for the current user turn. */
  maxTurnTokens?: number;
  /** Hard cap on cumulative tokens over the lifetime of this thread. */
  maxThreadTokens?: number;
}

export class TurnBudgetTracker {
  private tokensThisTurn = 0;
  private tokensThisThread = 0;

  constructor(private readonly budget?: TokenBudget) {}

  /** Reset turn-scoped counters at a new `user_turn_start`. */
  resetTurn(): void {
    this.tokensThisTurn = 0;
  }

  /** Add a `sampling_complete`'s usage delta to both counters. */
  add(promptTokens: number, completionTokens: number): void {
    const step = (promptTokens ?? 0) + (completionTokens ?? 0);
    this.tokensThisTurn += step;
    this.tokensThisThread += step;
  }

  /** Seed the thread-lifetime counter from the persisted store on resume. */
  hydrateThread(total: number): void {
    this.tokensThisThread = total;
  }

  /** Live counters for usage-tool reporting. */
  get turnTokens(): number {
    return this.tokensThisTurn;
  }
  get threadTokens(): number {
    return this.tokensThisThread;
  }

  /** Returns a non-empty string when a cap has been breached. */
  check(): string | undefined {
    const b = this.budget;
    if (!b) return undefined;
    if (b.maxTurnTokens !== undefined && this.tokensThisTurn >= b.maxTurnTokens) {
      return `tokens_exceeded:turn used=${this.tokensThisTurn} cap=${b.maxTurnTokens}`;
    }
    if (b.maxThreadTokens !== undefined && this.tokensThisThread >= b.maxThreadTokens) {
      return `tokens_exceeded:thread used=${this.tokensThisThread} cap=${b.maxThreadTokens}`;
    }
    return undefined;
  }
}
