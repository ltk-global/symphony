import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { LlmRecipeProvider } from "../src/workspace/recipes.js";

const author = async () => ({
  source: "llm" as const,
  fallback: false as const,
  recipe: "npm ci --prefer-offline",
  manifest: {
    schema: "symphony.recipe.v1",
    repoId: "PR1",
    repoFullName: "x/x",
    generatedBy: "claude-code",
    generatedAt: "2026-05-03T00:00:00.000Z",
    inputHash: "sha256:0",
    inputFiles: ["package-lock.json"],
    discoveryFiles: [],
    cacheKeys: [],
    lfs: false,
    submodules: false,
    notes: "",
    approvedBy: null,
    approvedAt: null,
  },
});

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
    const p = new LlmRecipeProvider({ cacheRoot: root, author, reviewRequired: true });
    const r = await p.ensureRecipe({ repoId: "PR1", repoFullName: "x/x", repoCheckoutDir: repo });
    expect(r.recipePath.endsWith(".sh.pending")).toBe(true);
    expect(existsSync(join(root, "recipes", "PR1.sh.pending"))).toBe(true);
    expect(existsSync(join(root, "recipes", "PR1.json.pending"))).toBe(true);
    // The non-pending .sh file must NOT be written when review is required.
    expect(existsSync(join(root, "recipes", "PR1.sh"))).toBe(false);
    expect(existsSync(join(root, "recipes", "PR1.json"))).toBe(false);
  });
});
