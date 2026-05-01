# 07 — Diagnostics

First-class requirement per CLAUDE.md. Three layers:

## 1. Prompt reconstruction (before call)

`src/context/promptDebug.ts`:

- `renderPrompt(request) → { text, toolsJson, stats }` — non-mutating dry
  run.
- CLI: `pnpm dev --dump-prompts=./dump/` — writes each sampling request to
  a timestamped file with a sibling response when available.
- Unit-testable: given an event log + projection rules, the output is
  deterministic.

This is the **first** thing to reach for when an agent misbehaves.

## 2. Tracing (during call)

- Every event carries `traceparent` (W3C). Propagated into:
  - `spawn` → child's initial events reference the parent's traceparent.
  - `tool_call` → executor records traceparent on `tool_result`.
- `src/diag/otel.ts` — thin OTEL emitter; disabled by default. Enabled via
  `HARNESS_OTEL_ENDPOINT=…`.
- Span model:
  - thread root → turn → sampling / tool_call / subtask.

## 3. Token / cost / cache facts (after call)

Per-sampling facts collected from the provider's `usage` delta:

```
TurnTokenUsageFact {
  threadId, turnId,
  promptTokens, cachedPromptTokens, completionTokens,
  ttftMs,                       // time-to-first-token
  wallMs,
  compactionsTriggered,
  providerId,
}
```

`src/diag/analytics.ts` exposes `observe(fact)`; the built-in sink is
stdout-pretty + JSONL to `.harness/usage.jsonl`. Remote export is
explicitly out of scope for phase 1 (per the project contract).

## Compaction events

Every compaction emits a `CompactionEvent`:

```
CompactionEvent {
  threadId, reason: 'auto' | 'manual' | 'tool-change',
  tokensBefore, tokensAfter,
  durationMs,
  retainedUserTurns, ghostSnapshotCount,
}
```

Visible on the bus and loggable — same treatment as any other Item. UIs can
render compactions inline with the conversation, which is the Codex app-
server design.

The token fields are real estimates (cheap byte-based proxy over the
event log, with this pass's elision overrides folded in) — not the
zero placeholders an early draft emitted. The estimator does *not*
deep-clone the events; it only re-renders the entries whose elision
metadata changed in the current pass, so the cost stays O(events
touched) rather than O(events on the thread). The `StaticCompactor`
strategy and the cold-path `CompactionHandler` produce the same
non-placeholder shape.

`turn_complete` carries an analogous `reason` field separate from
`summary` — useful for diag because user-initiated cancellations
(`user_interrupt` / `parent_interrupt`), budget caps, and model
mistakes (`model_returned_no_actions`) all want different treatment
in dashboards. The terminal adapter and the stderr diag sink both
render `summary` and `reason` together when both are present.

## Permission review log (future hook)

When sandbox / permissions land:

```
PermissionReviewEvent {
  threadId, toolCallId, decision: 'allow' | 'deny' | 'prompt',
  reason, justification, policySource,
}
```

The bus already has space for this event kind; the enforcement layer is
deferred.

## Local-first

All logs above live under `.harness/` by default. Nothing is sent off the
machine unless explicitly configured. This is the project contract.
