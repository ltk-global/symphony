# Symphony Onboarding

This is the operator's guide for getting Symphony running and adding repos.
For protocol/architecture details see `SPEC.md`; for the deltas this fork
implements see `docs/IMPLEMENTATION.md`.

## What Symphony does in one paragraph

Symphony is a single Node daemon that polls **one GitHub Project (v2)**, picks
items in `active_states`, clones the issue's repo into a workspace, and runs a
coding agent (Claude Code or Codex) on it. The agent itself moves Project
Status, opens PRs, and posts comments via `gh`. Symphony only writes back to
the Project for verify outcomes and IRIS-blocked transitions. There is no
database; restart recovery comes from re-reading the tracker.

## Two operating patterns

| Pattern | One Project, many repos | One Project per repo |
|---|---|---|
| Daemons | 1 | N |
| Workflows | 1 (generic prompt) | N (per-repo prompts) |
| Repos served | many — Symphony clones whatever repo each item came from | one (or a tightly related set) |
| Best for | starting out, mixed bag of repos | per-repo IRIS profiles, distinct build/deploy commands, hard isolation |

Start with **one Project, many repos**. Move repos out into their own daemon
when their workflow body diverges enough that the prompt is full of `if repo
== ...` branching.

## First-time machine setup

```bash
git clone https://github.com/ltk-global/symphony && cd symphony
./scripts/setup.sh
```

`setup.sh` checks Node 22+, runs `npm ci`/`npm install`, builds `dist/`, and
prints the remaining manual steps:

1. Install the agent CLI: `npm install -g @anthropic-ai/claude-code` (or
   whatever installs your `codex` binary).
