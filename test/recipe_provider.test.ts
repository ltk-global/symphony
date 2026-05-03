import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { LlmRecipeProvider } from "../src/workspace/recipes.js";
import type { RecipeManifest } from "../src/workspace/recipe_validator.js";

const baseManifest: RecipeManifest = {
  schema: "symphony.recipe.v1",
  repoId: "R1",
  repoFullName: "x/x",
  generatedBy: "claude-code",
  generatedAt: "2026-05-03T00:00:00.000Z",
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
    expect(r.recipePath.endsWith("R1.sh")).toBe(true);
    expect(goodAuthor).toHaveBeenCalledTimes(1);
    expect(existsSync(join(cacheRoot, "recipes", "R1.sh"))).toBe(true);
    expect(existsSync(join(cacheRoot, "recipes", "R1.json"))).toBe(true);
    // Recipe wraps the body with the spec preamble + postamble.
    const sh = readFileSync(join(cacheRoot, "recipes", "R1.sh"), "utf8");
    expect(sh).toMatch(/set -euo pipefail/);
    expect(sh).toContain("npm ci --prefer-offline");
    expect(sh).toMatch(/exit 0\s*$/);
    // Files written with mode 0o600.
    const mode = statSync(join(cacheRoot, "recipes", "R1.sh")).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it("cache hit returns existing path without invoking the author", async () => {
    const p = new LlmRecipeProvider({ cacheRoot, author: goodAuthor as any });
    // First call writes; we need its inputHash to match a re-read.
    // Override goodAuthor to compute inputHash that matches actual repo contents.
    goodAuthor.mockImplementation(async (input: any) => {
      const { computeInputHashForTest } = await import("../src/workspace/recipes.js");
      return {
        source: "llm",
        fallback: false,
        recipe: "npm ci",
        manifest: {
          ...baseManifest,
          inputHash: await computeInputHashForTest(input.repoCheckoutDir, ["package-lock.json"]),
        },
      };
    });
    await p.ensureRecipe({ repoId: "R1", repoFullName: "x/x", repoCheckoutDir: repo });
    goodAuthor.mockClear();
    const r2 = await p.ensureRecipe({ repoId: "R1", repoFullName: "x/x", repoCheckoutDir: repo });
    expect(r2.recipePath.endsWith("R1.sh")).toBe(true);
    expect(r2.generated).toBe(false);
    expect(goodAuthor).toHaveBeenCalledTimes(0);
  });

  it("input drift triggers regen", async () => {
    const p = new LlmRecipeProvider({ cacheRoot, author: goodAuthor as any });
    goodAuthor.mockImplementation(async (input: any) => {
      const { computeInputHashForTest } = await import("../src/workspace/recipes.js");
      return {
        source: "llm",
        fallback: false,
        recipe: "npm ci",
        manifest: {
          ...baseManifest,
          inputHash: await computeInputHashForTest(input.repoCheckoutDir, ["package-lock.json"]),
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
    expect(existsSync(join(cacheRoot, "recipes", "R1.sh"))).toBe(true);
    const sh = readFileSync(join(cacheRoot, "recipes", "R1.sh"), "utf8");
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
      const { computeInputHashForTest } = await import("../src/workspace/recipes.js");
      // Simulate slow LLM so the second caller hits the lock.
      await new Promise((r) => setTimeout(r, 50));
      return {
        source: "llm",
        fallback: false,
        recipe: "npm ci",
        manifest: {
          ...baseManifest,
          repoId: "R2",
          inputHash: await computeInputHashForTest(input.repoCheckoutDir, ["package-lock.json"]),
        },
      };
    });
    const calls = await Promise.all([
      p.ensureRecipe({ repoId: "R2", repoFullName: "x/x", repoCheckoutDir: repo }),
      p.ensureRecipe({ repoId: "R2", repoFullName: "x/x", repoCheckoutDir: repo }),
    ]);
    expect(calls.every((c) => c.recipePath.endsWith("R2.sh"))).toBe(true);
    expect(goodAuthor).toHaveBeenCalledTimes(1);
  });
});
