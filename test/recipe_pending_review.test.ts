import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { LlmRecipeProvider, computeInputHash } from "../src/workspace/recipes.js";

function makeAuthor(repo: string) {
  return vi.fn(async () => ({
    source: "llm" as const,
    fallback: false as const,
    recipe: "npm ci --prefer-offline",
    manifest: {
      schema: "symphony.recipe.v1",
      repoId: "PR1",
      repoFullName: "x/x",
      generatedBy: "claude-code",
      generatedAt: new Date().toISOString(),
      inputHash: await computeInputHash(repo, ["package-lock.json"]),
      inputFiles: ["package-lock.json"],
      discoveryFiles: [],
      cacheKeys: [],
      lfs: false,
      submodules: false,
      notes: "",
      approvedBy: null,
      approvedAt: null,
    },
  }));
}

describe("LlmRecipeProvider review mode", () => {
  let root: string;
  let repo: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "sym-rev-"));
    repo = mkdtempSync(join(tmpdir(), "sym-rev-repo-"));
    writeFileSync(join(repo, "package-lock.json"), "{}");
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  });

  it("writes .pending files when reviewRequired is true", async () => {
    const author = makeAuthor(repo);
    const p = new LlmRecipeProvider({ cacheRoot: root, author, reviewRequired: true });
    const r = await p.ensureRecipe({ repoId: "PR1", repoFullName: "x/x", repoCheckoutDir: repo });
    expect(r.recipePath.endsWith(".sh.pending")).toBe(true);
    expect(existsSync(join(root, "recipes", "PR1.sh.pending"))).toBe(true);
    expect(existsSync(join(root, "recipes", "PR1.json.pending"))).toBe(true);
    // The non-pending .sh file must NOT be written when review is required.
    expect(existsSync(join(root, "recipes", "PR1.sh"))).toBe(false);
    expect(existsSync(join(root, "recipes", "PR1.json"))).toBe(false);
  });

  it("does not regenerate while a pending recipe is awaiting review", async () => {
    const author = makeAuthor(repo);
    const p = new LlmRecipeProvider({ cacheRoot: root, author, reviewRequired: true });
    await p.ensureRecipe({ repoId: "PR1", repoFullName: "x/x", repoCheckoutDir: repo });
    expect(author).toHaveBeenCalledTimes(1);
    // Subsequent dispatch sees the pending pair and skips the LLM.
    const r2 = await p.ensureRecipe({ repoId: "PR1", repoFullName: "x/x", repoCheckoutDir: repo });
    expect(r2.recipePath.endsWith(".sh.pending")).toBe(true);
    expect(author).toHaveBeenCalledTimes(1);
  });
});