2. Install + auth `gh`: `brew install gh && gh auth login --scopes 'repo,project,read:project'`.
3. Export `GITHUB_TOKEN` (and `IRIS_TOKEN` if you'll enable IRIS).
4. Author or copy a `WORKFLOW.md` for your project.
5. Run `./scripts/preflight.sh <path>` before starting the daemon.

## Adding a new repo

### Pattern A — One Project, many repos

1. **Pick a Project.** Note its URL — that's `tracker.project_url`.
2. **Pull the repo's issues into the Project.**
   - GitHub UI: project → "+ Add item" → paste issue URL.
   - One-off CLI: `gh project item-add <number> --owner <owner> --url <issue-url>`.
   - Auto: in the Project's *Workflows* tab, enable "Auto-add to project" for the
     repo (optionally label-filtered).
3. **Make sure the Project has the Status field** with the values you listed
   in `active_states`, `terminal_states`, and `needs_human_state`. Spelling
   matters; comparison is case-insensitive but the human-visible state name
   must exist.
4. **Optional but strongly recommended:** assign the issues you want
   auto-handled to a bot user, and set `tracker.filters.assignee: <bot-login>`.
   Without this, the daemon picks up *every* item in `active_states`.
5. **No daemon restart needed** if the workflow file didn't change. Hot
   reload kicks in on `WORKFLOW.md` mtime change *while no sessions are
   live*.

### Pattern B — Dedicated daemon for a repo

1. Create a new Project for that repo (or reuse one that's already isolated).
2. Copy `examples/WORKFLOW.example.md` to a new path and edit:
   - `tracker.project_url`
   - `tracker.filters.assignee`
   - `iris.default_profile` and `profile_overrides` (or set `iris.enabled: false`)
   - `verify.url_static`
   - The prompt body — repo-specific build/test/deploy commands, branch
     conventions, hard rules.
3. Run a separate daemon with `--workflow <new path>`. Each daemon has its
   own `agent.max_concurrent_agents` budget and its own `workspace.root`
   (use distinct roots if you don't want them stomping on each other).

## Validate before starting

```bash
./scripts/preflight.sh /path/to/WORKFLOW.md
```

Preflight does **not** dispatch any agent. It:

- Parses front matter and runs full schema validation (catches typos, missing
  required keys, bad enum values).
- Checks env vars are set for the things the workflow says it uses
  (`GITHUB_TOKEN` always, `IRIS_TOKEN` only if `iris.enabled: true`).
- Checks `claude` / `codex` / `git` / `gh` are on PATH.
- Hits the GitHub GraphQL API once: lists eligible candidates in
  `active_states`. This catches token scope issues, wrong project URL, and
  missing Status field values.

Run preflight on every config change. Any non-zero exit means the daemon
will refuse to start (config) or fail at first tick (tracker).

## Running the daemon

### Foreground (development)

```bash
GITHUB_TOKEN=ghp_... LOG_LEVEL=info \
  node dist/src/cli.js --workflow /path/to/WORKFLOW.md
```

### One tick and exit (manual sweep / cron)

```bash
node dist/src/cli.js --workflow /path/to/WORKFLOW.md --once
```

`--once` will *dispatch* anything that's eligible. Don't use it as a
preflight — use `scripts/preflight.sh` for that.

### Long-running service

There's no Dockerfile or service unit shipped. Two minimal recipes:

#### macOS launchd

`~/Library/LaunchAgents/com.ltk.symphony.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.ltk.symphony</string>
  <key>ProgramArguments</key><array>
    <string>/usr/local/bin/node</string>
    <string>/Users/you/symphony/dist/src/cli.js</string>
    <string>--workflow</string>
    <string>/Users/you/work/WORKFLOW.md</string>
  </array>
  <key>EnvironmentVariables</key><dict>
    <key>GITHUB_TOKEN</key><string>ghp_...</string>
    <key>LOG_LEVEL</key><string>info</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>/tmp/symphony.out.log</string>
  <key>StandardErrorPath</key><string>/tmp/symphony.err.log</string>
</dict></plist>
```

`launchctl load -w ~/Library/LaunchAgents/com.ltk.symphony.plist`

#### Linux systemd

`/etc/systemd/system/symphony.service`:

```ini
[Unit]
Description=Symphony orchestrator
After=network-online.target

[Service]
ExecStartPre=/opt/symphony/scripts/preflight.sh /opt/symphony/WORKFLOW.md
ExecStart=/usr/bin/node /opt/symphony/dist/src/cli.js --workflow /opt/symphony/WORKFLOW.md
Environment=GITHUB_TOKEN=ghp_...
Environment=LOG_LEVEL=info
Restart=on-failure
RestartSec=10s
User=symphony

[Install]
WantedBy=multi-user.target
```

`systemctl enable --now symphony`

## Observability — knowing it's working

The fork ships full historical + live observability:

- **Durable event log**: every meaningful orchestrator action is appended
  to `<dataDir>/events.jsonl` (one JSON object per line). Tail it with `jq`
  filters; nothing is lost when the daemon restarts.
- **Raw agent stream capture**: every agent turn's raw protocol stream is
  written to `<dataDir>/turns/<issueId>/<isoTs>-t<seq>.jsonl`, surviving
  workspace cleanup. Useful when an agent goes off the rails and you need
  the literal output to forensically reconstruct what happened.
- **Operator console** (HTTP, optional): a server-rendered dashboard at
  `127.0.0.1:<port>` with a JSON API. See "Operator Console" below.

### Live: logs

Symphony emits structured `pino` JSON to stdout. Every issue-related log
includes `issueId` / `issueIdentifier`; agent session lifecycle logs
include `sessionId`.

```bash
# Pretty-print live (stream into pino-pretty).
node dist/src/cli.js --workflow ./WORKFLOW.md | npx pino-pretty

# Per-issue trace, structured.
tail -f /tmp/symphony.out.log | jq 'select(.issueIdentifier == "ltk-global/symphony#42")'

# Just dispatches and failures.
tail -f /tmp/symphony.out.log | jq 'select(.msg | test("dispatch|failed|retry"))'

# Bump verbosity for a session.
LOG_LEVEL=debug node dist/src/cli.js --workflow ./WORKFLOW.md
```

### Live: snapshot

`Orchestrator.snapshot()` returns the current dispatch picture: `running`
count, `runningSessions[]` with per-session `turnCount`/`tokens`/
`lastEventKind`/`lastMessage`/`workspacePath`, `retrying[]`, and cumulative
`codexTotals`. Read it via `GET /api/v1/state` (when the console server is
on) or via `--once` (note: also dispatches).

For a side-effect-free peek, run `./scripts/preflight.sh` — it reports
candidate count without starting any sessions.

### Operator Console

Enable with `--port 8787` or `server: { port: 8787 }` in the workflow:

```bash
node dist/src/cli.js --workflow ./WORKFLOW.md --port 8787
```

Then visit `http://127.0.0.1:8787/`. You get:

- **Index** — running sessions table, retry queue, recent 50 events feed,
  cumulative token totals. Auto-refreshes every 5 seconds.
- **Per-issue** at `/issues/<identifier>` — full timeline of every event
  for that issue, grouped by session, plus links to raw turn captures.
- **Raw turn viewer** at `/issues/<id>/turns/<file>` — the literal stream-
  json or codex JSON-RPC for one turn.
- **JSON API**:
  - `GET /api/v1/state` — full snapshot + recent events
  - `GET /api/v1/issues/<identifier>` — per-issue with timeline + turn list
  - `POST /api/v1/refresh` — force an immediate tick

The server binds to `127.0.0.1` by default. It is single-user, no auth, do
not expose it over a network without a tunnel.

### Post-hoc: where to look when an agent misbehaves

- **Workspace state** at the moment of failure: `<workspace.root>/<key>` is
  not deleted on failure. Inspect the git tree, run the agent's last command
  manually, etc.
- **Daemon log lines** for that issue: filter by `issueIdentifier`.
- **Agent stdout/stderr** is not currently captured to disk by the
  orchestrator. The Claude Code adapter consumes the stream-JSON internally
  and emits normalized events; raw text is lost. If you need raw agent
  output for a session, run the daemon under `script(1)` or pipe stderr to
  a file via systemd/launchd, then grep for the session's identifier.

### Status against upstream SPEC §13

| SPEC ref | Status |
|---|---|
| §13.1 Structured log conventions | implemented |
| §13.2 Event log file shape | implemented (`<dataDir>/events.jsonl`) |
| §13.3 Raw agent stream capture | implemented (`<dataDir>/turns/<id>/...jsonl`) |
| §13.5 HTTP server + dashboard | implemented (this fork extends §13.7) |
| §13.6 Snapshot interface | enriched per-session detail; rate limits / iris counters TBD |
| §13.5 (upstream) Token accounting | partial — totals accumulate; absolute vs delta dedup is a TODO |

## Common failure modes

| Symptom | Most likely cause | Fix |
|---|---|---|
| `missing_github_token` at startup | `GITHUB_TOKEN` not exported, or `tracker.api_token` doesn't start with `$` | export the token; default `api_token: $GITHUB_TOKEN` resolves it |
| `missing_iris_token` | `iris.enabled: true` without setting `IRIS_TOKEN` | export `IRIS_TOKEN`, OR set `iris.enabled: false` |
| `missing_project_identification` | neither `project_url` nor (`project_owner` + `project_number`) provided | add `tracker.project_url` |
| `unsupported_tracker_kind` | `tracker.kind` is anything but `github_projects` | only `github_projects` works in this fork (Linear is upstream-only) |
| Daemon runs, no items dispatched | `filters.assignee` doesn't match any issues, OR Status values don't match `active_states` spelling | preflight will print the candidate count — tune filters / status values |
| Items dispatched but Status never changes | the agent isn't using `gh` to transition Status | the orchestrator does NOT move Status itself except for verify; tell the agent in `claude_code.append_system_prompt` |
| `iris.enabled: true` and verify always says "no URL" | the agent isn't emitting `verify_url` in its final JSON line, AND no `deploy:` label, AND no `verify.url_static` | check the prompt body, add `verify.url_static` as a fallback |
| Daemon eats CPU after a config change | hot-reload triggered while sessions were running, then errored — last-known-good config kept serving | check logs for `workflow reload failed`; fix the config and trigger a quiet moment |

## Multi-daemon hygiene (Pattern B)

If you're running more than one daemon on the same host:

- Use **distinct `workspace.root`** per daemon (e.g. `~/.symphony/projA`, `~/.symphony/projB`). The workspace key sanitizer is per-daemon — collisions between daemons would silently overlay.
- Use **distinct service unit names** (`symphony-projA.service`, `symphony-projB.service`).
- IRIS concurrency is **not** shared across daemons by default. If you want a global IRIS budget, set `iris.max_concurrent` per-daemon to (global budget / N) — the file semaphore is keyed per Symphony invocation, not per host.
- Don't share `GITHUB_TOKEN` for unrelated repos if you can avoid it; use one bot per major boundary.
