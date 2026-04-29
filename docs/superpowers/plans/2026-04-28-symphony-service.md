# Symphony Service Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the TypeScript Symphony service described in `SPEC.md`.

**Architecture:** A Node 22 ESM CLI loads `WORKFLOW.md`, validates config, polls GitHub Projects v2, creates isolated workspaces, runs a selected agent backend, and optionally verifies browser behavior through IRIS. Runtime pieces are split by responsibility: workflow/config, tracker, workspace, agent adapters, IRIS, verify, and orchestrator.

**Tech Stack:** TypeScript, Node 22, Vitest, commander, zod, yaml, liquidjs, pino, undici.

---

## Chunk 1: Project Scaffold And Core Utilities

### Task 1: Project Setup

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `vitest.config.ts`
- Create: `src/types.ts`
- Test: `test/workflow.test.ts`

- [ ] Write failing tests for workflow parsing, env indirection, template rendering, and defaults.
- [ ] Run `npm test -- test/workflow.test.ts` and confirm it fails because modules are missing.
- [ ] Add package metadata and TypeScript config.
- [ ] Implement shared domain types.
- [ ] Implement `src/workflow/loader.ts` and `src/config/index.ts`.
- [ ] Run the workflow tests until passing.

### Task 2: Workspace Management

**Files:**
- Create: `src/workspace/manager.ts`
- Test: `test/workspace.test.ts`

- [ ] Write failing tests for workspace key sanitization and hook environment.
- [ ] Implement workspace creation, hook execution, and safety checks.
- [ ] Run the workspace tests until passing.

## Chunk 2: Integrations

### Task 3: GitHub Projects Tracker

**Files:**
- Create: `src/tracker/github_projects.ts`
- Test: `test/github_projects.test.ts`

- [ ] Write failing tests for project URL parsing, Project item normalization, filters, and blocked-by labels.
- [ ] Implement GraphQL transport, pagination, normalization, filtering, and tracker write helpers.
- [ ] Run tracker tests until passing.

### Task 4: IRIS Client

**Files:**
- Create: `src/iris/semaphore.ts`
- Create: `src/iris/client.ts`
- Test: `test/iris.test.ts`

- [ ] Write failing tests for FIFO semaphore acquisition, SSE parsing, result capture, blocked events, and timeout aborts.
- [ ] Implement semaphore and IRIS REST/SSE client.
- [ ] Run IRIS tests until passing.

## Chunk 3: Runtime

### Task 5: Verify Stage

**Files:**
- Create: `src/verify/url.ts`
- Create: `src/verify/stage.ts`
- Test: `test/verify.test.ts`

- [ ] Write failing tests for URL resolution, result JSON parsing, pass transitions, retry feedback, terminal failures, and no-URL handling.
- [ ] Implement verify URL resolver and verify runner.
- [ ] Run verify tests until passing.

### Task 6: Agent Adapters

**Files:**
- Create: `src/agent/types.ts`
- Create: `src/agent/claude_code.ts`
- Create: `src/agent/codex.ts`
- Test: `test/agent.test.ts`

- [ ] Write failing tests for Claude Code stream-json mapping and Codex JSON event mapping.
- [ ] Implement normalized agent event interfaces and adapters.
- [ ] Run agent tests until passing.

### Task 7: Orchestrator And CLI

**Files:**
- Create: `src/orchestrator/index.ts`
- Create: `src/log.ts`
- Create: `src/cli.ts`
- Modify: `package.json`
- Test: `test/orchestrator.test.ts`

- [ ] Write failing tests for candidate scheduling, blocked issue skipping, per-state concurrency, retry queues, and reconciliation release.
- [ ] Implement poll loop, dispatch, retry, reconciliation, status snapshots, and CLI wiring.
- [ ] Run orchestrator tests until passing.
- [ ] Run `npm run build` and `npm test`.
