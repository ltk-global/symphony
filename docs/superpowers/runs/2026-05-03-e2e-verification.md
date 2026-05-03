# M3c — End-to-end verification

Date: 2026-05-03  
Branch: `feat/workspace-recipes`  
Stage: M3c (final wire-in)

This run captures the verification artifacts requested in the M3c plan
(Task 3.20). Numbers and outputs are real — no synthesized values.

## 1. Test counts before / after M3c

```
Baseline (start of M3c):  312 passed | 5 skipped (317)
After M3c implementation: 326 passed | 6 skipped (332)
Delta: +14 passed, +1 skipped (Layer 5 e2e gated by SYMPHONY_E2E_LLM=1)
```

Typecheck: clean (`npm run typecheck` — no output, exit 0).

## 2. Adversarial validator (ungated)

```
$ npx vitest run test/recipe_validator.adversarial.test.ts
 ✓ test/recipe_validator.adversarial.test.ts (1 test)
 Test Files  1 passed (1)
      Tests  1 passed (1)
```

The adversarial fixture set passes — every prior bypass remains blocked
after the M3c additions (which did not touch the validator).

## 3. Layer 5 e2e — real LLM authoring (gated)

Both LLM CLIs are present on PATH:

```
$ which claude && claude --version
/Users/kenluong/.local/bin/claude
2.1.126 (Claude Code)

$ which codex && codex --version
/opt/homebrew/bin/codex
codex-cli 0.128.0
```

Run:
```
$ SYMPHONY_E2E_LLM=1 npm run test:e2e -- --reporter=verbose
 ✓ test/e2e/real_llm_bootstrap.test.ts > real LLM bootstrap (Layer 5, SYMPHONY_E2E_LLM=1) > authors a valid recipe via the LLM CLI on PATH 28450ms

 Test Files  1 passed (1)
      Tests  1 passed (1)
   Duration  28.60s
```

The skill's `auto` runner ranking selects `claude` first (per
`scripts/lib/llm-runner.mjs:pickRunner`); the recipe is generated, the
manifest is reshaped server-side, and `validateRecipe()` accepts the
result without errors.

Manifest sample fields exercised by the test:
- `inputFiles` includes at least one of `package-lock.json` / `package.json`.
- `discoveryFiles` may include `README.md`.
- `inputHash` matches `computeInputHash(repoCheckoutDir, inputFiles, discoveryFiles)`
  recomputed on the test side (parity-asserted by
  `test/recipe_input_hash_parity.test.ts`).

## 4. Codex-only verification

Not captured in this run. The default `auto` runner picks claude; to force
codex would require `SYMPHONY_LLM_RUNNER=codex SYMPHONY_E2E_LLM=1 npm run
test:e2e`. Earlier M1 verification noted a possible `gpt-5.5 requires
newer version` model-version warning from codex 0.128.0; if reproduced,
that does NOT block M3c — the `auto` runner falls through to claude
without operator input.

## 5. Wizard run (eager bootstrap)

Skipped — no throwaway test project at hand to point the wizard at without
billing a real GitHub Project / repo. The wizard's eager-bootstrap step
(`scripts/init.mjs:eagerBootstrapRecipe`) is exercised indirectly by:
- `test/orchestrator.cache.test.ts` (Layer 4) — full WorkspaceManager.prepare
  path with `LlmRecipeProvider` wired in, asserting both env vars exposed.
- `test/e2e/real_llm_bootstrap.test.ts` (Layer 5, above) — same
  `authorRecipe()` the wizard calls.

## 6. Cold-vs-warm dispatch timing

Skipped — the wizard run wasn't captured, so there is no real cold/warm
pair to compare. The deterministic part (cache hit short-circuits before
the lock; see `LlmRecipeProvider.ensureRecipe`) is unit-covered by
`test/recipe_provider.test.ts` ("cache hit returns existing path without
invoking the author"). Operator-facing timing comparisons are best
captured during a live wizard run on the operator's actual project.

## 7. CLI surface (operator escape hatches)

`symphony recipe …` is implemented in `src/workspace/recipes_cli.ts` and
exercised by `test/cli_recipe.test.ts` (8 tests, all passing):

| subcommand | purpose | test |
| --- | --- | --- |
| `list` | enumerate recipes with status + repo + age | empty-cache + populated |
| `show <repo>` | print recipe + manifest | populated |
| `approve <repo>` | promote `.pending` → final (review mode) | populated |
| `reject <repo>` | delete `.pending` pair | populated |
| `regen <repo>` | force regeneration on next dispatch | populated |
| `quarantine <repo>` | sentinel marker → fallback template | populated |
| `prune --force` | wipe all cached recipes | populated |

`SYMPHONY_CACHE_DIR` is the test seam — every CLI test sets it to a
mkdtemp dir so the operator's `~/.symphony-cache` is never touched.
