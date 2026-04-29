# Symphony

A Node daemon that orchestrates AI coding agents (Claude Code, OpenAI Codex)
against GitHub Projects v2 items, with optional browser-based verification
via IRIS.

This is the LTK fork of upstream
[`openai/symphony`](https://github.com/openai/symphony), tracking the same
`SPEC.md` shape but substituting GitHub Projects for Linear and adding
browser verify, alerting hooks, an operator console, and a cross-daemon
aggregator.

## Quick start

```bash
git clone https://github.com/ltk-global/symphony && cd symphony
./scripts/setup.sh
```

`setup.sh` installs deps, builds, and offers to launch the interactive
wizard. The wizard:

1. Detects your agent CLI (`claude` or `codex`)
2. Validates a `GITHUB_TOKEN` against the GitHub API
3. Lists your Projects (v2) and prompts you to pick one
4. Reads the Project's Status field, confirms active/terminal/needs-human
5. Writes a tailored `WORKFLOW.md`
6. Runs preflight to confirm everything connects
7. Offers to start the daemon with the operator console at
   `http://127.0.0.1:8787/`

Total time from clone to live dashboard: ~3 minutes.

## What you get

- **Per-daemon operator console** — a server-rendered dashboard with live
  sessions, retry queue, recent events feed, per-issue timeline drilldown,
  and direct viewers for raw agent stream captures.
- **Append-only event log** at `~/.symphony/<workflow-hash>/events.jsonl` —
  every meaningful orchestrator action, queryable with `tail` + `jq`.
- **Raw turn capture** — the literal stream-JSON or codex JSON-RPC for every
  agent turn, persisted under `~/.symphony/<workflow-hash>/turns/...` so
  you can debug a misbehaving agent post-mortem.
- **Alerting hooks** — fire `bash -lc <script>` on selected event types
  (Slack, PagerDuty, archival, anything you can shell out to).
- **Cross-daemon aggregator** (`symphony-aggregator`) — a separate bin that
  polls each daemon's `/api/v1/state` and serves a unified dashboard.
- **Browser verify** via IRIS (Swarmy) — drive a real Chrome to confirm
  the agent's change is live before transitioning the item to "In Review".
  The wizard handles IRIS token entry and offers to set up an
  ngrok or cloudflared tunnel for verifying against your local dev server.

## How it works

```
GitHub Project (v2)            ~/.symphony/<hash>/
   │                               │
   ▼  tracker poll                 ▼
┌────────────────────┐          events.jsonl     (durable trace)
│   orchestrator     │ ──────►  turns/...jsonl   (raw agent streams)
│                    │
│  ▸ dispatch        │
│  ▸ reconcile       │ ───────►  per-daemon HTTP console (optional)
│  ▸ verify (IRIS)   │
│  ▸ retry backoff   │ ───────►  hooks.on_event scripts (optional)
└─────────┬──────────┘
          │
          ▼  per-issue workspace (clone, branch, hooks)
┌────────────────────┐
│   coding agent     │  → opens PR, comments, transitions Status via gh
│   (claude/codex)   │
└────────────────────┘
```

## Documentation

| | |
|---|---|
| [`docs/ONBOARDING.md`](docs/ONBOARDING.md)        | Operator guide — setup, multi-daemon hygiene, observability, troubleshooting |
| [`SPEC.md`](SPEC.md)                              | Design document — protocol, contracts, conformance |
| [`docs/IMPLEMENTATION.md`](docs/IMPLEMENTATION.md)| Fork-specific deltas (GitHub Projects substitution, agent backends) |
| [`docs/DESIGN.md`](docs/DESIGN.md)                | Operator console visual system |
| [`examples/WORKFLOW.example.md`](examples/WORKFLOW.example.md) | Full annotated workflow file |

## CLI

```bash
node dist/src/cli.js --workflow ./WORKFLOW.md [--port 8787] [--once]
node dist/src/cli-aggregator.js --config ./aggregator.yaml [--port 9000]
./scripts/setup.sh         # one-time install + build
./scripts/init.sh          # interactive setup wizard
./scripts/preflight.sh     # validate config + GitHub access without dispatching
```

After `npm link`, the bins are exposed as `symphony` and
`symphony-aggregator`.

## Status

| Capability | State |
|---|---|
| GitHub Projects v2 tracker | ✅ |
| Claude Code adapter | ✅ |
| OpenAI Codex adapter | ✅ |
| IRIS browser verify | ✅ optional |
| Event log + raw turn capture | ✅ |
| Operator console (HTTP, dashboard, JSON API) | ✅ |
| Alerting hooks (`hooks.on_event`) | ✅ |
| Cross-daemon aggregator | ✅ |
| Linear tracker | ❌ (upstream only — not ported) |
| Auth on the operator console | ❌ (loopback only by design) |
| Token accounting absolute-vs-delta dedup | ❌ open work |

## Requirements

- Node 22+
- `git` on PATH
- An agent CLI: `@anthropic-ai/claude-code` (`claude`) or `@openai/codex` (`codex`)
- `gh` (the **agent** uses it inside the workspace)
- A `GITHUB_TOKEN` with `repo` + `project` scopes (the **daemon** uses it
  for tracker access and workspace clones)
- Optional: an `IRIS_TOKEN` if `iris.enabled: true`

## License

Inherits from upstream [`openai/symphony`](https://github.com/openai/symphony).
