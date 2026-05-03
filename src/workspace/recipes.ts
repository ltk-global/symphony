// LlmRecipeProvider — owns the `~/.symphony-cache/recipes/<repoId>.{sh,json}`
// layout. ensureRecipe() is the single entry point: cache hit returns the
// existing path; cache miss invokes the injected author function (LLM or
// fallback), validates the result with `validateRecipe`, and persists with
// the spec preamble/postamble forced around the body. A flock around the
// generation phase makes concurrent prepares share work for the same repoId.
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { createHash } from "node:crypto";
import { validateRecipe, type RecipeManifest } from "./recipe_validator.js";
import { withLock } from "./_lock.js";

export interface AuthorRecipeFn {
  (input: { context: { repoId: string; repoFullName: string }; repoCheckoutDir: string }): Promise<
    | { source: "llm"; fallback: false; recipe: string; manifest: RecipeManifest }
    | { source: null; fallback: true; reason: string }
  >;
}

export interface EnsureInput {
  repoId: string;
  repoFullName: string;
  repoCheckoutDir: string;
}

export interface EnsureResult {
  recipePath: string;
  manifest: RecipeManifest;
  generated: boolean;
}

export interface RecipeProviderOptions {
  cacheRoot?: string;
  author: AuthorRecipeFn;
  reviewRequired?: boolean;
  recipeTtlHours?: number;
}

const PREAMBLE = (manifest: RecipeManifest) =>
  `#!/usr/bin/env bash
# Symphony workspace recipe — generated ${manifest.generatedAt} by ${manifest.generatedBy} for ${manifest.repoFullName}
# Manifest: ${manifest.repoId}.json — DO NOT EDIT by hand.
set -euo pipefail
test -n "\${WORKSPACE:-}" || { echo "WORKSPACE not set" >&2; exit 64; }
cd "$WORKSPACE"

# ── recipe body ─────────────────────────────────────────────────────────────
`;

const POSTAMBLE = `
# ── end recipe body ─────────────────────────────────────────────────────────

exit 0
`;

export class LlmRecipeProvider {
  private cacheRoot: string;
  private author: AuthorRecipeFn;
  private reviewRequired: boolean;
  private recipeTtlHours: number;

  constructor(opts: RecipeProviderOptions) {
    this.cacheRoot = resolve(opts.cacheRoot ?? join(homedir(), ".symphony-cache"));
    this.author = opts.author;
    this.reviewRequired = opts.reviewRequired ?? false;
    this.recipeTtlHours = opts.recipeTtlHours ?? 168;
  }

  private paths(repoId: string) {
    const safe = repoId.replace(/[^A-Za-z0-9._-]/g, "_");
    const dir = join(this.cacheRoot, "recipes");
    return {
      sh: join(dir, `${safe}.sh`),
      json: join(dir, `${safe}.json`),
      lock: join(dir, `${safe}.lock`),
    };
  }

  async ensureRecipe(input: EnsureInput): Promise<EnsureResult> {
    const p = this.paths(input.repoId);
    await mkdir(dirname(p.sh), { recursive: true });

    // Lock-free fast path: cache hit short-circuits before we contend.
    const cached = await this.tryLoadCached(p.sh, p.json, input);
    if (cached) return cached;

    return await withLock(p.lock, { errorPrefix: "recipe_lock_timeout" }, async () => {
      // Re-check inside the lock — a concurrent caller may have just generated.
      const cachedInside = await this.tryLoadCached(p.sh, p.json, input);
      if (cachedInside) return cachedInside;

      const result = await this.author({
        context: { repoId: input.repoId, repoFullName: input.repoFullName },
        repoCheckoutDir: input.repoCheckoutDir,
      });
      if (result.fallback) {
        return await this.writeFallback(p, input);
      }

      const fullManifest: RecipeManifest = {
        ...result.manifest,
        repoId: input.repoId,
        repoFullName: input.repoFullName,
      };
      const v = validateRecipe(result.recipe, fullManifest);
      if (!v.ok) {
        // First invalid result → fall back to canned template. (M3c will
        // surface validation errors via WorkspaceManager logs / events.)
        return await this.writeFallback(p, input);
      }

      return await this.persist(p, fullManifest, result.recipe);
    });
  }

  private async persist(
    p: { sh: string; json: string },
    manifest: RecipeManifest,
    body: string,
  ): Promise<EnsureResult> {
    const sh = PREAMBLE(manifest) + body + POSTAMBLE;
    const json = JSON.stringify(manifest, null, 2);
    const target = this.reviewRequired
      ? { sh: `${p.sh}.pending`, json: `${p.json}.pending` }
      : p;
    await writeFile(target.sh, sh, { mode: 0o600 });
    await writeFile(target.json, json, { mode: 0o600 });
    return { recipePath: target.sh, manifest, generated: true };
  }

