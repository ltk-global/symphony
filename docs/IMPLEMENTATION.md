# Symphony Implementation Notes

This implementation follows the upstream Symphony service shape with one intentional tracker substitution: GitHub Projects is the supported tracker instead of Linear.

## Tracker Extension

- Supported `tracker.kind`: `github_projects`.
- Auth uses `tracker.api_token`, typically `$GITHUB_TOKEN`.
- A project is selected with either `tracker.project_url` or `tracker.project_owner` plus `tracker.project_number`.
- Project item Status is used as the normalized issue state.
- Terminal workspace cleanup uses GitHub Project items in `tracker.terminal_states`.
- The upstream `linear_graphql` tool is not implemented because Linear is not the tracker backend here.

## Runtime Policy

- The service is a trusted local daemon. Coding agents run in per-issue workspace directories.
- Workspace keys are sanitized and resolved under `workspace.root`.
- Workspace hooks run in the workspace directory with issue metadata in environment variables.
- `after_run` and `before_remove` hook failures are logged and ignored; `after_create` and `before_run` failures abort the attempt.

## Agent Backends

- `agent.kind: codex` starts `codex.command` with `bash -lc` in the workspace.
- `agent.kind: claude_code` starts Claude Code with stream JSON output.
- Unsupported `agent.kind` values fail configuration validation.
- User-input-required events are treated as terminal run events rather than waiting indefinitely.

## IRIS And Verification Extensions

- IRIS is optional and only advertised to agents when `iris.enabled` is true and a shared client is configured.
- Claude Code receives IRIS through a local MCP server with the same profile overrides and shared concurrency key as the orchestrator IRIS client.
- Blocked IRIS runs follow `iris.on_blocked`; `needs_human` comments and transitions the item to `tracker.needs_human_state`.

## Reload And Recovery

- The runtime checks `WORKFLOW.md` modification time before ticks.
- When idle, changed workflow config is reloaded and future ticks use the new config.
- If reload fails after a valid config has been loaded, the service logs the error and keeps the last known good configuration.
- Startup cleanup removes workspaces for items currently in terminal states.
- Clean worker exits schedule a short continuation retry; failed turns schedule exponential backoff bounded by `agent.max_retry_backoff_ms`.
