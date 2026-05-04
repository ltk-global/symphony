---
tracker:
  kind: github_projects
  endpoint: https://api.github.com/graphql
  api_token: $GITHUB_TOKEN

  # Resolve the project. Provide either project_url, or (project_owner + project_number).
  project_url: https://github.com/orgs/acme/projects/7

  # Field mappings. The field names below must exist on the project.
  status_field: Status
  priority_field: Priority

  # Status values. Items in active_states are eligible to dispatch.
  active_states: [Todo, In Progress, Review Feedback]
  terminal_states: [Done, Cancelled, "Won't Do"]
  needs_human_state: Needs Human

  # Optional. Only items matching ALL filters get dispatched.
  filters:
    assignee: acme-symphony-bot
    label_required: []
    label_excluded: [wip, do-not-touch, manual-only]

polling:
  interval_ms: 30000

workspace:
  root: ~/symphony_workspaces

  # Workspace caching: bare-clone reuse + LLM-authored bootstrap recipes.
  # See docs/CACHING.md for the full reference. Strategies:
  #   none           — no caching (after_create runs against an empty workspace)
  #   reference_only — bare clone reuse (SYMPHONY_REPO_REF exported)
  #   llm (default)  — reference clone + bootstrap recipe (SYMPHONY_RECIPE exported)
  cache:
    strategy: llm
    review_required: false       # set true to gate new recipes behind `symphony recipe approve`
    recipe_ttl_hours: 168        # regenerate after one week even if inputs unchanged

hooks:
  # Clone the issue's repo into the workspace and check out a working branch.
  # ISSUE_* env vars are exported by the orchestrator before each hook runs.
  # When workspace.cache.strategy != none, SYMPHONY_REPO_REF points at a bare
  # reference clone we can borrow objects from to skip bytes-on-the-wire.
  after_create: |
    set -euo pipefail
    if [ -z "${ISSUE_REPO_FULL_NAME:-}" ]; then
      echo "no ISSUE_REPO_FULL_NAME (this is a draft item); skipping clone" >&2
      exit 0
    fi
    if [ -n "${SYMPHONY_REPO_REF:-}" ] && [ -d "$SYMPHONY_REPO_REF" ]; then
      git clone --reference "$SYMPHONY_REPO_REF" --dissociate \
        "https://x-access-token:${GITHUB_TOKEN}@github.com/${ISSUE_REPO_FULL_NAME}.git" . \
        || git clone "https://x-access-token:${GITHUB_TOKEN}@github.com/${ISSUE_REPO_FULL_NAME}.git" .
    else
      git clone "https://x-access-token:${GITHUB_TOKEN}@github.com/${ISSUE_REPO_FULL_NAME}.git" .
    fi
    BRANCH="${ISSUE_BRANCH_NAME:-symphony/${ISSUE_WORKSPACE_KEY}}"
    git checkout -B "${BRANCH}"

  before_run: |
    # Bring the workspace up to date with main before each agent attempt.
    set -euo pipefail
    if [ -d .git ]; then
      git fetch origin main --quiet || true
      git rebase origin/main || git rebase --abort || true
    fi
    # Apply the cached bootstrap recipe (npm ci / pnpm install / etc).
    # SYMPHONY_RECIPE is set when workspace.cache.strategy=llm and a recipe
    # exists; SYMPHONY_RECIPE_DISABLED=1 means it's pending operator review.
    if [ -n "${SYMPHONY_RECIPE:-}" ] && [ -z "${SYMPHONY_RECIPE_DISABLED:-}" ] && [ -f "$SYMPHONY_RECIPE" ]; then
      WORKSPACE="$ISSUE_WORKSPACE_PATH" source "$SYMPHONY_RECIPE"
    fi

  after_run: |
    # Best-effort cleanup; failures are ignored.
    git status --short || true

  before_remove: |
    git branch -D "${ISSUE_BRANCH_NAME:-symphony/${ISSUE_WORKSPACE_KEY}}" 2>/dev/null || true

  timeout_ms: 120000