  private async tryLoadCached(
    shPath: string,
    jsonPath: string,
    input: EnsureInput,
  ): Promise<EnsureResult | null> {
    if (!existsSync(shPath) || !existsSync(jsonPath)) return null;
    let manifest: RecipeManifest;
    try {
      manifest = JSON.parse(await readFile(jsonPath, "utf8"));
    } catch {
      return null;
    }
    // Drift check — recompute over the manifest's declared input + discovery
    // sets. Adding/removing a discoveryFile entry must invalidate the cache.
    const fresh = await computeInputHash(
      input.repoCheckoutDir,
      manifest.inputFiles ?? [],
      manifest.discoveryFiles ?? [],
    );
    if (fresh !== manifest.inputHash) return null;
    // TTL check — invalid `generatedAt` parses to NaN, which fails the gate.
    const ts = new Date(manifest.generatedAt).getTime();
    const ageHours = (Date.now() - ts) / 3_600_000;
    if (!Number.isFinite(ageHours) || ageHours > this.recipeTtlHours) return null;
    return { recipePath: shPath, manifest, generated: false };
  }

  private async writeFallback(
    p: { sh: string; json: string },
    input: EnsureInput,
  ): Promise<EnsureResult> {
    const fallbackBody = `# canned fallback (no LLM available or invalid recipe)
if [ -f pnpm-lock.yaml ]; then pnpm install --frozen-lockfile --prefer-offline || true
elif [ -f package-lock.json ]; then npm ci --prefer-offline || true
elif [ -f yarn.lock ]; then yarn install --frozen-lockfile --prefer-offline || true
fi
`;
    const inputFiles = ["package-lock.json", "pnpm-lock.yaml", "yarn.lock"];
    const manifest: RecipeManifest = {
      schema: "symphony.recipe.v1",
      repoId: input.repoId,
      repoFullName: input.repoFullName,
      generatedBy: "fallback-template",
      generatedAt: new Date().toISOString(),
      inputHash: await computeInputHash(input.repoCheckoutDir, inputFiles),
      inputFiles,
      discoveryFiles: [],
      cacheKeys: [],
      lfs: false,
      submodules: false,
      notes: "canned fallback",
      approvedBy: null,
      approvedAt: null,
    };
    return await this.persistInternal(p, manifest, fallbackBody);
  }

  private async persistInternal(
    p: { sh: string; json: string },
    manifest: RecipeManifest,
    body: string,
  ): Promise<EnsureResult> {
    // Fallbacks always write to the final `.sh`/`.json` (review mode applies
    // only to LLM-authored recipes — we don't gate cans). Keep separate from
    // `persist()` so this isn't accidentally subjected to reviewRequired.
    const sh = PREAMBLE(manifest) + body + POSTAMBLE;
    await writeFile(p.sh, sh, { mode: 0o600 });
    await writeFile(p.json, JSON.stringify(manifest, null, 2), { mode: 0o600 });
    return { recipePath: p.sh, manifest, generated: true };
  }
}

// Hash the manifest's declared inputs + discovery set deterministically.
// MUST stay byte-identical to the matching .mjs copy in
// `scripts/lib/workspace-bootstrap.mjs` (parity asserted by
// `test/recipe_input_hash_parity.test.ts`). Drift between the two silently
// invalidates every cached recipe.
//
// inputFiles affect the recipe via content (read + hashed).
// discoveryFiles affect it via presence only.
export async function computeInputHash(
  rootDir: string,
  inputFiles: string[],
  discoveryFiles: string[] = [],
): Promise<string> {
  const sortedInputs = [...inputFiles].sort();
  const sortedDiscovery = [...discoveryFiles].sort();
  const reads = await Promise.all(
    sortedInputs.map(async (rel) => {
      try {
        return { rel, buf: await readFile(join(rootDir, rel)) };
      } catch {
        return { rel, buf: null as Buffer | null };
      }
    }),
  );
  const h = createHash("sha256");
  for (const { rel, buf } of reads) {
    if (buf) {
      h.update(rel + "\0");
      h.update(buf);
      h.update("\0");
    } else {
      h.update(rel + "\0__missing__\0");
    }
  }
  h.update("\0discovery\0");
  for (const rel of sortedDiscovery) {
    try {
      await stat(join(rootDir, rel));
      h.update(rel + "\0__present__\0");
    } catch {
      h.update(rel + "\0__missing__\0");
    }
  }
  return `sha256:${h.digest("hex")}`;
}
