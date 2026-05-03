// LlmRecipeProvider — owns the `~/.symphony-cache/recipes/<repoId>.{sh,json}`
// layout. ensureRecipe() is the single entry point: cache hit returns the
// existing path; cache miss invokes the injected author function (LLM or
// fallback), validates the result with `validateRecipe`, and persists with
// the spec preamble/postamble forced around the body. A flock around the
// generation phase makes concurrent prepares share work for the same repoId.
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile, open, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { createHash } from "node:crypto";
import { validateRecipe, type RecipeManifest } from "./recipe_validator.js";

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

const LOCK_RETRY_MS = 50;
// 15 min — long enough for an LLM author call (default 2-min runner timeout
// times a small retry budget) without giving up early under contention.
const LOCK_TIMEOUT_MS = 900_000;

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

  paths(repoId: string) {
    const safe = repoId.replace(/[^A-Za-z0-9._-]/g, "_");
    const dir = join(this.cacheRoot, "recipes");
    return {
      sh: join(dir, `${safe}.sh`),
      json: join(dir, `${safe}.json`),
      pendingSh: join(dir, `${safe}.sh.pending`),
      pendingJson: join(dir, `${safe}.json.pending`),
      lock: join(dir, `${safe}.lock`),
    };
  }

  async ensureRecipe(input: EnsureInput): Promise<EnsureResult> {
    const p = this.paths(input.repoId);
    await mkdir(dirname(p.sh), { recursive: true });

    // Lock-free fast path: cache hit short-circuits before we contend.
    const cached = await this.tryLoadCached(p.sh, p.json, input);
    if (cached) return cached;

    return await withLock(p.lock, async () => {
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

      const finalSh = PREAMBLE(fullManifest) + result.recipe + POSTAMBLE;
      if (this.reviewRequired) {
        await writeFile(p.pendingSh, finalSh, { mode: 0o600 });
        await writeFile(p.pendingJson, JSON.stringify(fullManifest, null, 2), { mode: 0o600 });
        return { recipePath: p.pendingSh, manifest: fullManifest, generated: true };
      }
      await writeFile(p.sh, finalSh, { mode: 0o600 });
      await writeFile(p.json, JSON.stringify(fullManifest, null, 2), { mode: 0o600 });
      return { recipePath: p.sh, manifest: fullManifest, generated: true };
    });
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
    // Drift check — recompute over the manifest's declared input set.
    const fresh = await computeInputHash(input.repoCheckoutDir, manifest.inputFiles ?? []);
    if (fresh !== manifest.inputHash) return null;
    // TTL check — invalid `generatedAt` parses to NaN, which fails the gate.
    const ts = new Date(manifest.generatedAt).getTime();
    const ageHours = (Date.now() - ts) / 3_600_000;
    if (!Number.isFinite(ageHours) || ageHours > this.recipeTtlHours) return null;
    return { recipePath: shPath, manifest, generated: false };
  }

  private async writeFallback(
    p: ReturnType<LlmRecipeProvider["paths"]>,
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
    const sh = PREAMBLE(manifest) + fallbackBody + POSTAMBLE;
    await writeFile(p.sh, sh, { mode: 0o600 });
    await writeFile(p.json, JSON.stringify(manifest, null, 2), { mode: 0o600 });
    return { recipePath: p.sh, manifest, generated: true };
  }
}

async function computeInputHash(rootDir: string, files: string[]): Promise<string> {
  const h = createHash("sha256");
  for (const rel of [...files].sort()) {
    const p = join(rootDir, rel);
    if (existsSync(p)) {
      const buf = await readFile(p);
      h.update(rel + "\0");
      h.update(buf);
      h.update("\0");
    } else {
      h.update(rel + "\0__missing__\0");
    }
  }
  return `sha256:${h.digest("hex")}`;
}

// Test-only helper so suite can synthesize manifests with hashes that
// match the fixture repo. Not part of the public API.
export async function computeInputHashForTest(rootDir: string, files: string[]): Promise<string> {
  return await computeInputHash(rootDir, files);
}

// flock — same shape as `refs.ts:withLock` but kept inline so the recipes
// module doesn't reach into the bare-clone module's privates.
async function withLock<T>(lockPath: string, fn: () => Promise<T>): Promise<T> {
  const start = Date.now();
  let handle: Awaited<ReturnType<typeof open>> | null = null;
  while (true) {
    try {
      handle = await open(lockPath, "wx");
      break;
    } catch (err) {
      if (!isErrnoException(err) || err.code !== "EEXIST") throw err;
      if (Date.now() - start > LOCK_TIMEOUT_MS) {
        throw new Error(`recipe_lock_timeout:${lockPath}`);
      }
      await sleep(LOCK_RETRY_MS);
    }
  }
  try {
    return await fn();
  } finally {
    try {
      await handle.close();
    } catch {
      // ignore
    }
    try {
      await unlink(lockPath);
    } catch {
      // ignore
    }
  }
}

function isErrnoException(err: unknown): err is NodeJS.ErrnoException {
  return err instanceof Error && "code" in err;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
