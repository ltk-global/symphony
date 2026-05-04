# M3c follow-up — Skipped verifications, real LLM + private repo

Date: 2026-05-04
Branch: `main` (M1 + M2 + M3 already merged)
Target: `ltk-global/symphony-todo-demo` (private)

Closes the three items deferred in `2026-05-03-e2e-verification.md`:
- §5 wizard live run
- §6 cold-vs-warm dispatch timing
- review-mode roundtrip (`symphony recipe approve`)

All numbers/paths are real. LLM authoring used `claude` via the resolver in
`scripts/lib/llm-runner.mjs`.

## Bug surfaced + fixed

Running the wizard's eager bootstrap against a *private* repo failed
because `scripts/init.mjs:eagerBootstrapRecipe` still used
`Authorization: Bearer <gho_token>`, which GitHub rejects for OAuth /
user-to-server tokens. PR #5 had already migrated `src/workspace/refs.ts`
to `Basic base64(x-access-token:<token>)`, but the wizard had not been
updated. This commit applies the same fix:

```diff
- `http.extraHeader=Authorization: Bearer ${token}`,
+ const basic = Buffer.from(`x-access-token:${token}`).toString("base64");
+ `http.extraHeader=Authorization: Basic ${basic}`,
```

…and broadens the redaction regex to mask both `Bearer` and `Basic`
forms. Without this fix, every operator with a private repo hits
`fatal: Authentication failed` on `init`.

## 1. Cold-vs-warm dispatch timing

Harness: `/tmp/sym-cold-vs-warm.mjs` — instantiates `WorkspaceManager`
twice with identical config and the same fixture issue. Cold run wipes
`refs/`, `recipes/`, and the workspace; warm run only wipes the
workspace.

```
=== COLD: refs/recipe/workspace all empty ===
[COLD] elapsed=31242ms
  REPO_REF=~/.symphony-cold-warm-refs/ltk-global_symphony-todo-demo.git
  RECIPE  =~/.symphony-cold-warm-cache/recipes/ltk-global_symphony-todo-demo.e5b981a7.sh

=== WARM: only workspace cleared ===
[WARM] elapsed=1661ms
  REPO_REF=~/.symphony-cold-warm-refs/ltk-global_symphony-todo-demo.git
  RECIPE  =~/.symphony-cold-warm-cache/recipes/ltk-global_symphony-todo-demo.e5b981a7.sh

=== Summary ===
cold: 31242ms
warm: 1661ms
speedup: 18.8x
saved:   29581ms
```

The cold cost is dominated by the LLM round-trip (~24s) plus
`git clone --bare` (~5s). The warm path skips both: the bare clone is
re-used via `--reference --dissociate`, and `LlmRecipeProvider`
short-circuits before any subprocess on cache hit. End-to-end save:
~29.6s per dispatch on this fixture.

## 2. Review-mode roundtrip

Harness: `/tmp/sym-review-mode.mjs` — drives the four states explicitly.

```
=== Step 1: prepare() with review_required:true ===
  RECIPE   = …/recipes/ltk-global_symphony-todo-demo.e5b981a7.sh.pending
  DISABLED = 1

=== Step 2: symphony recipe list ===
1 recipes in ~/.symphony-review-cache/recipes:
  [pending    ] ltk-global/symphony-todo-demo  age=0m  stem=…e5b981a7
  files: …e5b981a7.json.pending, …e5b981a7.sh.pending

=== Step 3: symphony recipe approve ltk-global/symphony-todo-demo ===
approved ltk-global/symphony-todo-demo
  files: …e5b981a7.json, …e5b981a7.sh        ← .pending suffix removed

=== Step 4: re-prepare() with review_required:false ===
  RECIPE   = …/recipes/ltk-global_symphony-todo-demo.e5b981a7.sh
  DISABLED = <unset>
```

The roundtrip honors all four invariants: `review_required:true` keeps
the recipe quiescent (`DISABLED=1`, `.sh.pending` extension); `recipe
list` reflects status; `recipe approve` atomically promotes both the
script and the manifest; the next dispatch resolves to the final path
with no disable flag.

## 3. Wizard eager bootstrap, real private repo

Harness: `/tmp/sym-wizard-eager.mjs` — runs the exact code path
`scripts/init.mjs:eagerBootstrapRecipe` executes (shallow clone with
Basic auth → `LlmRecipeProvider.ensureRecipe`).

```
shallow-cloning ltk-global/symphony-todo-demo…
  cloned in 1001ms → /tmp/sym-wizard-IVymWp
  files: .git, README.md, app.js, index.html…
authoring recipe via LLM (cold)…
  → LLM call against /tmp/sym-wizard-IVymWp
  generated=true in 24238ms
  recipe path: ~/.symphony-wizard-cache/recipes/…e5b981a7.sh
  exists: true

verifying warm cache hit (re-call ensureRecipe)…
  generated=false in 1ms (false=warm hit)
```

Confirms three things end-to-end against a real private repository:
1. The Basic-auth fix actually authenticates (clone succeeds in ~1s).
2. `authorRecipe` produces a recipe parseable by `LlmRecipeProvider`
   (24s LLM round-trip; `generated=true`, `.sh` written).
3. The cache prevents re-authoring on the very next call (`generated=false`,
   1ms — entirely synchronous bookkeeping).

## Aggregate

| Item | Status | Evidence |
|---|---|---|
| Cold dispatch with empty caches | ✓ 31.2s | §1 |
| Warm dispatch with refs+recipe present | ✓ 1.7s (18.8× speedup) | §1 |
| Review-mode `.pending` → `approve` → `.sh` | ✓ all four states | §2 |
| Wizard against private repo | ✓ clone+author+warm-hit | §3 |
| Bug: wizard's Bearer auth | fixed in this commit | (above) |
