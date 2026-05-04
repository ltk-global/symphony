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

`setup.sh` checks Node 22+ and `git`, runs `npm ci`, builds `dist/`, then
**offers to launch the interactive wizard** (`./scripts/init.sh`). Say yes
to the prompt and the wizard handles the rest — including writing your
`WORKFLOW.md` and starting the daemon. Running `init.sh` directly is the
fast path; the rest of this document is for operators who want to know
what's happening behind the prompts, run things manually, or troubleshoot.

### Prerequisites the wizard checks for

| Component | Why it's needed | Install if missing |
|---|---|---|
| **Node 22+** | runtime | `nvm install --lts`, `brew install node`, or `volta install node@22` |
| **`git`** | workspace hooks clone your repos | almost always present; `brew install git` / `sudo apt install git` |
| **Claude Code CLI** *(if you'll use `agent.kind: claude_code`)* | the orchestrator spawns `claude` per dispatch | `npm install -g @anthropic-ai/claude-code` — then run `claude` once to log in |
| **OpenAI Codex CLI** *(if you'll use `agent.kind: codex`)* | the orchestrator spawns `codex app-server` | `npm install -g @openai/codex` or `brew install --cask codex`; first run prompts for ChatGPT/API auth |
| **`gh`** | the **agent** uses it inside each workspace for Project Status / PR / comment writes | macOS `brew install gh`; Debian `sudo apt install gh`; Fedora `sudo dnf install gh`. Then `gh auth login --scopes 'repo,project'`. |
| **`GITHUB_TOKEN` env var** | the **daemon** uses it for tracker access and workspace clones | generate a PAT or App installation token at github.com/settings/tokens with scopes `repo` and `project` |

Install only the agent CLI matching the kind you'll pick in the wizard.

### Two tokens, two purposes

The daemon and the agent each need GitHub access — and they authenticate
separately:

- **`GITHUB_TOKEN` env var** → used by the **daemon** for tracker GraphQL
  queries and (via the `after_create` hook) for cloning the issue's repo.
  This is the one referenced as `tracker.api_token: $GITHUB_TOKEN` in
  `WORKFLOW.md`. Required scopes: `repo`, `project`.
- **`gh auth login`** → used by the **agent** inside the workspace, to call
  `gh project item-edit`, `gh pr create`, etc. Cached in the agent user's
  home dir. Same scopes.

The cleanest pattern is a dedicated bot user: create a GitHub user, give
it the scopes above, generate a fine-grained PAT for the daemon, and
`gh auth login` as that user once on the host. One identity for both roles.

### What the wizard writes

Running `./scripts/init.sh` produces a `WORKFLOW.md` (path of your choosing,
defaults to `./WORKFLOW.md`) that contains:

- `tracker` — pointed at the Project you picked, with the active / terminal /
  needs-human Status values you confirmed
- `tracker.filters.assignee` — only set if you provided one
- `workspace.root` — `~/symphony_workspaces/<project-slug>` by default
- `workspace.cache.strategy: llm` — enables reference-clone reuse + an
  LLM-authored bootstrap recipe (skip with `./scripts/init.sh --no-eager-bootstrap`)
- `hooks.after_create` — clones `${ISSUE_REPO_FULL_NAME}` using
  `${GITHUB_TOKEN}` (with `--reference $SYMPHONY_REPO_REF` when set)
- `hooks.before_run` — sources `$SYMPHONY_RECIPE` to apply the cached
  bootstrap (`npm ci --prefer-offline`, etc.) when one is available
- `agent` — the kind detected on PATH, with sensible defaults
- `iris` + `verify` — only when you opt in
- `server.port` — only when you enable the operator console
- a Liquid prompt body that walks the agent through Status transitions, branch naming, PR creation, and (if IRIS is on) the `VERIFY_REQUESTED` handshake

If `cache.strategy: llm` is selected, the wizard also pre-warms the recipe
cache: it shallow-clones the project's primary repo, invokes the
`symphony-workspace-bootstrap` skill to author a recipe, and persists it to
`~/.symphony-cache/recipes/`. The first dispatch then arrives warm. Pass
`--no-eager-bootstrap` to defer this — the daemon will lazily author on the
second dispatch (the first runs without `SYMPHONY_RECIPE`).

The file is intentionally small enough that you can edit it after running
init — the wizard is a starting point, not a black box.

### Workspace caching

The wizard enables `workspace.cache.strategy: llm` by default. This gives
every dispatch two warm-cache paths:

| Cache | Where | Effect |
|---|---|---|
| Reference clone | `~/.symphony-cache/refs/<repoId>.git` (bare) | Subsequent `git clone --reference $SYMPHONY_REPO_REF` skips bytes-on-the-wire. |
| Bootstrap recipe | `~/.symphony-cache/recipes/<stem>.{sh,json}` | LLM-authored install/setup script (e.g. `npm ci --prefer-offline`) sourced from `before_run`. |

In practice, this is ~30s cold → ~1.5s warm per dispatch on a Node repo.

**Strategy choices** (`workspace.cache.strategy` in WORKFLOW.md):

- `none` — disable caching; `after_create` runs against an empty workspace.
- `reference_only` — bare clone reuse only; no recipe authoring.
- `llm` (default) — both caches; recipe authored on first miss via the
  `symphony-workspace-bootstrap` skill.

**Operator approval** (`workspace.cache.review_required: true`): newly-authored
recipes land as `<stem>.sh.pending` with `SYMPHONY_RECIPE_DISABLED=1`
exported to hooks. Run `symphony recipe approve <owner/repo>` to promote;
`symphony recipe reject <owner/repo>` to discard. Useful when you want a
human in the loop for the first recipe per repo.

**`symphony recipe` CLI** — manage the cache without editing files by hand:

```bash
symphony recipe list                    # enumerate cached recipes + status
symphony recipe show <owner/repo>       # print recipe body + manifest
symphony recipe approve <owner/repo>    # promote .pending → final (review mode)
symphony recipe reject <owner/repo>     # delete the .pending pair
symphony recipe regen <owner/repo>      # force regeneration on next dispatch
symphony recipe quarantine <owner/repo> # mark as "do not use" — falls back to canned template
symphony recipe prune --force           # wipe all cached recipes
```

**Cache env vars exposed to hooks**:

| var | when set | use |
|---|---|---|
| `SYMPHONY_CACHE_DIR` | always | Cache root override (default `~/.symphony-cache`). |
| `SYMPHONY_REPO_REF` | `strategy != none` | Path to the bare reference clone — pass to `git clone --reference $SYMPHONY_REPO_REF --dissociate`. |
| `SYMPHONY_RECIPE` | `strategy=llm` and recipe present | Absolute path to the recipe shell script — `WORKSPACE="$ISSUE_WORKSPACE_PATH" source "$SYMPHONY_RECIPE"`. |
| `SYMPHONY_RECIPE_DISABLED` | `review_required: true` and recipe is `.pending` | Set to `1` so hooks can short-circuit an unreviewed recipe. |
| `SYMPHONY_REFS_DIR` | always (defaults to `<SYMPHONY_CACHE_DIR>/refs`) | Override the reference-clone root only. |

**Safety**: every recipe is run through the validator
(`src/workspace/recipe_validator.ts`) before persistence — secret patterns,
pipe-to-shell, destructive `rm`, paths escaping the workspace, and ~20
other classes are rejected, plus a `bash -n` syntax check. A rejected
recipe falls back to a canned template, not the dispatch failing.

The full operator reference (paths, manifest shape, LLM CLI resolution,
consent model) lives in [`docs/CACHING.md`](CACHING.md).

### Browser verify with a local tunnel

If you want IRIS to verify changes against a **local** dev server (not a
deployed app), the wizard handles tunnel setup. Pick `[n]grok` or
`[c]loudflared` in the "Verify URL" prompt. Tradeoffs:

| | ngrok | cloudflared |
|---|---|---|
| Free fixed domain | ✅ one `*.ngrok-free.app` per account | ❌ quick tunnels are random per-session |
| Account/login required | yes (one-time `ngrok config add-authtoken`) | no for quick tunnels |
| Stable URL across restarts | yes (with fixed domain) | only with named tunnels (`cloudflared tunnel login` + `tunnel create`) |
| SSE / WebSockets on tunneled app | ✅ | ❌ on quick tunnels (200-req limit, no SSE); ✅ on named tunnels |
| Best for | regular dev where the tunnel runs alongside | one-off "show me what works" runs |

When you pick a tunnel, the wizard writes a `scripts/tunnel-<slug>.sh` helper
containing the exact command. Run it in a separate terminal **before**
starting the daemon. With a fixed domain, the URL stays the same across
restarts and is hard-coded into `verify.url_static` in your `WORKFLOW.md`;
with a random URL, leave the verify mode as `agent_output` and have the
agent emit `{"verify_url": "..."}` in its final JSON line each turn.

The IRIS bits the wizard captures:

- **Token** at <https://swarmy.firsttofly.com/settings> → API Tokens (starts `swm_`). Pasted into the wizard with hidden input; never written to disk.
- **Profile** at <https://swarmy.firsttofly.com/profiles>. Default `claude-default-latest` works for public sites; create a profile via the Swarmy UI when you need pre-baked auth state.
- **Concurrency**: per-account quota is 3 containers, no per-minute billing — runs as long as your verify takes.

When IRIS sees something it can't solve (CAPTCHA, MFA, consent modal), it
emits a `blocked` event with a VNC URL. Symphony's default `on_blocked:
needs_human` posts the VNC URL as a comment on the issue and transitions
the project item to `Needs Human` — you click the VNC URL, finish the
step, and put the item back to `Todo` for the daemon to pick up again.

### Manual path (no wizard)

If you'd rather hand-author:

1. `cp examples/WORKFLOW.example.md ./WORKFLOW.md`
2. Edit `tracker.project_url`, `tracker.filters.assignee`, IRIS settings (or set `iris.enabled: false` and remove the `verify:` block), `verify.url_static`, the prompt body's repo-specific commands.
3. `./scripts/preflight.sh ./WORKFLOW.md` — should exit 0.
4. `node dist/src/cli.js --workflow ./WORKFLOW.md --port 8787`

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

### Foreground (development), with the operator console

```bash
GITHUB_TOKEN=ghp_... LOG_LEVEL=info \
  node dist/src/cli.js --workflow /path/to/WORKFLOW.md --port 8787
```

`--port 8787` enables the operator console at `http://127.0.0.1:8787/`. You
can also set it in front matter: `server: { port: 8787 }`. Omit `--port`
entirely for a headless daemon.

### One tick and exit (manual sweep / cron)

```bash
node dist/src/cli.js --workflow /path/to/WORKFLOW.md --once
```

`--once` will *dispatch* anything that's eligible. Don't use it as a
preflight — use `scripts/preflight.sh` for that.

### Where everything lives

For a workflow at `/path/to/WORKFLOW.md`:

| Path | What's there | Lifetime |
|---|---|---|
| `~/.symphony/<sha256(path)[:12]>/events.jsonl` | every orchestrator event, append-only | until you rotate it |
| `~/.symphony/<sha256(path)[:12]>/turns/<issueId>/<ts>-t<seq>.jsonl` | raw stream-json from each agent turn | until you rotate it |
| `<workspace.root>/<sanitized issue id>/` | per-issue git workspace, recreated per dispatch | removed when issue hits a `terminal_state` |
| `~/.symphony-cache/refs/<repoId>.git/` | bare reference clones (cache.strategy ≠ none) | survives across dispatches; manage via `git -C` or `rm -rf` |
| `~/.symphony-cache/recipes/<stem>.{sh,json,…}` | LLM-authored bootstrap recipes (cache.strategy=llm) | survives across dispatches; manage via `symphony recipe …` |
| stdout (pino JSON) | structured log lines | wherever you redirect — systemd journal, launchd `StandardOutPath`, etc. |

Override the data dir with top-level `data_dir:` in front matter (accepts
`~`, absolute paths, and `$VAR`). You can find the resolved dir at runtime
via `GET /api/v1/state` (the `dataDir` field) or by reading the
`daemon_reload` event.

### Long-running service

There's no Dockerfile or service unit shipped. Two minimal recipes — both
include `--port` so the operator console comes up automatically.

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
    <string>--workflow</string><string>/Users/you/work/WORKFLOW.md</string>
    <string>--port</string><string>8787</string>
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
ExecStart=/usr/bin/node /opt/symphony/dist/src/cli.js \
  --workflow /opt/symphony/WORKFLOW.md \
  --port 8787
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

### Post-hoc: when an agent misbehaves

You have three forensic surfaces, in order of usefulness:

1. **Per-issue page in the operator console** at `/issues/<identifier>` —
   timeline of every orchestrator event for that issue, grouped by session,
   with direct links to each turn's raw capture. Start here.
2. **Raw turn captures** at `<dataDir>/turns/<issueId>/<ts>-t<seq>.jsonl` —
   the literal stream-json from `claude` or the JSON-RPC stream from
   `codex` (with `>>> ` for outgoing requests, `<<< ` for incoming
   notifications). Survives workspace cleanup.
3. **The workspace itself** at `<workspace.root>/<key>/` — not removed on
   failure. Use it to reproduce the agent's last `git`/`gh`/`npm` command
   or inspect the working tree.

If the daemon itself died, the structured pino log lines (with `issueId` /
`issueIdentifier` / `sessionId` fields) are in stdout — capture them via
your service unit's `StandardOutPath` / journald.

### Token cost monitoring

Per-issue and cumulative token spend live in two places:

- **Live**: `Orchestrator.snapshot().codexTotals` (cumulative since last
  daemon start) and per-session `tokens.{input,output,total}`. Both visible
  on the dashboard header strip and in `GET /api/v1/state`.
- **Historical**: `events.jsonl` records `usage` on every `turn_completed`.
  Aggregate per repo:

  ```bash
  jq -r 'select(.type=="turn_completed" and .payload.usage)
         | [.issueIdentifier, .payload.usage.totalTokens] | @tsv' \
    ~/.symphony/<hash>/events.jsonl \
    | awk '{sum[$1]+=$2} END{for(k in sum) printf "%-40s %d\n", k, sum[k]}'
  ```

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
| Operator console says "no events yet" | `events.jsonl` doesn't exist or the daemon hasn't ticked yet | wait one poll interval; if the file path is wrong, check the `daemon_reload` event in the log or `GET /api/v1/state.dataDir` |
| Token totals seem too high | `usage` events are summed per emit; absolute-vs-delta dedup is a known TODO | sanity-check by summing only `turn_completed` events from `events.jsonl` (see "Token cost monitoring" above) |
| Operator console is unreachable | server crashed silently or wasn't enabled | check `symphony.err.log` for "console_server listening"; confirm `--port` or `server.port` is set |
| `ensure_bare_clone_failed_skipping_reference` on every dispatch | usually a token-scope issue, an expired token, or the repo doesn't exist for this account | confirm `GITHUB_TOKEN` has `repo` scope; `gh repo view <owner/repo>` should succeed. The dispatch will still proceed, just without the reference cache. |
| `SYMPHONY_RECIPE_DISABLED=1` exported, hook silently skips bootstrap | `workspace.cache.review_required: true` and the recipe is still `.pending` | run `symphony recipe approve <owner/repo>` (or set `review_required: false` if you trust the validator alone) |
| Recipe authoring fails / takes forever | LLM CLI not on PATH, or `npx --yes` is fetching cold | first run resolves `claude` / `codex` via npx (~5–10s cold); set `SYMPHONY_CLAUDE_BIN` / `SYMPHONY_CODEX_BIN` to a pinned local install if you want determinism |

## Multi-daemon hygiene (Pattern B)

If you're running more than one daemon on the same host:

- **Distinct `workspace.root`** per daemon (e.g. `~/.symphony/projA-ws`,
  `~/.symphony/projB-ws`). The workspace key sanitizer is per-daemon —
  daemons sharing a workspace root would silently overlay each other on
  same-numbered identifiers.
- **Distinct ports** for each daemon's operator console
  (`--port 8787`, `--port 8788`, …) — or rely on the cross-daemon
  aggregator described below to merge them under one dashboard.
- **Distinct service unit names** (`symphony-projA.service`,
  `symphony-projB.service`).
- **IRIS concurrency IS shared cross-process** if both daemons target the
  same `iris.base_url`. The file semaphore lives at
  `<tmpdir>/symphony_iris_locks/iris_<sanitized-base-url>/` and uses
  `mkdir`-based exclusion that works across PIDs. Caveat: the slot count
  is determined by whichever daemon's `iris.max_concurrent` runs first —
  set them all to the same value to avoid surprises. Different
  `base_url`s → different locks → no sharing.
- **Don't share `GITHUB_TOKEN`** for unrelated repos if you can avoid it;
  use one bot per major boundary.

For a unified dashboard across daemons see the next section.

## Cross-daemon aggregator

When you have more than one daemon, run `symphony-aggregator` for a single
view of the fleet:

```bash
# /etc/symphony/aggregator.yaml
port: 9000
host: 127.0.0.1
poll_interval_ms: 5000
daemons:
  - name: projA
    url: http://127.0.0.1:8787
  - name: projB
    url: http://127.0.0.1:8788
```

```bash
node dist/src/cli-aggregator.js --config /etc/symphony/aggregator.yaml
# or, after npm link:
symphony-aggregator --config /etc/symphony/aggregator.yaml
```

Visit `http://127.0.0.1:9000/`:

- **Daemons table** — one row per daemon, reachable/unreachable, last-seen.
- **Running sessions** across the fleet, tagged with daemon name; rows
  link out to that daemon's per-issue page in a new tab.
- **Retry queue** across the fleet.
- **Recent events** merged + ts-sorted across all reachable daemons.

The aggregator polls each daemon's `/api/v1/state` independently. A daemon
being down only marks that one daemon unreachable — the rest keep
serving. Per-daemon poll timeout defaults to 3s and can't block the poll
cycle. The aggregator never proxies to per-issue or raw turn pages; clicks
go to the originating daemon directly.

## Alerting hooks

For event-driven notifications (Slack, PagerDuty, anything you can shell
out to), declare `hooks.on_event` rules in the workflow:

```yaml
hooks:
  on_event:
    - name: slack-on-blocked
      types: [iris_blocked_handed_off, dispatch_failed, verify_terminal_failed]
      script: |
        curl -fsS -X POST "$SLACK_WEBHOOK_URL" \
          -H 'content-type: application/json' \
          -d "{\"text\":\":rotating_light: $SYMPHONY_EVENT_TYPE on $SYMPHONY_ISSUE_IDENTIFIER\"}"
      timeout_ms: 5000

    - name: archive-all
      types: ["*"]
      script: |
        printf '%s\n' "$SYMPHONY_EVENT_PAYLOAD" >> /var/log/symphony/audit.jsonl
```

Available env vars in the script:

| Variable | Always set | Notes |
|---|---|---|
| `SYMPHONY_EVENT_TYPE` | yes | e.g. `iris_blocked_handed_off` |
| `SYMPHONY_EVENT_TS` | yes | ISO 8601 |
| `SYMPHONY_ISSUE_ID` | when the event names an issue | GitHub Project item id |
| `SYMPHONY_ISSUE_IDENTIFIER` | when the event names an issue | human-readable like `repo#42` |
| `SYMPHONY_SESSION_ID` | session-scoped events | |
| `SYMPHONY_TURN_SEQ` | turn-scoped events | |
| `SYMPHONY_EVENT_PAYLOAD` | yes | full payload as JSON, or `{}` |

Hooks are fire-and-forget. They never block the daemon, never fail a turn,
never cause a missed event in `events.jsonl`. A hook that exits non-zero
or hits its timeout (default 10s, override per-rule) is logged at warn
level and forgotten. Use this for alerts, not for state machines.

For matching: list specific event types, or use `"*"` to match every
event the orchestrator emits. See SPEC §13.2 for the full event vocabulary.
