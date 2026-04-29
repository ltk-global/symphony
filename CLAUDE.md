# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

Symphony (LTK) is a TypeScript daemon that orchestrates coding-agent sessions (Codex App Server or Claude Code headless) against GitHub Projects v2 items, with optional browser-based verification via IRIS (Swarmy).

`SPEC.md` is the authoritative design document — it is a fork of upstream OpenAI Symphony and tags every section as `INHERITED`, `MODIFIED`, or `NEW`. When changing behavior, update SPEC.md alongside the code; when adding tests, expect their assertions to mirror SPEC sections (especially §10 agent runner, §11 GitHub Projects, §14 IRIS, §15 verify). `docs/IMPLEMENTATION.md` covers the deltas from SPEC that this codebase has actually implemented.

## Commands

- `npm run dev -- --workflow path/to/WORKFLOW.md` — run the daemon via `tsx` (long-running poll loop).
- `npm run dev -- --workflow path/to/WORKFLOW.md --once` — single tick, then exit. Use this to validate config without committing to a process.
- `npm test` — run the full vitest suite once (`vitest run`).
- `npx vitest run test/orchestrator.test.ts` — run one test file. Append `-t "<name pattern>"` to filter by test name.
- `npm run typecheck` — `tsc --noEmit`. The build (`npm run build`) emits to `dist/` and is what `bin: symphony` ships.
- Node 22+ is required (`engines.node`). The project is pure ESM (`"type": "module"`, `module: NodeNext`); imports inside `src/` end in `.js` even though the source is `.ts` — keep that convention.

## Architecture

The runtime is a single Node process whose entry points compose like this:

```
cli.ts → SymphonyRuntime → buildRuntimeComponents → Orchestrator.tick (in a setTimeout loop)
```

`SymphonyRuntime` (`src/runtime.ts`) owns workflow hot-reload. It stats `WORKFLOW.md` each tick: when mtime changes **and** no sessions are running it rebuilds every component; reload errors are swallowed so the last-known-good config keeps serving. This is why most components are pure values constructed from `ServiceConfig` and re-instantiated, not long-lived singletons — never cache config-derived state across reloads.

`Orchestrator` (`src/orchestrator/index.ts`) is the only stateful piece. Its in-memory maps (`live`, `retryAttempts`) are the source of truth for what's running; there is no database. Restart recovery comes from re-reading the tracker on the next tick. Each tick:

1. `reconcile()` — refresh Status fields for live sessions, cancel anything that drifted to a terminal/inactive state, and fire `verify` on `on_state_transition` triggers.
2. `fetchCandidateIssues()` — pull active-state items from GitHub Projects, sort by priority/createdAt, dispatch up to capacity (per-state caps in `agent.maxConcurrentAgentsByState` are keyed by **lowercased** state names).
3. `consumeSession()` — drain the agent's `NormalizedEvent` async iterable. Tool calls for `iris_run` are intercepted here (not inside the adapter); `turn_completed` triggers the verify stage; `turn_failed/cancelled/input_required` schedule exponential backoff retries (1s for clean continuations, `10s * 2^(attempt-1)` capped at `agent.maxRetryBackoffMs` for failures).

### Tracker writes are split

The orchestrator only writes to GitHub Projects in two narrow cases: (a) the verify stage's pass/fail/no-url transitions and comments, and (b) the IRIS-blocked handler that moves items to `tracker.needs_human_state`. **Everything else** — moving to "In Progress" when work starts, posting PR links, leaving review feedback — is the agent's job via its own `gh` CLI calls. Don't add tracker writes to the orchestrator hot path; instead, instruct the agent through the prompt template or `claude_code.append_system_prompt`.

### Agent adapters

`src/agent/types.ts` defines `AgentRunner`/`AgentSession` and the `NormalizedEvent` vocabulary that the orchestrator consumes. Both adapters (`codex.ts`, `claude_code.ts`) must produce only normalized events; raw stream events stay inside the adapter. The Claude Code adapter resumes turns by re-spawning `claude --resume <session_id>` (the session_id arrives in the first `system/init` event), and exposes `iris_run` to the model by registering an in-process MCP stub (`claude_iris_mcp.ts`) wired through `--mcp-config` + `--strict-mcp-config`. When the adapter spawns this MCP subprocess, the orchestrator passes IRIS state via `SYMPHONY_IRIS_*` env vars (set in `runtime.ts:configureIrisEnvironment`) — the MCP server and the orchestrator-side `IrisClient` share one `FileSemaphore` keyed by `SYMPHONY_IRIS_SHARED_SEMAPHORE_KEY` so Model A (agent tool call) and Model B (verify stage) genuinely contend for the same `iris.max_concurrent` slots across processes.

### Workflow contract

`WORKFLOW.md` lives in the target repo, not this one. It is YAML front matter (parsed by `src/workflow/loader.ts`) plus a Liquid prompt body rendered with `strictVariables: true`. The front matter feeds `buildConfig` (`src/config/index.ts`) which is the single place where YAML snake_case keys (`project_url`, `active_states`, `iris.on_blocked`, etc.) become typed `ServiceConfig` camelCase. When you add a config key: schema → `ServiceConfig` interface → `buildConfig` mapping → consumer. The `verify` block is currently passed through as `Record<string, unknown>` and normalized inside the orchestrator (`normalizeVerifyConfig`) — it accepts both snake_case and camelCase, which is intentional for SPEC fidelity.

### Workspace lifecycle

`WorkspaceManager.prepare()` sanitizes the issue identifier into a key (`[A-Za-z0-9._-]` only — `#` and `/` both become `_`), creates `<workspace.root>/<key>`, and runs the `after_create` hook with `ISSUE_*` env vars exported. Hooks are `bash -lc` scripts. `after_create`/`before_run` failures abort the attempt; `after_run`/`before_remove` failures are logged and ignored. The canonical `after_create` hook clones `${ISSUE_REPO_FULL_NAME}` using the orchestrator's `GITHUB_TOKEN`.

## Testing notes

- Tests live in `test/` and import from `src/` via `.js` extensions. Vitest is configured with `globals: false` — import `describe/it/expect` explicitly.
- `test/orchestrator.test.ts` is the largest and exercises the full live-session/verify/iris flow with fakes; when changing orchestrator dispatch or event handling, run it first. Most other suites unit-test a single module against fakes and don't need network/CLI tools.
- `test/agent.test.ts` invokes `mapClaudeStreamEvent` directly — that function is the contract between Claude Code's stream-json output and the normalized event vocabulary; if it changes, expect to update SPEC §10b's mapping table.