agent:
  kind: claude_code
  max_concurrent_agents: 5
  max_turns: 25
  max_retry_backoff_ms: 300000
  max_concurrent_agents_by_state:
    "in progress": 5
    "review feedback": 3
  tools:
    iris_run:
      enabled: true
      max_calls_per_turn: 8
      allow_profile_override: true
    github:
      enabled: true

claude_code:
  command: claude
  model: claude-opus-4-7
  output_format: stream-json
  permission_mode: acceptEdits
  allowed_tools: [Bash, Read, Edit, Write, Glob, Grep, WebFetch]
  disallowed_tools: []
  append_system_prompt: |
    You are running as part of Symphony (LTK). Always update the project item's
    Status field via the gh CLI when you finish a meaningful step (Todo -> In Progress,
    then -> Ready For Verify when your change is deployed and ready to be browser-tested).
    When you need to verify a UI state or interact with a logged-in site, call iris_run.
    Never call iris_run for things you can verify without a browser (use Read/Bash first).
  max_turns: 50
  read_timeout_ms: 5000
  turn_timeout_ms: 3600000
  stall_timeout_ms: 300000

iris:
  enabled: true
  base_url: https://swarmy.firsttofly.com
  token_env: IRIS_TOKEN
  default_profile: acme-staging-logged-in
  profile_overrides:
    "env:prod-readonly": acme-prod-readonly
    "env:blank": claude-default-latest
    "needs-mfa": acme-staging-with-mfa
  max_concurrent: 3
  request_timeout_ms: 600000
  on_blocked: needs_human
  blocked_comment_template: |
    🛑 The agent hit a step requiring a human (captcha, MFA, or one-time consent).

    **VNC URL:** {{ blocked.vnc_url }}
    **Reason:** {{ blocked.reason }}

    Open the VNC URL, finish the step in the browser, then move this item back to
    `Todo` so the orchestrator picks it up again.

verify:
  enabled: true

  # When to run verify.
  trigger: after_agent_signal
  signal_marker: "VERIFY_REQUESTED"

  # Where the verify URL comes from. Try sources in order; first non-empty wins.
  url_source: [agent_output, label, static]
  agent_output_key: verify_url
  url_label_prefix: "deploy:"
  url_static: https://staging.acme.com

  # IRIS profile to use for verify (blank => fall back to iris.default_profile).
  profile: ""

  instruction_template: |
    Use swarmy-chrome-agent to navigate to {{ verify_url }}.

    Verify the change described in this ticket is live and working end-to-end:

    ---
    Title: {{ issue.title }}

    {{ issue.description }}
    ---

    Try the user-visible behavior described above. Take a screenshot for evidence.

    Print a JSON object as the LAST line of your output with keys:
      pass         (boolean)
      summary      (string, one or two sentences)
      evidence_url (string or null)

    Reasoning, observations, and tool calls go ABOVE the last line. Do not output
    anything after the JSON.

  on_pass:
    transition_to: "In Review"
    comment_template: |
      ✅ Verified by IRIS.

      {{ result.summary }}

      Evidence: {{ result.evidence_url }}

  on_fail:
    max_attempts: 2
    feedback_template: |
      IRIS verification failed (attempt {{ verify.attempts }} of {{ verify.max_attempts }}).

      Summary: {{ result.summary }}
      Evidence: {{ result.evidence_url }}

      Please diagnose, fix, push the change, and re-emit VERIFY_REQUESTED with an
      updated verify_url when ready.
    final_transition_to: "Needs Human"
    final_comment_template: |
      ❌ Verification failed {{ verify.attempts }} times.

      Last error: {{ result.summary }}
      Evidence: {{ result.evidence_url }}

      Handing off to a human reviewer.

  on_no_url:
    transition_to: "Needs Human"
    comment_template: |
      ⚠️ Verify stage couldn't resolve a URL to test against.

      Tried sources (in order): {{ verify.attempted_sources }}.

      Either:
      - emit a JSON last line with `verify_url` set to a deploy URL, OR
      - add a `deploy:<url>` label to the issue, OR
      - set `verify.url_static` in WORKFLOW.md.
