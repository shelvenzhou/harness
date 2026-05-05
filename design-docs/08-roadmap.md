# 08 — Roadmap

Phased implementation order. Each item is one or a small number of commits.
The goal of phase 1 (this sprint) is **complete architecture surface + one
end-to-end path**, not production polish.

## Phase 1 — architecture landing (this sprint)

| # | Item                                                         |
|---|--------------------------------------------------------------|
| 1 | Repo scaffold, TS + pnpm, dir layout, README, LICENSE        |
| 2 | Design docs (this set)                                       |
| 3 | Core types — Thread / Turn / Item / Event / Action           |
| 4 | EventBus (typed, in-process) + SessionStore (memory + JSONL) |
| 5 | ActiveTurn state machine + mailbox (CurrentTurn / NextTurn)  |
| 6 | LlmProvider interface + OpenAI provider + scripted test providers |
| 7 | Tool interface + Executor + phase-1 primitive implementations |
| 8 | Context projection + Compactor interface + handle registry  |
| 9 | AgentRunner (action loop) + Subagent pool + Scheduler        |
|10 | Terminal adapter + CLI entry                                 |
|11 | Unit + smoke + e2e test scaffolding                          |
|12 | README tutorial, link out to design docs                     |

Exit criteria:

- `pnpm test` passes (unit + smoke) with no LLM calls.
- `pnpm test:smoke` exercises the terminal path with inline scripted
  providers, including at least one tool call and a compaction.
- `pnpm dev` opens a REPL against the configured provider.
- `HARNESS_E2E=1 pnpm test:e2e` can be run with a real API key and
  exercises at least one real round-trip.

## Phase 2 — make the primitives real

- `write` unified-patch mode.
- Native providers beyond OpenAI-compatible endpoints, starting with
  Anthropic streaming + `cache_control` + `cache_edits`.
- Memory ingestion at turn boundaries.
- Better pruning estimates for next-sampling token pressure.
- Additional `web_search` backends (Brave / DDG) on the existing pluggable
  interface.
- Real compaction prompt tuning on top of the existing subagent compactor.

## Phase 3 — second adapter

- Discord adapter.
- Multi-adapter CLI.
- Thread resume / fork / archive CLI subcommands.

## Phase 4 — sandbox & permissions

- Executor indirection hardened.
- Linux: Landlock + Bubblewrap path.
- macOS: Seatbelt path.
- Network egress policy via proxy (deny-by-default, allowlist per turn).
- Permission prompts threaded through the bus (PermissionReviewEvent).

## Phase 5 — production

- SQLite store backend.
- OTEL exporter wiring.
- Plugin model (skills / MCP / connectors, borrowing the Codex layering).
- App-server-style JSON-RPC + SSE for rich clients.

## Deferred — actor mode

Documented in [10-actor-mode.md](10-actor-mode.md). **Do not schedule into
a phase until a trigger condition fires:** a long-lived LLM-driven service
(Discord watcher with its own loop, file watcher, MCP long-poll), peer
agents that must talk without a parent/child relationship, mailbox-replay
recovery becoming structurally necessary, or a workflow that keeps
re-asking "what state am I in?" every turn. Until one of those lands, the
spawn tree + per-thread mailbox is sufficient and actor mode is pure
overhead. When the trigger arrives, the PR introducing actor mode must
state which trigger justified it.

## What phase 1 deliberately punts

- No real sandboxing. Every side-effect tool trusts its caller.
- No persistent storage beyond JSONL append.
- No tuned compaction prompt — the default static compactor returns a
  placeholder summary unless the subagent compactor is enabled.
- No rate-limit / cost guardrails beyond `budget` on `spawn`.
- No UI beyond plain text.
- No plugin discovery.

These are all called out explicitly so later phases can land against stable
APIs rather than discovering them.
