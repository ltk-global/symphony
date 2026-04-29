# Symphony (LTK) — Service Specification

Status: Draft v0.1 (TypeScript reference, GitHub Projects v2 + IRIS)

Purpose: Define a service that orchestrates coding agents (Codex or Claude Code) to get project work done, using GitHub Projects (v2) as the issue tracker and IRIS (https://swarmy.firsttofly.com) as the browser-test runtime.

This spec is a fork of OpenAI's Symphony SPEC (https://github.com/openai/symphony/blob/main/SPEC.md). Sections are tagged:

- **INHERITED** — verbatim or near-verbatim from upstream Symphony; reference upstream for prose.
- **MODIFIED** — same purpose as upstream but adapted for our stack.
- **NEW** — additions specific to this fork.

## 0. Scope and Non-Goals

In scope:

- A long-running TypeScript service that polls GitHub Projects (v2), claims work items, runs an isolated coding-agent session per item, optionally invokes IRIS for browser-based work and verification, and lets the agent transition project Status fields.
- A repository-owned `WORKFLOW.md` contract that drives behavior.
- Two pluggable coding-agent backends: `codex` (Codex App Server JSON-RPC over stdio) and `claude_code` (Claude Code in headless mode).
- Two IRIS integration paths sharing one semaphore: Model A (agent tool call `iris_run`) and Model B (orchestrator-driven verify stage).

Out of scope:

- Linear support (intentionally dropped — GitHub Projects only).
- A persistent orchestrator database. State is in-memory, recoverable from tracker + filesystem on restart.
- Multi-tenant control plane / hosted UI.
- Workflow engine generality. Workflow logic lives in `WORKFLOW.md` and the agent prompt, not in the orchestrator.

## 1. Problem Statement (INHERITED, condensed)

Symphony-style orchestration: every open work item gets an agent; agents run continuously in isolated workspaces; humans review the results. The orchestrator is a scheduler/runner and tracker reader. Tracker writes (Status transitions, comments, PR links) are performed by the agent using its own tools. A successful run may end at a workflow-defined handoff state (e.g. `In Review`), not necessarily `Done`.

This fork adds: pluggable agent backend and a first-class browser-agent integration via IRIS.

## 2. Goals and Non-Goals

See upstream §2. Goals carry over unchanged. One added goal:

- **NEW G7**: Provide first-class browser-agent integration via IRIS, with both agent-driven (tool call) and orchestrator-driven (verify stage) invocation paths, sharing one concurrency semaphore.

## 3. System Overview

### 3.1 Components (MODIFIED)

1. **Workflow Loader** (INHERITED) — reads `WORKFLOW.md`, parses YAML front matter, returns `{config, prompt_template}`.
2. **Config Layer** (INHERITED) — typed getters, defaults, `$VAR` env indirection, dispatch preflight validation.
3. **Issue Tracker Client** (MODIFIED) — GitHub Projects (v2) GraphQL adapter. Fetches project items in active Status values, refreshes Status for running items, lists terminal items at startup. See §11.
4. **Orchestrator** (INHERITED) — owns the poll tick, in-memory runtime state, dispatch decisions, retries, reconciliation.
5. **Workspace Manager** (INHERITED) — per-issue workspace directories, lifecycle hooks, sanitized keys.
6. **Agent Runner** (MODIFIED) — abstract interface with two adapters: `CodexAdapter` (§10a) and `ClaudeCodeAdapter` (§10b). Both surface a normalized event vocabulary upstream to the orchestrator.
7. **IrisClient** (NEW) — typed wrapper over IRIS REST + SSE. Owns the global IRIS semaphore. Used by Model A (injected as `iris_run` tool spec into the agent session) and Model B (called directly by the verify stage). See §14.
8. **Verify Stage** (NEW) — orchestrator-driven post-turn verification stage that resolves a `verify_url` per repo policy, invokes IRIS, parses the structured result, and either transitions the item or feeds failure back as continuation guidance for the next agent turn. See §15.
9. **Status Surface** (INHERITED, optional).
10. **Logging** (INHERITED) — structured key=value logs.

### 3.2 External Dependencies (MODIFIED)

- GitHub GraphQL API v4 (`https://api.github.com/graphql`) for Projects v2.
- GitHub REST API v3 (used by agent tools, not by the orchestrator itself).
- Local filesystem for workspaces and logs.
- Coding-agent executable (`codex app-server` or `claude` headless).
- IRIS REST+SSE endpoint (`POST /api/agent/run`) and Bearer token (`swm_…`).
- Host environment auth: `GITHUB_TOKEN` (PAT or GitHub App installation token with `repo` + `project` scope), agent CLI auth, `IRIS_TOKEN`.

## 4. Core Domain Model (MODIFIED)

### 4.1 Issue (MODIFIED)

Normalized work-item record. Fields:

- `id` (string) — GitHub Projects v2 *project item* node ID. Primary key for orchestrator state.
- `content_id` (string or null) — underlying GitHub Issue or PR node ID. Null for draft items.
- `identifier` (string) — human-readable key. Issues: `<owner>/<repo>#<number>`. Drafts: `draft:<short-hash>`.
- `title` (string)
- `description` (string or null)
- `priority` (integer or null) — from a configurable Project single-select field (default name `Priority`, mapping `P0=1, P1=2, P2=3, P3=4`).
- `state` (string) — value of the configured Project Status field.
- `branch_name` (string or null) — from a `branch:<name>` label, or null.
- `url` (string or null)
- `labels` (list of strings) — lowercase labels on the underlying issue.
- `blocked_by` (list of `{id, identifier, state}`) — from GitHub tracked-by relationships and `blocked-by:<owner>/<repo>#<n>` labels.
- `created_at` / `updated_at` (timestamps).
- `assignees` (list of strings).
- `repo_full_name` (string or null) — `<owner>/<repo>` of the underlying content; determines which repo gets cloned into the workspace.

### 4.2 Live Session (MODIFIED)

Upstream fields plus:

- `agent_kind` (`codex` | `claude_code`).
- `iris_calls_in_turn` (integer).
- `iris_active_container_ids` (list of string).

Other entities (Workflow Definition, Service Config, Workspace, Run Attempt, Retry Entry, Orchestrator Runtime State) are **INHERITED** from upstream §4.

### 4.3 Stable Identifiers (MODIFIED)

- `Issue ID` — project item node ID; tracker lookups and map keys.
- `Issue Identifier` — `<owner>/<repo>#<number>` for issues, `draft:<hash>` for drafts.
- `Workspace Key` — sanitize `identifier` by replacing characters not in `[A-Za-z0-9._-]` with `_`. (`#` and `/` both become `_`, so `ltk-global/symphony#42` becomes `ltk-global_symphony_42`.)
- `Normalized State` — compare Status field values after `lowercase`.
- `Session ID` — `<thread_id>-<turn_id>` for codex; `<session_id>-<turn_seq>` for claude_code.

## 5. Workflow Specification (MODIFIED)

### 5.1 File Discovery (INHERITED)

`WORKFLOW.md` is loaded from CLI-provided path or cwd. Repository-owned, version-controlled.

### 5.2 File Format (INHERITED)

Markdown body with optional YAML front matter, separated by `---` fences. Body is the per-issue prompt template. Front matter must decode to a map. Body is trimmed.

### 5.3 Front Matter Schema (MODIFIED)

Top-level keys (unknown keys ignored for forward compatibility):

- `tracker`
- `polling`
- `workspace`
- `hooks`
- `agent`
- `codex` (only when `agent.kind == "codex"`)
- `claude_code` (only when `agent.kind == "claude_code"`)
- `iris` (NEW)
- `verify` (NEW)
- `server` (optional extension)

#### 5.3.1 `tracker` (MODIFIED)

```yaml
tracker:
  kind: github_projects                    # only supported value in this fork
  endpoint: https://api.github.com/graphql # default
  api_token: $GITHUB_TOKEN                 # PAT or GitHub App installation token

  # Project identification — provide ONE of:
  project_url: https://github.com/orgs/ltk-global/projects/7
  # project_owner: ltk-global              # alternative: org or user login
  # project_number: 7                      # the number from the project URL

  # Field mappings on the project
  status_field: Status                     # default: "Status"
  priority_field: Priority                 # default: "Priority"; null disables

  # Status values
  active_states: [Todo, In Progress]
  terminal_states: [Done, Cancelled, Won't Do]
  needs_human_state: Needs Human            # used by IRIS blocked-event handling

  # Filtering — only items matching ALL filters are dispatched
  filters:
    assignee: ltk-symphony-bot              # optional; only items assigned here
    label_required: []                      # optional; must have all of these
    label_excluded: [wip, do-not-touch]     # optional; must have none of these
```

Notes:

- One of `project_url` OR (`project_owner` + `project_number`) must be supplied.
- The orchestrator does **not** transition statuses itself. The agent does, via its own `gh` CLI / GraphQL tool calls. Verify stage may transition (`needs_human_state` on blocked, on_pass/on_fail transitions in `verify`).
- `needs_human_state` is the destination Status when an IRIS `blocked` event is received and `iris.on_blocked: needs_human` (default). Must exist on the project.

#### 5.3.2 `polling`, `workspace`, `hooks` (INHERITED)

Same as upstream Symphony §5.3.2/3/4. Defaults: `polling.interval_ms: 30000`, `workspace.root: <system-temp>/symphony_workspaces`, `hooks.timeout_ms: 60000`. Hook scripts (`after_create`, `before_run`, `after_run`, `before_remove`) run via `bash -lc` with the workspace as cwd.

A common pattern for this fork's `after_create` hook:

```yaml
hooks:
  after_create: |
    # Clone the repo associated with this issue into the workspace.
    # ${ISSUE_REPO_FULL_NAME} is exported by the orchestrator before hook execution.
    git clone "https://x-access-token:${GITHUB_TOKEN}@github.com/${ISSUE_REPO_FULL_NAME}.git" .
    git checkout -b "${ISSUE_BRANCH_NAME:-symphony/${ISSUE_WORKSPACE_KEY}}"
```

Hook environment (NEW): the orchestrator exports these env vars before running any hook:

- `ISSUE_ID`, `ISSUE_IDENTIFIER`, `ISSUE_TITLE`, `ISSUE_STATE`, `ISSUE_URL`
- `ISSUE_REPO_FULL_NAME`, `ISSUE_BRANCH_NAME` (may be empty)
- `ISSUE_WORKSPACE_KEY`, `ISSUE_WORKSPACE_PATH`
- `SYMPHONY_ATTEMPT` (`null` first run, integer for retry/continuation)

#### 5.3.3 `agent` (MODIFIED)

```yaml
agent:
  kind: claude_code                        # "codex" | "claude_code"
  max_concurrent_agents: 10
  max_turns: 20
  max_retry_backoff_ms: 300000
  max_concurrent_agents_by_state:
    "in progress": 10
    "review-feedback": 5

  tools:
    iris_run:
      enabled: true                        # Model A on/off
      max_calls_per_turn: 10
      allow_profile_override: true
    github:
      enabled: true                        # advertise gh CLI / GraphQL helper tool spec
```

#### 5.3.4 `codex` (INHERITED)

Same as upstream Symphony §5.3.6. Used only when `agent.kind == "codex"`. Pass-through values (`approval_policy`, `thread_sandbox`, `turn_sandbox_policy`) follow the targeted Codex App Server schema.

#### 5.3.5 `claude_code` (NEW)

```yaml
claude_code:
  command: claude                          # default; resolved via PATH
  model: claude-opus-4-7                   # passed as --model
  output_format: stream-json               # required; the only format the adapter parses
  permission_mode: acceptEdits             # "default" | "acceptEdits" | "bypassPermissions" | "plan"
  allowed_tools: [Bash, Read, Edit, Write, WebFetch]
  disallowed_tools: []
  append_system_prompt: |
    You are running as part of Symphony, an orchestrated coding agent fleet. Always update
    GitHub Projects status via the gh tool when you finish a meaningful step. When you need
    to verify a UI or login state, call iris_run.
  max_turns: 50                            # CLI's --max-turns
  read_timeout_ms: 5000
  turn_timeout_ms: 3600000                 # 1 hour
  stall_timeout_ms: 300000                 # 5 minutes; <=0 disables
```

#### 5.3.6 `iris` (NEW)

```yaml
iris:
  enabled: true
  base_url: https://swarmy.firsttofly.com
  token_env: IRIS_TOKEN                    # env var holding swm_… token
  default_profile: claude-default-latest
  profile_overrides:                       # ticket label -> profile name
    "env:prod-readonly": acme-prod-readonly
    "env:blank": claude-default-latest
    "needs-mfa": acme-staging-with-mfa
  max_concurrent: 3                        # SHARED semaphore: A and B both acquire from this
  request_timeout_ms: 600000               # ceiling per IRIS call
  on_blocked: needs_human                  # "needs_human" | "fail" | "pass_through"
  blocked_comment_template: |
    🛑 The agent hit a step requiring a human (captcha, MFA, consent, etc.).
    VNC URL: {{ blocked.vnc_url }}
    Reason: {{ blocked.reason }}
    Solve it in the browser, then move this item back to a state in `active_states`.
```

Profile resolution order (for both Model A and Model B):

1. Explicit `profile` argument from the agent's `iris_run` tool call (Model A only, if `tools.iris_run.allow_profile_override: true`).
2. First matching `profile_overrides` entry whose label is on the issue.
3. `default_profile`.

Container reuse:

- Model A passes `container_id` through from the agent. Default: each `iris_run` call without an explicit `container_id` gets a fresh container.
- Model B always opens a fresh container per verify attempt. Reusing a Model A container in a Model B verify is not supported by default (it would risk state pollution).

`on_blocked` semantics:

- `needs_human` (default): orchestrator transitions the project item Status to `tracker.needs_human_state`, posts `blocked_comment_template` rendered with the SSE `blocked` event, and ends the run cleanly. The agent does **not** see the blocked event in Model A; in Model B, the verify stage exits without a pass/fail.
- `fail`: treat as a normal failure; retry per backoff. Useful for environments where humans aren't available.
- `pass_through`: return the blocked event to the caller (the agent for Model A, the verify-stage parser for Model B). Use only for diagnostic sessions.

#### 5.3.7 `verify` (NEW)

```yaml
verify:
  enabled: true

  # WHEN to verify
  trigger: after_agent_signal              # "always" | "after_agent_signal" | "on_state_transition"
  signal_marker: "VERIFY_REQUESTED"        # used when trigger == after_agent_signal
  trigger_state: "ready-for-verify"        # used when trigger == on_state_transition

  # WHERE to point the browser
  url_source: agent_output                 # string OR ordered list, see §15
  agent_output_key: verify_url             # JSON key in agent's structured last line
  url_label_prefix: "deploy:"              # label prefix on issue or linked PR
  url_static: ""                           # absolute fallback URL

  # HOW to drive IRIS
  profile: ""                              # blank => fall back to iris.default_profile + overrides
  instruction_template: |
    Use swarmy-chrome-agent to navigate to {{ verify_url }}.
    Verify the change described in this ticket is live and working:
    ---
    {{ issue.title }}

    {{ issue.description }}
    ---
    Print a JSON object as the LAST line with keys:
    pass (boolean), summary (string), evidence_url (string|null).

  # WHAT to do with the result
  on_pass:
    transition_to: "In Review"
    comment_template: |
      ✅ Verified by IRIS. {{ result.summary }}
      Evidence: {{ result.evidence_url }}
  on_fail:
    max_attempts: 2
    feedback_template: |
      IRIS verification failed: {{ result.summary }}
      Evidence: {{ result.evidence_url }}
      Please fix and try again.
    final_transition_to: Needs Human
    final_comment_template: |
      ❌ Verification failed {{ verify.attempts }} times.
      Last error: {{ result.summary }}

  on_no_url:
    transition_to: Needs Human
    comment_template: |
      ⚠️ Verify stage couldn't resolve a URL. Tried sources: {{ verify.attempted_sources }}.
```

### 5.4 Prompt Template Contract (INHERITED)

Strict Liquid-compatible rendering. Unknown variables/filters fail rendering. Inputs:

- `issue` (full normalized fields including `labels`, `blocked_by`, `assignees`, `repo_full_name`)
- `attempt` (null on first run, integer on retry/continuation)
- **NEW**: `tools` — object describing which tools are available this turn (`{iris_run: true, github: true}`). The prompt template can branch on these.

Fallback: empty body uses default `You are working on a GitHub project item.`

### 5.5 Validation Errors (INHERITED)

Same error taxonomy as upstream §5.5: `missing_workflow_file`, `workflow_parse_error`, `workflow_front_matter_not_a_map`, `template_parse_error`, `template_render_error`. Configuration errors block dispatch; template errors fail only the affected attempt.

## 6. Configuration Layer (INHERITED)

Source precedence: workflow path → front matter → `$VAR` resolution → defaults. Dynamic reload on `WORKFLOW.md` change. Dispatch preflight validates: workflow loads, `tracker.kind` is `github_projects`, `tracker.api_token` resolves, project identification fields are present, `agent.kind` is supported, agent backend command is non-empty, `iris.token_env` resolves when `iris.enabled`, `verify` config is internally consistent when `verify.enabled`.

## 7. Orchestration State Machine (INHERITED)

Issue orchestration states (`Unclaimed`, `Claimed`, `Running`, `RetryQueued`, `Released`) and run-attempt phases (`PreparingWorkspace` through `CanceledByReconciliation`) are unchanged from upstream §7.

**MODIFIED transition triggers**:

- `Worker Exit (normal)`: in addition to scheduling a 1s continuation retry, if `verify.enabled` and `verify.trigger` matches, transition the run into the verify stage (§15) **before** scheduling the continuation retry. Continuation only happens if verify says `on_fail` and feeds back into the agent.
- New trigger: `Verify Result Received` — handled by §15.
- New trigger: `IRIS Blocked Event` — handled by §14.

## 8. Polling, Scheduling, Reconciliation (INHERITED)

Same loop, candidate selection, concurrency control, retry/backoff, reconciliation as upstream §8. Two **MODIFIED** points:

- Per-state concurrency keys are normalized lowercase Status values from the configured Project Status field (e.g. `"in progress"`).
- The blocker rule applies when the underlying issue references blocking issues that are themselves in non-terminal states. Drafts (no underlying issue) are never blocked.

## 9. Workspace Management and Safety (INHERITED)

Layout, creation/reuse, hooks, and safety invariants (cwd == workspace_path, workspace_path inside workspace_root, sanitized workspace key) carry over verbatim from upstream §9.

## 10. Agent Runner Protocol

### 10.0 AgentRunner Interface (NEW)

```ts
interface AgentRunner {
  start(input: {
    workspacePath: string;
    prompt: string;
    issue: Issue;
    attempt: number | null;
    tools: ToolSpec[];                     // includes iris_run, github when enabled
    abortSignal: AbortSignal;
  }): Promise<AgentSession>;
}

interface AgentSession {
  readonly sessionId: string;
  readonly events: AsyncIterable<NormalizedEvent>;
  startTurn(input: { text: string; toolResults?: ToolResult[] }): Promise<void>;
  cancel(reason: string): Promise<void>;
}

type NormalizedEvent =
  | { kind: 'session_started'; sessionId: string; pid?: number }
  | { kind: 'turn_started'; turnId: string }
  | { kind: 'tool_call'; toolName: string; args: unknown; callId: string }
  | { kind: 'tool_result'; callId: string; result: unknown }
  | { kind: 'message'; text: string; final?: boolean }
  | { kind: 'usage'; inputTokens: number; outputTokens: number; totalTokens: number }
  | { kind: 'turn_completed'; usage?: Usage }
  | { kind: 'turn_failed'; reason: string }
  | { kind: 'turn_cancelled'; reason: string }
  | { kind: 'turn_input_required'; prompt: string }
  | { kind: 'rate_limited'; retryAfterMs: number };
```

Both adapters must produce these normalized events. Adapter-specific raw events MAY be logged to a separate diagnostic stream but MUST NOT leak into the orchestrator's state-machine logic.

### 10a. Codex Adapter (MODIFIED)

Launch: `bash -lc "${codex.command}"` with cwd=workspace.

Handshake (verified against `codex app-server` v0.125.0, 2026-04-29):

1. Client → server: `initialize` request with
   `{protocolVersion: "2024-11-05", capabilities: {}, clientInfo: {name, version}}`.
2. Server → client: id-matched `initialize` result `{userAgent, codexHome,
   platformFamily, platformOs}`. The server does NOT emit a separate
   `initialized` notification (this differs from the older upstream Symphony
   protocol).
3. Client → server: `notifications/initialized` notification (no id).
4. Client → server: `thread/start` request with `{cwd, ...config}`.
5. Server → client: id-matched `thread/start` result `{thread: {id, ...},
   model, ...}`. The server also emits a `thread/started` notification with
   the same thread payload — both carry the canonical thread id.
6. Client → server: `turn/start` request with
   `{threadId, input: [{type: "text", text: <prompt>}]}`. Server responds
   id-matched with the turn record and emits `turn/started` followed by a
   stream of `item/started`, `item/agentMessage/delta`, `item/completed`,
   `thread/tokenUsage/updated`, and finally `turn/completed` (or
   `turn/failed`) notifications.

Continuation turns reuse the captured `threadId` with another `turn/start`
request. Approval/sandbox values pass through under `params` of `thread/start`.

Tool-call mapping: when the agent calls `iris_run` (advertised at `thread/start`
under `tools` if `tools.iris_run.enabled`), the adapter intercepts the
tool call, invokes IrisClient (§14), waits for completion, and returns the
result via the protocol's tool-result message. The adapter normalizes the slash
notification names (`thread/started`, `turn/completed`, `item/completed`, etc.)
to the standard `NormalizedEvent` vocabulary; `item/agentMessage/delta` chunks
are accumulated and emitted as a single `message{final:true}` when the matching
`item/completed` arrives.

### 10b. Claude Code Adapter (NEW)

Launch contract:

- Command: `${claude_code.command} --output-format stream-json --print "<initial prompt>" \\
  --model ${claude_code.model} --permission-mode ${claude_code.permission_mode} \\
  --allowed-tools "${claude_code.allowed_tools | join(',')}"` (and `--disallowed-tools` if non-empty).
- Stream protocol: NDJSON on stdout. Each line is a JSON event from Claude Code's stream-json format.
- Continuation turns: re-invoke `claude --resume <session_id> --print "<continuation guidance>" --output-format stream-json`. The session_id comes from the first event of kind `system` with `subtype: init` in the first invocation's stream.

Stream-json event mapping (raw → normalized):

| Raw `type` | Raw `subtype` | Normalized |
|---|---|---|
| `system` | `init` | `session_started` (extract `session_id`) |
| `assistant` | — | `message` (text from content blocks) |
| `assistant` (with tool_use block) | — | `tool_call` (one per tool_use block) |
| `user` (with tool_result block) | — | `tool_result` |
| `result` | `success` | `turn_completed` (extract `usage`) |
| `result` | `error_during_execution` | `turn_failed` |
| `result` | `error_max_turns` | `turn_failed` (reason: `max_turns`) |

Tool advertising: when `tools.iris_run.enabled`, the adapter prepends an `append_system_prompt` block describing `iris_run` and registers a local MCP server stub that the Claude Code subprocess can call. The MCP stub is an in-process JSON-RPC server listening on a Unix socket; it forwards `iris_run` calls to IrisClient. Same pattern for the `github` tool.

User-input-required handling: if Claude Code emits a `result` with `subtype: error_during_execution` and the message indicates user input is required, normalize to `turn_input_required` and fail the run attempt (consistent with upstream §10.5 hard-failure-on-user-input policy).

### 10.6 Timeouts and Error Categories (INHERITED, extended)

In addition to upstream's normalized error categories, this fork adds:

- `iris_unavailable` — IRIS REST endpoint unreachable.
- `iris_blocked_unhandled` — IRIS returned a blocked event but `on_blocked: pass_through` was set and the caller didn't handle it.
- `verify_no_url` — Verify stage couldn't resolve a URL from any configured source.
- `verify_failed_terminal` — Verify exhausted `on_fail.max_attempts`.

## 11. Issue Tracker Integration — GitHub Projects (v2) (MODIFIED)

### 11.1 Required Operations

The adapter must implement:

1. `fetch_candidate_issues()` → list of project items whose Status field is in `tracker.active_states`.
2. `fetch_issues_by_states(state_names)` → used at startup to find terminal-state items for workspace cleanup.
3. `fetch_issue_states_by_ids(issue_ids)` → used in reconciliation to refresh the Status field for currently-running items.

### 11.2 Query Semantics

GraphQL endpoint: `tracker.endpoint` (default `https://api.github.com/graphql`). Auth: `Authorization: Bearer ${tracker.api_token}`.

Project resolution at startup:

- If `project_url` is provided, parse it: `/orgs/<org>/projects/<n>` or `/users/<user>/projects/<n>`.
- Resolve to a project node ID via `organization(login: $org).projectV2(number: $n) { id }` or the user variant.
- Cache the project node ID for the lifetime of the process; refresh on workflow reload.

Candidate item query (paginated, 50/page):

```graphql
query Candidates($projectId: ID!, $cursor: String) {
  node(id: $projectId) {
    ... on ProjectV2 {
      items(first: 50, after: $cursor) {
        pageInfo { hasNextPage endCursor }
        nodes {
          id
          fieldValues(first: 20) {
            nodes {
              ... on ProjectV2ItemFieldSingleSelectValue {
                name
                field { ... on ProjectV2SingleSelectField { name } }
              }
            }
          }
          content {
            ... on Issue {
              id number title body url state createdAt updatedAt
              repository { nameWithOwner }
              labels(first: 50) { nodes { name } }
              assignees(first: 20) { nodes { login } }
              trackedInIssues(first: 20) { nodes { id number state repository { nameWithOwner } } }
            }
            ... on PullRequest {
              id number title body url state createdAt updatedAt
              repository { nameWithOwner }
              labels(first: 50) { nodes { name } }
            }
            ... on DraftIssue {
              id title body createdAt updatedAt
            }
          }
        }
      }
    }
  }
}
```

### 11.3 Normalization Rules

- Read the Status field by matching `status_field` (default `Status`) against the field `name`.
- Read the Priority field by matching `priority_field` if configured; map values per workflow's mapping (default `P0..P3 → 1..4`).
- `labels` lowercased.
- `blocked_by`: union of `trackedInIssues` (with non-terminal `state`) plus issues parsed from `blocked-by:<owner>/<repo>#<n>` labels. Each entry is `{id, identifier, state}`.
- `identifier` for issues/PRs: `<repository.nameWithOwner>#<number>`. For drafts: `draft:<first-8-of-id>`.
- Drafts have no labels, assignees, or repo; `repo_full_name` is null.

### 11.4 Filtering

Apply `tracker.filters` as a post-fetch filter:

- `assignee`: keep only items whose `assignees` list contains the configured login. Drafts are excluded if this filter is set.
- `label_required`: keep only items containing **all** configured labels (lowercase).
- `label_excluded`: drop items containing **any** configured label.

### 11.5 Tracker Writes

The orchestrator only writes to the tracker via the verify stage (Status transitions and item comments configured under `verify.on_pass`/`on_fail`/`on_no_url`) and the IRIS-blocked handler (`needs_human_state` transition + comment).

All other tracker writes — moving to `In Progress` when starting work, posting PR links, leaving review feedback — are performed by the agent using its own tools (`gh` CLI, GraphQL helper, etc.). The agent prompt template is responsible for instructing the model to do so.

### 11.6 Error Categories

- `unsupported_tracker_kind` (only `github_projects` is supported)
- `missing_github_token`
- `missing_project_identification`
- `project_not_found`
- `status_field_not_found`
- `github_api_request` (transport)
- `github_api_status` (non-200)
- `github_graphql_errors`
- `rate_limited` — back off using `X-RateLimit-Reset` header; do not crash.

## 12. Prompt Construction (INHERITED)

Same as upstream §12. Template inputs: `issue`, `attempt`, plus this fork's `tools` object. Render with strict variable/filter checking.

## 13. Logging, Status, Observability (MODIFIED)

Required context fields for issue-related logs: `issue_id`, `issue_identifier`. For session lifecycle: `session_id`, `agent_kind`. For IRIS calls: `iris_call_id`, `iris_container_id`, `iris_path` (`A` or `B`).

### 13.1 Data Directory (NEW)

Each daemon owns a per-workflow data directory used for durable observability.

- Default: `~/.symphony/<sha256(absolute_workflow_path)[0:12]>/`. Different
  workflows on the same host get distinct dirs without configuration.
- Override: `data_dir:` top-level key in `WORKFLOW.md` front matter. Accepts
  `~`, absolute paths, and `$VAR` references resolved against the process env.
- The orchestrator creates this directory lazily on first write. Operators
  MAY pre-create it to control mode/ownership.

### 13.2 Event Log (NEW)

The runtime writes an append-only structured event log to
`<data_dir>/events.jsonl`. Each line is a single JSON object with the shape:

```json
{
  "ts": "2026-04-29T17:21:53.748Z",
  "type": "turn_completed",
  "issueId": "PVI_1",
  "issueIdentifier": "ltk-global/symphony#42",
  "sessionId": "thread-1-turn-1",
  "payload": { "...": "..." }
}
```

Required event types (orchestrator-side):

- `daemon_reload` — config (re)load with workflow path and data dir
- `issue_dispatched`, `dispatch_failed`, `dispatch_aborted`
- `workspace_prepared`
- `agent_session_started`, `turn_started`, `turn_completed`, `turn_failed`,
  `turn_cancelled`, `turn_input_required`
- `agent_message`, `agent_tool_call`
- `iris_call_started`, `iris_call_completed`, `iris_call_failed`,
  `iris_blocked_handed_off`, `iris_call_limit_exceeded`
- `verify_triggered`, `verify_result`, plus internal verify events emitted by
  the verify stage (`verify_iris_call_started`, `verify_iris_call_completed`,
  `verify_passed`, `verify_retry`, `verify_terminal_failed`,
  `verify_blocked`, `verify_no_url`)
- `retry_scheduled`, `retry_fired`, `retry_abandoned`
- `session_released`, `session_stalled_cancelled`, `status_drift_detected`,
  `status_transition_orchestrator`

Implementations MAY add additional event types. Consumers MUST tolerate
unknown types and unknown payload keys for forward compatibility.

Write semantics:

- Writes are serialized per process (no interleaved partial lines).
- `appendFile` errors do NOT crash the daemon; they are logged via the
  structured logger.
- Rotation/retention is operator-controlled (logrotate, etc.). The daemon
  does not rotate the file itself.

### 13.3 Raw Agent Stream Capture (NEW)

For post-mortem of a misbehaving agent, the runtime tees the raw protocol
stream of every agent turn to:

```
<data_dir>/turns/<sanitized_issue_id>/<iso-timestamp>-t<turnSeq>.jsonl
```

- `claude_code` adapter: each subprocess spawn (initial + every `--resume`)
  writes one file containing the raw `--output-format stream-json` lines.
- `codex` adapter: each `turn/start` rotates to a new file. The file
  contains both client-to-server JSON-RPC requests (prefixed `>>> `) and
  server-to-client notifications (prefixed `<<< `) so the full conversation
  can be reconstructed.

The orchestrator emits a `turn_recording_started` event with the file `path`
each time a sink is opened, allowing operators to find the right file via
`grep turn_recording_started events.jsonl`.

Rotation/retention is operator-controlled.

### 13.5 Event Hooks (NEW — extension)

The fork supports operator-defined alerting hooks that fire on event-log
emissions. Hooks are observability-only (failures NEVER block the daemon).

Front-matter shape:

```yaml
hooks:
  on_event:
    - name: paging-on-blocked
      types: [iris_blocked_handed_off, dispatch_failed]
      script: |
        curl -fsS -XPOST "$SLACK_WEBHOOK" \
          -d "{\"text\":\"$SYMPHONY_ISSUE_IDENTIFIER · $SYMPHONY_EVENT_TYPE\"}"
      timeout_ms: 5000

    - name: archive-everything
      types: ["*"]
      script: echo "$SYMPHONY_EVENT_PAYLOAD" >> /var/log/symphony/all.jsonl
```

Each rule:

- `name` (optional) — identifier used in failure logs.
- `types` (required, non-empty) — list of event-log type names; `"*"`
  matches all.
- `script` (required) — runs via `bash -lc`.
- `timeout_ms` (default 10000) — kills the script with SIGKILL if it
  hasn't exited.

Environment variables provided to the script:

- `SYMPHONY_EVENT_TYPE` — e.g. `iris_blocked_handed_off`
- `SYMPHONY_EVENT_TS` — ISO 8601 timestamp
- `SYMPHONY_ISSUE_ID` — present if the event names an issue
- `SYMPHONY_ISSUE_IDENTIFIER` — present if the event names an issue
- `SYMPHONY_SESSION_ID` — present for session-scoped events
- `SYMPHONY_TURN_SEQ` — present when the event references a turn
- `SYMPHONY_EVENT_PAYLOAD` — full payload, JSON-encoded (or `{}`)

Failure semantics:

- Hooks run fire-and-forget. The daemon does NOT await them.
- A hook that exits non-zero, errors during spawn, or hits the timeout is
  logged at warn level (`event hook exited non-zero` / `event hook timed
  out — killing`) and otherwise ignored.
- Hooks observe events that have already been written to `events.jsonl`,
  so a hook crash never loses a trace entry.

### 13.6 Cross-Daemon Aggregator (NEW — extension)

For Pattern B deployments where multiple daemons run on one host (or one
network), the fork ships a `symphony-aggregator` bin that polls each
daemon's `GET /api/v1/state` and serves a unified dashboard.

```bash
symphony-aggregator --config /etc/symphony/aggregator.yaml
```

Aggregator config shape:

```yaml
port: 9000                         # default 9000
host: 127.0.0.1                    # default loopback
poll_interval_ms: 5000             # default 5000
poll_timeout_ms: 3000               # default 3000 — per daemon
recent_events_limit: 50             # default 50
refresh_interval_sec: 5             # default 5 — HTML auto-refresh
daemons:
  - name: projA
    url: http://127.0.0.1:8787
  - name: projB
    url: http://127.0.0.1:8788
```

Endpoints:

| Method | Path | Returns |
|---|---|---|
| GET | `/` | Unified dashboard. Daemon health row, sessions table tagged with daemon name (rows link out to that daemon's per-issue page in a new tab), retry queue, ts-merged recent events feed. |
| GET | `/api/v1/state` | `{ generatedAt, counts, tokens, daemons[], recentEvents }` — `daemons[]` carries `reachable`, `lastSeenAt`, `lastFailureAt`, `lastError`, full per-daemon `state` snapshot. |
| POST | `/api/v1/refresh` | 202; queues an immediate poll round. |

Resilience:

- Each daemon is polled independently; one daemon being down marks just
  that daemon `reachable: false` with `lastError`. The aggregator keeps
  serving the live data from healthy daemons.
- The aggregator does NOT proxy to per-issue pages or raw turn captures —
  those links open the originating daemon's console directly. This keeps
  the aggregator stateless beyond polling cache.
- Timeouts default to 3s; misconfigured daemons can't block the poll
  cycle.

### 13.7 Operator Console HTTP Server (IMPLEMENTED — extension)

The fork implements the §13.7 HTTP extension from upstream. It is OPTIONAL
and disabled by default; turn it on with either:

- workflow front matter: `server: { port: 8787 }`
- CLI flag: `--port 8787` (overrides front matter)

The server binds to `127.0.0.1` by default. Override host via
`server.host` in front matter. Refresh cadence is `server.refresh_interval_sec`
(default 5) for the auto-refreshing HTML, and `server.recent_events_limit`
(default 50) for how many events to tail on the index page.

#### Endpoints

| Method | Path | Returns |
|---|---|---|
| GET | `/` | HTML dashboard — running sessions table, retry queue, recent events feed, header strip with cumulative metrics |
| GET | `/issues/<identifier>` | HTML per-issue page — facts, full event timeline grouped by session, links to raw turn captures |
| GET | `/issues/<identifier>/turns/<filename>` | HTML viewer for a single raw turn JSONL file |
| GET | `/api/v1/state` | JSON `{ generatedAt, workflowPath, dataDir, counts, running, retrying, codexTotals, recentEvents }` |
| GET | `/api/v1/issues/<identifier>` | JSON `{ identifier, issueId, live, retry, events, turnFiles }` |
| POST | `/api/v1/refresh` | 202 + `{ queued: true, requestedAt, operations: ["poll", "reconcile"] }`. Triggers an immediate `Orchestrator.tick()`. |

Path segments are decoded individually after route matching (not on the
full pathname) and rejected if they contain `/`, `\`, `..`, or NUL — so an
encoded traversal like `..%2F..%2Fevents.jsonl` returns 400 rather than
escaping the data dir.

The HTML is fully server-rendered; the only client-side JS is a 30-line
relative-time formatter that updates `data-rel-ts` and `data-due-ts`
attributes once per second. Auto-refresh uses `<meta http-equiv="refresh">`,
not WebSockets or SSE.

### 13.6 Snapshot Interface (MODIFIED)

`Orchestrator.snapshot()` returns the live state suitable for dashboards and
the future HTTP `/api/v1/state` endpoint:

```ts
{
  running: number;
  runningSessions: Array<{
    issueId: string;
    identifier: string;
    state: string;
    sessionId?: string;
    attempt: number | null;
    startedAtMs: number;
    lastEventAtMs: number;
    turnCount: number;
    lastEventKind?: string;     // last NormalizedEvent kind seen on this session
    lastMessage?: string;       // last final agent message, truncated to 1000 chars
    tokens: { inputTokens: number; outputTokens: number; totalTokens: number };
    workspacePath?: string;
  }>;
  retrying: Array<{
    issueId: string;
    identifier: string;
    attempt: number;
    dueAtMs: number;            // unix ms when the retry timer fires
    error: string | null;       // short reason captured at scheduling time
  }>;
  codexTotals: { inputTokens: number; outputTokens: number; totalTokens: number };
}
```

Future extensions (not yet implemented):

- `iris`: `{ active: int, queued: int, max_concurrent: int, blocked_count: int }`
- `verify`: `{ active: int, last_pass_count: int, last_fail_count: int }`

## 14. IRIS Integration (NEW)

### 14.1 IrisClient Interface

```ts
interface IrisClient {
  run(input: {
    instruction: string;
    profile: string;
    containerId?: string;
    timeoutMs?: number;
    abortSignal?: AbortSignal;
    onEvent?: (e: IrisEvent) => void;       // raw SSE pass-through, used by verify-stage logging
  }): Promise<IrisRunResult>;
}

// Wire shapes below match the actual Swarmy SSE format observed at
// swarmy.firsttofly.com (verified 2026-04-29). They diverge from upstream
// Symphony's documented shapes, hence MODIFIED:
//   - `result` carries `content` (not `output`).
//   - `done` has no `status` field; final status is inferred client-side from
//     prior events (a prior `result` ⇒ "success"; a prior `blocked` ⇒
//     "blocked"; otherwise "error").
//   - `ready` includes `phase`, `worker_id`, `web_ui_url`, and `vnc_url`
//     alongside `container_id`. The `blocked` event's `vnc_url` is identical
//     to the one already advertised in `ready`.
//   - `progress` has `phase` plus `message`.
// The IrisClient parser is tolerant — unknown fields land in `events[]` and
// known fields are extracted defensively.
type IrisEvent =
  | { event: 'ready'; container_id: string; vnc_url?: string; phase?: string; worker_id?: string; web_ui_url?: string }
  | { event: 'progress'; phase?: string; message?: string }
  | { event: 'activity'; tool?: string; data?: unknown }
  | { event: 'delta'; content?: string }
  | { event: 'result'; content?: string; container_id?: string }
  | { event: 'done'; status?: 'success' | 'error' | 'blocked' }
  | { event: 'blocked'; vnc_url?: string; reason?: string };

interface IrisRunResult {
  status: 'success' | 'error' | 'blocked';
  containerId: string;
  result: string;                          // last line of agent stdout (Pattern 1) or full transcript
  blocked?: { vncUrl: string; reason: string };
  events: IrisEvent[];                     // captured timeline
}
```

### 14.2 Transport

- HTTP `POST ${iris.base_url}/api/agent/run`.
- Headers: `Authorization: Bearer ${iris token}`, `Content-Type: application/json`, `Accept: text/event-stream`.
- Body: `{ instruction, profile, container_id? }`.
- Response: SSE stream. Parse events until `done`.
- On `blocked` event: capture `vnc_url` and `reason`, continue reading until `done`, then return.

Timeouts:

- `iris.request_timeout_ms` ceiling enforced by the client (abort the fetch on expiry).
- An additional read-stall timer (default 60s with no events received) aborts and surfaces `iris_unavailable`.

### 14.3 Concurrency Semaphore

- One process-wide semaphore sized by `iris.max_concurrent`.
- Both Model A and Model B `run()` calls acquire from this semaphore.
- Acquisition is FIFO. Acquisition blocks (with the abort signal honored) until a slot is free.
- Blocking on this semaphore must NOT block the orchestrator's poll tick. IRIS calls always run on background tasks; the orchestrator records them in the live session metadata and continues polling.

### 14.4 Model A — `iris_run` Tool

Tool spec advertised to the agent at session start when `agent.tools.iris_run.enabled: true`:

```json
{
  "name": "iris_run",
  "description": "Run a natural-language instruction against a real headful Chrome browser via IRIS. Use this whenever you need to verify a UI state, log into a site, scrape a logged-in page, or test a deployed change. Each call returns the agent's last line of stdout — instruct IRIS in your prompt to print structured output as the LAST line.",
  "input_schema": {
    "type": "object",
    "properties": {
      "instruction": {"type": "string", "description": "Self-contained: include full URL with scheme, concrete actions, and an explicit output format (Pattern 1/2/3 from IRIS docs). Reference 'swarmy-chrome-agent' to keep the agent routed through the browser."},
      "profile": {"type": "string", "description": "Optional. Override the resolved default profile."},
      "container_id": {"type": "string", "description": "Optional. Pass a container_id from a previous iris_run result to reuse the same Chrome session for a follow-up."}
    },
    "required": ["instruction"]
  }
}
```

Agent-side flow (Codex path — adapter intercepts directly):

1. Agent emits a `tool_call` for `iris_run` with arguments.
2. Adapter increments `iris_calls_in_turn`. If `> max_calls_per_turn`, return a tool error `iris_run_call_limit_exceeded` and continue the turn.
3. Adapter resolves `profile` per §5.3.6 resolution order.
4. Adapter calls `IrisClient.run()`. Adds returned `containerId` to `iris_active_container_ids`.
5. On `done: success`: return `{result, container_id, events}` to the agent as a tool result.
6. On `done: error`: return `{error, events}` as a tool error; agent decides what to do.
7. On `done: blocked`:
   - If `iris.on_blocked == "needs_human"`: do NOT return a tool result. Cancel the agent session, transition the project item Status to `tracker.needs_human_state` via the GitHub adapter, post the rendered `blocked_comment_template` as an item comment, and emit `turn_failed` with reason `iris_blocked_handed_off`. Orchestrator releases the claim normally; the item leaves `active_states`.
   - If `iris.on_blocked == "fail"`: return tool error and let the agent fail the turn; orchestrator retries per backoff.
   - If `iris.on_blocked == "pass_through"`: return `{blocked: {...}, events}` to the agent as a tool result; agent decides.

Claude Code path (MCP-routed). The Claude subprocess calls
`mcp__symphony__iris_run` against an in-process MCP server (`claude_iris_mcp.ts`)
spawned per Claude session. Because the adapter cannot intercept MCP tool calls
mid-flight, enforcement happens inside the MCP server, parameterized via env
vars set by the orchestrator (`SYMPHONY_IRIS_MAX_CALLS_PER_TURN`,
`SYMPHONY_IRIS_ALLOW_PROFILE_OVERRIDE`, `SYMPHONY_IRIS_ON_BLOCKED`,
`SYMPHONY_BLOCKED_MARKER_PATH`). The MCP server is freshly spawned for each
turn (the adapter re-launches `claude --resume` per turn), so a process-local
counter is equivalent to the per-turn cap. Concurrency continues to share the
single `iris.max_concurrent` semaphore via a filesystem-backed semaphore keyed
on `SYMPHONY_IRIS_SHARED_SEMAPHORE_KEY`.

`on_blocked` semantics on the Claude path:

- `needs_human`: the MCP server writes a JSON marker to
  `${workspace}/.symphony/iris-blocked.json` containing `{vncUrl, reason,
  writtenAt}` and returns a JSON-RPC error to Claude. The orchestrator
  consumes the marker after the session ends, transitions Status to
  `tracker.needs_human_state`, posts `blocked_comment_template`, and skips the
  retry. The marker is unlinked after consumption.
- `fail`: MCP returns a JSON-RPC error to Claude (no marker); the agent's turn
  fails and the orchestrator retries per backoff.
- `pass_through`: MCP returns the blocked result to Claude as a normal tool
  result; the agent decides.

### 14.5 Model B — Verify-Stage Calls

The verify stage calls `IrisClient.run()` directly (see §15). Same semaphore, same blocked-event policy. Verify never reuses an agent's container.

## 15. Verify Stage (NEW)

### 15.1 When Verify Runs

Driven by `verify.trigger`:

- `always`: every successful `turn_completed` event from the agent triggers verify.
- `after_agent_signal`: parse the agent's last `message` event of the turn for `verify.signal_marker` (substring match on the trimmed last line). If present, run verify.
- `on_state_transition`: when the orchestrator's tracker reconciliation observes the item's Status change to `verify.trigger_state`, run verify. (This trigger does NOT depend on agent turn completion; it can fire on a polling tick where the agent isn't running.)

Verify runs **after** the agent turn ends. If the agent is mid-turn making Model A `iris_run` calls, verify waits until the turn completes. Verify and the orchestrator's continuation-retry are mutually exclusive: if verify runs and passes, the continuation retry is skipped (the item has moved on); if verify runs and fails, the failure feedback is queued as the next turn's continuation guidance.

### 15.2 URL Resolution

`url_source` is either a single string or an ordered list. Resolution iterates through the list:

```ts
async function resolveVerifyUrl(issue: Issue, lastTurn: TurnTranscript, cfg: VerifyConfig):
    Promise<{url: string, source: string} | null> {
  const sources = Array.isArray(cfg.url_source) ? cfg.url_source : [cfg.url_source];
  const attempted: string[] = [];
  for (const src of sources) {
    attempted.push(src);
    let url: string | null = null;
    if (src === 'agent_output') url = parseAgentLastLineKey(lastTurn, cfg.agent_output_key);
    else if (src === 'label')   url = parseLabelWithPrefix(issue, cfg.url_label_prefix);
    else if (src === 'static')  url = cfg.url_static || null;
    if (url) return {url, source: src};
  }
  return null; // triggers on_no_url
}
```

Source semantics:

- `agent_output`: take the agent's last `message` event with `final: true` for the turn. Take the last non-empty line. Parse as JSON. If parsing succeeds and the JSON is an object containing the configured `agent_output_key` whose value is a non-empty string starting with `http://` or `https://`, return it. Otherwise this source returns null.
- `label`: scan the underlying issue's labels (lowercase) for one starting with `url_label_prefix` (case-insensitive). Strip the prefix; the remainder must be a valid HTTP(S) URL.
- `static`: return `url_static` if non-empty.

### 15.3 Execution

1. Resolve URL per §15.2. If null, run `on_no_url` (transition + comment) and exit.
2. Resolve profile: `verify.profile` if set, else `iris.default_profile` plus label overrides.
3. Render `instruction_template` with `{ verify_url, issue }`.
4. Acquire IRIS semaphore.
5. Call `IrisClient.run({instruction, profile})` — fresh container, no `container_id`.
6. On `blocked`: handle per `iris.on_blocked` (default: transition to `needs_human_state`, comment, end verify with no pass/fail).
7. On `success`: parse the last line of `result` as JSON. Expected keys: `pass` (boolean), `summary` (string), optional `evidence_url`.
   - Parse failure → treat as fail with `summary: "verify result was not parseable JSON: <last 200 chars>"`.
8. If `pass: true`: render and post `on_pass.comment_template`, transition Status to `on_pass.transition_to`. Done.
9. If `pass: false`:
   - Increment per-issue verify attempts counter.
   - If `attempts < on_fail.max_attempts`: render `on_fail.feedback_template` and queue it as the **next turn's continuation guidance** for the agent. The orchestrator schedules a normal continuation retry (the agent gets the feedback as input); verify will re-trigger again on the next `turn_completed` per `verify.trigger`.
   - If `attempts >= on_fail.max_attempts`: render `final_comment_template`, transition Status to `final_transition_to`, reset the per-issue counter, and exit.

### 15.4 State

Verify state is stored on the orchestrator's in-memory `OrchestratorRuntimeState.verify[issueId]`:

```ts
interface VerifyEntry {
  attempts: number;                        // monotonically increasing within a "fix loop"
  lastResult: {pass: boolean, summary: string, evidenceUrl?: string} | null;
  lastSource: string | null;               // which url_source resolved last time
}
```

Reset to zero on `on_pass` and on `final_transition_to`. Persist across continuation retries within the same fix loop.

### 15.5 Concurrency

Verify acquires from `iris.max_concurrent` like Model A. A separate `verify.max_concurrent` cap (default: equals `iris.max_concurrent`) bounds how many verify stages run simultaneously, since they each hold an IRIS slot.

## 16. Safety, Trust, Privacy (MODIFIED)

Inherits upstream §9.5 safety invariants. Adds:

- IRIS Bearer tokens (`swm_…`) MUST come from `iris.token_env`, never from `WORKFLOW.md` literal values. The orchestrator validates this at preflight.
- IRIS `instruction` strings rendered from issue content MUST escape out anything that could exfil credentials. Tool callers SHOULD treat issue `description` as untrusted input when interpolating into IRIS instructions; the verify stage's default template embeds it inside a fenced `---` block to discourage interpretation as orchestrator-level instructions.
- The agent runs with the project's GITHUB_TOKEN scoped to the configured repos only. The orchestrator does NOT pass `GITHUB_TOKEN` into the IRIS instruction body unless `verify.instruction_template` explicitly references it (and even then, prefer profile-baked auth over token passthrough).

## 17. Implementation Notes (TypeScript Reference)

- Runtime: Node 22+, TypeScript 5.4+, ESM.
- Key deps: `undici` for HTTP/SSE, `graphql-request` or `@octokit/graphql` for GitHub, `zod` for config validation, `yaml` for front matter, `liquidjs` for templates, `pino` for structured logs, `commander` for CLI.
- Process model: single Node process. Workers are `AbortController`-scoped async loops, one per running issue. The agent subprocess is managed via `node:child_process` with stdio piped.
- Restart recovery: on startup, run §11 startup terminal cleanup, then begin polling. No durable orchestrator state; in-flight runs at the moment of restart are abandoned and will be re-claimed on the next tick.
- File layout (recommended):
  - `src/cli.ts` — entry point, `commander` setup.
  - `src/orchestrator/` — poll loop, dispatch, reconciliation, retry queue.
  - `src/workflow/` — loader, config layer, watcher.
  - `src/tracker/github_projects.ts` — adapter.
  - `src/agent/` — `AgentRunner` interface, `codex.ts`, `claude_code.ts`.
  - `src/iris/` — `IrisClient`, semaphore, SSE parser.
  - `src/verify/` — verify stage, URL resolver, JSON parser.
  - `src/workspace/` — sanitization, hooks runner.
  - `src/log.ts` — pino setup with shared context.

## 18. Open Questions

- Multi-repo dispatch: a single Project can have items from many repos. Today the orchestrator handles this via `issue.repo_full_name` and a workspace-per-item. Should there be an optional `tracker.repos_allow_list` to restrict which repos this orchestrator instance will clone and run agents for?
- Verify retry on `iris_unavailable` distinct from `pass: false`: should we add a `on_iris_error` block separate from `on_fail` so transient IRIS outages don't burn fix attempts?
- Cross-fork `linear_graphql` analogue: Symphony exposes `linear_graphql` as a client-side tool to avoid token leakage. We should add an equivalent `github_graphql` tool (with the orchestrator's `GITHUB_TOKEN` scoped to the project's repos) for the same reason. Sketched in §5.3.3 `agent.tools.github` but not fully specified yet.

---

End of SPEC v0.1.