---

# Workflow: Acme web app

You are picking up GitHub project items for the **acme/webapp** repo and shipping them
end-to-end — read the issue, write the code, open a PR, get it deployed to a preview
environment, request browser verification, and hand off for human review.

## Context for this turn

- **Item:** {{ issue.identifier }} — {{ issue.title }}
- **Status:** {{ issue.state }}
- **URL:** {{ issue.url }}
- **Repo:** {{ issue.repo_full_name }}
- **Labels:** {% for l in issue.labels %}`{{ l }}`{% unless forloop.last %}, {% endunless %}{% endfor %}
- **Attempt:** {% if attempt %}continuation #{{ attempt }}{% else %}first run{% endif %}

## What you should do

Follow this workflow precisely. Update the project Status as you progress.

1. **Move the item to `In Progress`** via the gh tool. Do this exactly once, at the
   start. Skip if it is already there.

2. **Read the description** below and identify the smallest change that solves the
   problem. Read the relevant source files. If the request is genuinely ambiguous,
   move the item to `Needs Human` with a comment explaining what you'd need to know,
   and stop.

   ---
   {{ issue.description }}
   ---

3. **Make the change** on a branch named
   `symphony/{{ issue.identifier | replace: "/", "-" | replace: "#", "-" }}`. Run the
   test suite (`pnpm test`) and the linter (`pnpm lint`). Iterate until both pass
   locally.

4. **Open a pull request** against `main` using `gh pr create`. Include in the PR body:
   - a summary of what you changed and why,
   - the issue identifier (`Fixes {{ issue.identifier }}`),
   - any caveats a reviewer should know.

5. **Wait for the preview deploy** by polling the PR's checks with
   `gh pr checks --watch`. Vercel publishes a preview URL as a check named `vercel`.
   Once the check is `completed` and `success`, extract the preview URL from
   `gh pr view --json statusCheckRollup`.

6. **Request browser verification.** Print the marker string `VERIFY_REQUESTED` on
   one line, then a JSON object on the very last line with keys `verify_url`
   (string) and `verify_ready` (boolean). Example:

   ```
   VERIFY_REQUESTED
   {"verify_url": "https://acme-webapp-pr-457.vercel.app", "verify_ready": true}
   ```

   The orchestrator will run IRIS against that URL and either:
   - transition the item to `In Review` (you're done; the human reviewer takes
     over), or
   - send you back the failure summary as the next turn's input. If that happens,
     fix the issue, push another commit, wait for the new preview, and emit
     `VERIFY_REQUESTED` again with the updated URL.

## When to use iris_run during the work itself

Use `iris_run` (Model A) when you need a real browser **during** implementation,
not as the final verification step. Examples:

- Reproducing a UI bug on staging before fixing it.
- Scraping a logged-in admin page to understand the data model.
- Confirming a third-party service's actual behavior (login flow, OAuth callback,
  etc.).

Do NOT use `iris_run` for things you can answer without a browser: reading the
codebase, running tests, parsing JSON from an API. Each `iris_run` call holds a
shared IRIS slot and is much slower than a tool call.

When you do call `iris_run`:

- Always include the full URL with scheme.
- Always tell IRIS what the answer should look like (`print as the LAST line…`).
- Reference `swarmy-chrome-agent` in the instruction so IRIS routes through Chrome.
- If you get a `blocked` event back, do NOT retry. The orchestrator has already
  moved the item to `Needs Human` and ended your turn; there's nothing more for
  you to do.

## Hard rules

- Never push to `main` directly.
- Never edit files outside this workspace directory.
- Never store secrets in code, comments, or PR bodies.
- If a test fails for a reason you can't fix in this scope, write a follow-up
  issue with `gh issue create` and reference it in the PR body, then proceed.
- If you genuinely cannot make progress, move the item to `Needs Human` with a
  clear comment and stop. Do not loop indefinitely.
