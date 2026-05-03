# Workspace caching — operator guide

Symphony can pre-warm coding-agent workspaces by reusing a local bare clone
(reference cache) and an LLM-authored bootstrap recipe (e.g. `npm ci
--prefer-offline` adapted to your repo's lockfile shape). The result: each
new dispatch skips most of the cold-clone / cold-install cost.

## Strategies (`workspace.cache.strategy` in WORKFLOW.md)

| value | what it does |
| --- | --- |
| `none` | No caching. `after_create` hook runs against an empty workspace. |
| `reference_only` | Maintains a bare clone under `~/.symphony-cache/refs/<repoId>.git`. Each new workspace clones from it via `git clone --reference`, cutting bytes-on-the-wire. Exposes `SYMPHONY_REPO_REF`. |
| `llm` (default) | Reference clone *plus* an LLM-authored bootstrap recipe at `~/.symphony-cache/recipes/<stem>.{sh,json}`. Exposes `SYMPHONY_RECIPE`. |

## Environment variables exposed to hooks

| var | set by | purpose |
| --- | --- | --- |
| `SYMPHONY_CACHE_DIR` | always | Cache root (default `~/.symphony-cache`; override with the env var). |
| `SYMPHONY_REPO_REF` | `strategy != none` | Path to the bare reference clone — pass to `git clone --reference $SYMPHONY_REPO_REF`. |
| `SYMPHONY_RECIPE` | `strategy=llm` | Absolute path to the recipe shell script — `bash $SYMPHONY_RECIPE` from `before_run`. |
| `SYMPHONY_RECIPE_DISABLED` | `review_required: true` and recipe is `.pending` | Set to `1` so hooks can skip an unreviewed recipe. |

`$WORKSPACE` is exported when the recipe runs and points to the cloned
checkout. Recipes are wrapped with `set -euo pipefail` and a forced `cd
"$WORKSPACE"`; they cannot escape the workspace.

## Recipe location

```
~/.symphony-cache/
├── refs/<repoId>.git/         # bare reference clone, shared across dispatches
└── recipes/
    ├── <stem>.sh               # final recipe (mode 600)
    ├── <stem>.json             # manifest (input hash, generated-at, etc.)
    ├── <stem>.sh.pending       # awaiting `symphony recipe approve` (review mode)
    └── <stem>.quarantined      # sentinel — daemon falls back to canned template
```

`<stem>` is `<sanitize(repoFullName)>.<8-char-sha256(repoFullName)>` so
distinct sources never collide.

## `symphony recipe` CLI

Inspect and manage the cache without editing files by hand:

```
symphony recipe list                  # enumerate cached recipes
symphony recipe show owner/repo       # print body + manifest
symphony recipe approve owner/repo    # promote .pending → final
symphony recipe reject owner/repo     # delete .pending pair
symphony recipe regen owner/repo      # force regeneration on next dispatch
symphony recipe quarantine owner/repo # write sentinel marker
symphony recipe prune --force         # wipe everything
```

`SYMPHONY_CACHE_DIR=/tmp/test-cache symphony recipe list` is supported as
a test seam — all subcommands honor the env var so you can rehearse cache
operations against a sandbox.

## Consent model

The wizard (`scripts/init.mjs`) prompts before enabling LLM-authored
recipes. After Status field confirmation, the wizard:

1. Probes the project for the most-common linked repository.
2. Shallow-clones it to a tmp directory.
3. Invokes the `symphony-workspace-bootstrap` skill via `claude` (or
   `codex`) to author a recipe.
4. Persists via `LlmRecipeProvider` (same path the daemon uses).
5. Cleans the tmp clone.

Pass `--no-eager-bootstrap` to skip and let the daemon do this lazily on
the second dispatch (the first dispatch's `after_create` runs without
`SYMPHONY_RECIPE`).

Recipes are sandboxed by the validator (`src/workspace/recipe_validator.ts`):
secret patterns rejected, blocklist rules block `pipe-to-shell`,
`destructive-rm`, `home-write`, etc., and bash `-n` syntax-checks the
body before persistence. Set `workspace.cache.review_required: true` to
require operator approval (`symphony recipe approve …`) before any
LLM-authored recipe is used by the daemon.
