---
tracker:
  kind: github_projects
  api_token: $GITHUB_TOKEN
  project_url: https://github.com/users/ltk-global/projects/1
  status_field: Status
  active_states: [Todo, "In Progress"]
  terminal_states: [Done]
  needs_human_state: Needs Human

polling:
  interval_ms: 30000

workspace:
  root: ~/symphony_workspaces/symphony-todo-demo

hooks:
  after_create: |
    set -euo pipefail
    if [ -z "${ISSUE_REPO_FULL_NAME:-}" ]; then exit 0; fi
    if [ -n "${SYMPHONY_REPO_REF:-}" ] && [ -d "$SYMPHONY_REPO_REF" ]; then
      git clone --reference "$SYMPHONY_REPO_REF" --dissociate \
        "https://x-access-token:${GITHUB_TOKEN}@github.com/${ISSUE_REPO_FULL_NAME}.git" . \
        || git clone "https://x-access-token:${GITHUB_TOKEN}@github.com/${ISSUE_REPO_FULL_NAME}.git" .
    else
      git clone "https://x-access-token:${GITHUB_TOKEN}@github.com/${ISSUE_REPO_FULL_NAME}.git" .
    fi
    git checkout -B "${ISSUE_BRANCH_NAME:-symphony/${ISSUE_WORKSPACE_KEY}}"
  before_run: |
    set -euo pipefail
    if [ -n "${SYMPHONY_RECIPE:-}" ] && [ -z "${SYMPHONY_RECIPE_DISABLED:-}" ] && [ -f "$SYMPHONY_RECIPE" ]; then
      WORKSPACE="$ISSUE_WORKSPACE_PATH" source "$SYMPHONY_RECIPE"
    fi

agent:
  kind: claude_code
  max_concurrent_agents: 3
  max_turns: 25

claude_code:
  command: claude
  permission_mode: acceptEdits
  allowed_tools: [Bash, Read, Edit, Write, Glob, Grep, WebFetch]
  append_system_prompt: |
    You are a Symphony agent working a single GitHub Projects item end-to-end.
    Make the smallest correct change, run tests + linter, and open a PR.
    Drive the project item's Status yourself via `gh`: move to `In Progress` once,
    then to `Done` after the PR is open. If you cannot make progress, transition
    to `Needs Human` with a comment explaining why and stop.

iris:
  enabled: false

server:
  port: 8787
---

# Workflow: Symphony Todo Demo

You are picking up a single item from the **Symphony Todo Demo** GitHub Project.

- Issue: `{{ issue.identifier }}` — {{ issue.title }}
- URL: {{ issue.url }}
- Current Status: `{{ issue.state }}`
- Repo: `{{ issue.repoFullName }}`
- This is a {% if attempt %}continuation #{{ attempt }}{% else %}first run{% endif %}.

## Context

{{ issue.description }}

## What you should do

1. Move the project item to `In Progress` via `gh` exactly once. Skip this step if it is already `In Progress` (e.g. on a continuation).
2. Read the description carefully and explore the repo enough to understand the change. Make the **smallest** change that satisfies the request.
3. Run the project's tests and linter. Fix anything you broke before proceeding.
4. Commit and push to a branch named `symphony/{{ issue.identifier | replace: "/", "-" | replace: "#", "-" }}`.
5. Open a PR with `gh pr create`. The PR body must include `Closes {{ issue.identifier }}` so the item links correctly.
6. After the PR is open, transition the project item to `Done`.

## Hard rules

- Never push directly to `main`; open a PR.
- Branch name: `symphony/{{ issue.identifier | replace: "/", "-" | replace: "#", "-" }}`.
- Never store secrets in code, comments, or PR bodies.
- If you genuinely cannot make progress, move the item to `Needs Human` with a clear reason and stop.
