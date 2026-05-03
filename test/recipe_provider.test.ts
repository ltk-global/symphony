import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync, statSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { LlmRecipeProvider } from "../src/workspace/recipes.js";
import type { RecipeManifest } from "../src/workspace/recipe_validator.js";

// Use a fresh timestamp each evaluation so cache-hit tests don't fall off
// the 168h TTL when the clock advances. Each test that returns this
// manifest from its author callback gets a current time, well within TTL.
function makeBaseManifest(): RecipeManifest {
  return {
    schema: "symphony.recipe.v1",
    repoId: "R1",
    repoFullName: "x/x",
    generatedBy: "claude-code",
    generatedAt: new Date().toISOString(),
    inputHash: "sha256:dead",
    inputFiles: ["package-lock.json"],
    discoveryFiles: [],
    cacheKeys: [],
    lfs: false,
    submodules: false,
    notes: "",
    approvedBy: null,
    approvedAt: null,
  };
}
const baseManifest = makeBaseManifest();

function makeAuthor() {
  return vi.fn().mockResolvedValue({
    source: "llm" as const,
    fallback: false as const,
    recipe: "npm ci --prefer-offline",
    manifest: { ...baseManifest },
  });
}

describe("LlmRecipeProvider", () => {
  let cacheRoot: string;
  let repo: string;
  let goodAuthor: ReturnType<typeof makeAuthor>;

  beforeEach(() => {
    cacheRoot = mkdtempSync(join(tmpdir(), "sym-rp-"));
    repo = mkdtempSync(join(tmpdir(), "sym-rp-repo-"));
    writeFileSync(join(repo, "package-lock.json"), "{}");
    goodAuthor = makeAuthor();
  });
  afterEach(() => {
    rmSync(cacheRoot, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  });

  it("cache miss invokes the author and writes recipe + manifest to disk", async () => {
    const p = new LlmRecipeProvider({ cacheRoot, author: goodAuthor as any });
    const r = await p.ensureRecipe({ repoId: "R1", repoFullName: "x/x", repoCheckoutDir: repo });
    expect(r.recipePath.endsWith(".sh")).toBe(true);
    expect(r.recipePath).toMatch(/recipes\/R1\.[a-f0-9]{8}\.sh$/);
    expect(goodAuthor).toHaveBeenCalledTimes(1);
    expect(existsSync(r.recipePath)).toBe(true);
    expect(existsSync(r.recipePath.replace(/\.sh$/, ".json"))).toBe(true);
    // Recipe wraps the body with the spec preamble + postamble.
    const sh = readFileSync(r.recipePath, "utf8");
    expect(sh).toMatch(/set -euo pipefail/);
    expect(sh).toContain("npm ci --prefer-offline");
    expect(sh).toMatch(/exit 0\s*$/);
    // Files written with mode 0o600.
    const mode = statSync(r.recipePath).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it("cache hit returns existing path without invoking the author", async () => {
    const p = new LlmRecipeProvider({ cacheRoot, author: goodAuthor as any });
    // First call writes; we need its inputHash to match a re-read.
    // Override goodAuthor to compute inputHash that matches actual repo contents.
    goodAuthor.mockImplementation(async (input: any) => {
      const { computeInputHash } = await import("../src/workspace/recipes.js");
      return {
        source: "llm",
        fallback: false,
        recipe: "npm ci",
        manifest: {
          ...baseManifest,
          inputHash: await computeInputHash(input.repoCheckoutDir, ["package-lock.json"]),
        },
      };
    });
    const r1 = await p.ensureRecipe({ repoId: "R1", repoFullName: "x/x", repoCheckoutDir: repo });
    goodAuthor.mockClear();
    const r2 = await p.ensureRecipe({ repoId: "R1", repoFullName: "x/x", repoCheckoutDir: repo });
    expect(r2.recipePath).toBe(r1.recipePath);
    expect(r2.generated).toBe(false);
    expect(goodAuthor).toHaveBeenCalledTimes(0);
  });

  it("input drift triggers regen", async () => {
    const p = new LlmRecipeProvider({ cacheRoot, author: goodAuthor as any });
    goodAuthor.mockImplementation(async (input: any) => {
      const { computeInputHash } = await import("../src/workspace/recipes.js");
      return {
        source: "llm",
        fallback: false,
        recipe: "npm ci",
        manifest: {
          ...baseManifest,
          inputHash: await computeInputHash(input.repoCheckoutDir, ["package-lock.json"]),
        },
      };
    });
    await p.ensureRecipe({ repoId: "R1", repoFullName: "x/x", repoCheckoutDir: repo });
    // Modify the lockfile in the workspace to change the hash.
    writeFileSync(join(repo, "package-lock.json"), '{"changed":true}');
    goodAuthor.mockClear();
    await p.ensureRecipe({ repoId: "R1", repoFullName: "x/x", repoCheckoutDir: repo });
    expect(goodAuthor).toHaveBeenCalledTimes(1);
  });

  it("falls back to canned template when author returns fallback", async () => {
    const fallbackAuthor = vi.fn().mockResolvedValue({
      source: null,
      fallback: true,
      reason: "no_llm",
    });
    const p = new LlmRecipeProvider({ cacheRoot, author: fallbackAuthor as any });
    const r = await p.ensureRecipe({ repoId: "R1", repoFullName: "x/x", repoCheckoutDir: repo });
    expect(r.manifest.generatedBy).toBe("fallback-template");
    expect(existsSync(r.recipePath)).toBe(true);
    const sh = readFileSync(r.recipePath, "utf8");
    expect(sh).toContain("canned fallback");
  });

  it("falls back to canned template when LLM-authored recipe is invalid", async () => {
    const evilAuthor = vi.fn().mockResolvedValue({
      source: "llm",
      fallback: false,
      recipe: "rm -rf /",
      manifest: { ...baseManifest },
    });
    const p = new LlmRecipeProvider({ cacheRoot, author: evilAuthor as any });
    const r = await p.ensureRecipe({ repoId: "R1", repoFullName: "x/x", repoCheckoutDir: repo });
    expect(r.manifest.generatedBy).toBe("fallback-template");
  });

  it("two concurrent ensureRecipe calls only invoke the author once", async () => {
    const p = new LlmRecipeProvider({ cacheRoot, author: goodAuthor as any });
    goodAuthor.mockImplementation(async (input: any) => {
      const { computeInputHash } = await import("../src/workspace/recipes.js");
      // Simulate slow LLM so the second caller hits the lock.
      await new Promise((r) => setTimeout(r, 50));
      return {
        source: "llm",
        fallback: false,
        recipe: "npm ci",
        manifest: {
          ...baseManifest,
          repoId: "R2",
          inputHash: await computeInputHash(input.repoCheckoutDir, ["package-lock.json"]),
        },
      };
    });
    const calls = await Promise.all([
      p.ensureRecipe({ repoId: "R2", repoFullName: "x/x", repoCheckoutDir: repo }),
      p.ensureRecipe({ repoId: "R2", repoFullName: "x/x", repoCheckoutDir: repo }),
    ]);
    expect(calls.every((c) => c.recipePath.endsWith(".sh"))).toBe(true);
    expect(calls[0]!.recipePath).toBe(calls[1]!.recipePath);
    expect(goodAuthor).toHaveBeenCalledTimes(1);
  });

  it("repoIds with characters that map to the same sanitized stem don't collide", async () => {
    const p = new LlmRecipeProvider({ cacheRoot, author: goodAuthor as any });
    goodAuthor.mockImplementation(async (input: any) => {
      const { computeInputHash } = await import("../src/workspace/recipes.js");
      return {
        source: "llm",
        fallback: false,
        recipe: "npm ci",
        manifest: {
          ...baseManifest,
          inputHash: await computeInputHash(input.repoCheckoutDir, ["package-lock.json"]),
        },
      };
    });
    const a = await p.ensureRecipe({ repoId: "foo/bar", repoFullName: "x/x", repoCheckoutDir: repo });
    const b = await p.ensureRecipe({ repoId: "foo_bar", repoFullName: "x/x", repoCheckoutDir: repo });
    // Both sanitize to `foo_bar` but the hash suffix disambiguates them.
    expect(a.recipePath).not.toBe(b.recipePath);
    expect(existsSync(a.recipePath)).toBe(true);
    expect(existsSync(b.recipePath)).toBe(true);
  });

  it("treats malformed cache sidecars as cache misses (no throw)", async () => {
    const p = new LlmRecipeProvider({ cacheRoot, author: goodAuthor as any });
    goodAuthor.mockImplementation(async (input: any) => {
      const { computeInputHash } = await import("../src/workspace/recipes.js");
      return {
        source: "llm",
        fallback: false,
        recipe: "npm ci",
        manifest: {
          ...baseManifest,
          inputHash: await computeInputHash(input.repoCheckoutDir, ["package-lock.json"]),
        },
      };
    });
    const r1 = await p.ensureRecipe({ repoId: "MAL", repoFullName: "x/x", repoCheckoutDir: repo });
    // Corrupt the sidecar to a valid-JSON-but-wrong-shape blob.
    const jsonPath = r1.recipePath.replace(/\.sh$/, ".json");
    writeFileSync(jsonPath, '{"inputFiles":1,"discoveryFiles":2}');
    goodAuthor.mockClear();
    // Should not throw on `[...1].sort()` etc.; should re-author.
    const r2 = await p.ensureRecipe({ repoId: "MAL", repoFullName: "x/x", repoCheckoutDir: repo });
    expect(r2.generated).toBe(true);
    expect(goodAuthor).toHaveBeenCalledTimes(1);
  });

  it("honors a `.quarantined` marker — falls back to canned template, never re-authors", async () => {
    const p = new LlmRecipeProvider({ cacheRoot, author: goodAuthor as any });
    goodAuthor.mockImplementation(async (input: any) => {
      const { computeInputHash } = await import("../src/workspace/recipes.js");
      return {
        source: "llm",
        fallback: false,
        recipe: "npm ci",
        manifest: {
          ...baseManifest,
          inputHash: await computeInputHash(input.repoCheckoutDir, ["package-lock.json"]),
        },
      };
    });
    // Drop a quarantine marker into the cache layout the provider expects.
    const { recipeStem } = await import("../src/workspace/recipes.js");
    const stem = recipeStem("Q1");
    const dir = join(cacheRoot, "recipes");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${stem}.quarantined`), JSON.stringify({ schema: "symphony.recipe.v1" }));

    const r = await p.ensureRecipe({ repoId: "Q1", repoFullName: "x/x", repoCheckoutDir: repo });
    expect(r.manifest.generatedBy).toBe("fallback-template");
    expect(goodAuthor).toHaveBeenCalledTimes(0);
  });
});
