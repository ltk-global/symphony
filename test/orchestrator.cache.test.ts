import { mkdtempSync, rmSync, existsSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WorkspaceManager } from "../src/workspace/manager.js";
import { LlmRecipeProvider, computeInputHash } from "../src/workspace/recipes.js";
import { makeTinyRepo } from "./integration/_fixture.js";

// Layer 4 — orchestrator-flavored full-stack test of WorkspaceManager.prepare()
// when both `cache.strategy: "llm"` AND a real `LlmRecipeProvider` are wired
// in. Asserts that the prepared workspace exposes BOTH SYMPHONY_REPO_REF
// (M2 work) AND SYMPHONY_RECIPE (M3c wire-in) — the contract the agent's
// before_run hook reads to do warm-cache restoration.
//
// The author fn is in-memory (no LLM CLI on this test) and produces a valid,
// freshly-hashed recipe so the cache hits on the second prepare.

let workspaceRoot: string;
let cacheRoot: string;
let cacheDir: string;
let upstream: string;

beforeEach(() => {
  workspaceRoot = mkdtempSync(join(tmpdir(), "ws-cache-"));
  cacheRoot = mkdtempSync(join(tmpdir(), "refs-cache-"));
  cacheDir = mkdtempSync(join(tmpdir(), "sym-cache-"));
  upstream = makeTinyRepo("orch-cache-");
});

afterEach(() => {
  for (const p of [workspaceRoot, cacheRoot, cacheDir, upstream]) {
    if (p) rmSync(p, { recursive: true, force: true });
  }
});

const issue = () => ({
  id: "PVI_X",
  identifier: "tiny#1",
  title: "test",
  state: "Todo",
  url: null,
  repoFullName: upstream,
  branchName: null,
});

function makeAuthorFor(workspaceClonedDir: () => string) {
  // Author hashes the actual cloned workspace contents so a cache hit
  // verifies the same inputs the daemon would see post-after_create.
  const make = async (input: { repoCheckoutDir: string; context: { repoId: string; repoFullName: string } }) => {
    const inputFiles = ["package.json", "pnpm-lock.yaml"];
    const inputHash = await computeInputHash(input.repoCheckoutDir, inputFiles);
    return {
      source: "llm" as const,
      fallback: false as const,
      recipe: "if [ -f pnpm-lock.yaml ]; then echo would-restore-cache; fi",
      manifest: {
        schema: "symphony.recipe.v1",
        repoId: input.context.repoId,
        repoFullName: input.context.repoFullName,
        generatedBy: "test-stub",
        generatedAt: new Date().toISOString(),
        inputHash,
        inputFiles,
        discoveryFiles: [],
        cacheKeys: [],
        lfs: false,
        submodules: false,
        notes: "",
        approvedBy: null,
        approvedAt: null,
      },
    };
  };
  return make;
}

describe("orchestrator-level workspace cache integration (Layer 4)", () => {
  it("prepare() with cache.strategy=llm exports BOTH SYMPHONY_REPO_REF and SYMPHONY_RECIPE", async () => {
    let lastWorkspaceDir = "";
    const author = makeAuthorFor(() => lastWorkspaceDir);
    const provider = new LlmRecipeProvider({
      cacheRoot: cacheDir,
      author,
      reviewRequired: false,
    });

    // The after_create hook clones the upstream so the workspace looks like
    // the real-daemon shape post-bootstrap (file inputs match what the
    // recipe author hashes).
    const manager = new WorkspaceManager({
      root: workspaceRoot,
      cache: { strategy: "llm", reviewRequired: false, recipeTtlHours: 168 },
      cacheDir,
      refsOptions: { cacheRoot },
      recipeProvider: provider,
      hooks: {
        afterCreate: `git clone --quiet "$ISSUE_REPO_FULL_NAME" .`,
      },
      hookTimeoutMs: 30_000,
    });

    const ws = await manager.prepare({ issue: issue(), attempt: null });
    lastWorkspaceDir = ws.path;

    // Both env vars present in cacheEnv (used by before_run).
    expect(ws.cacheEnv?.SYMPHONY_REPO_REF).toBeDefined();
    expect(ws.cacheEnv?.SYMPHONY_REPO_REF).toContain(cacheRoot);
    expect(ws.cacheEnv?.SYMPHONY_RECIPE).toBeDefined();
    expect(ws.cacheEnv?.SYMPHONY_RECIPE).toMatch(/recipes\/.*\.sh$/);
    expect(existsSync(ws.cacheEnv!.SYMPHONY_RECIPE!)).toBe(true);

    // The .sh body wraps the manifest body with the spec preamble/postamble.
    const recipe = readFileSync(ws.cacheEnv!.SYMPHONY_RECIPE!, "utf8");
    expect(recipe).toMatch(/set -euo pipefail/);
    expect(recipe).toContain("would-restore-cache");
    expect(recipe).toMatch(/exit 0\s*$/);
  });

  it("second prepare() reuses the cached recipe (cache hit, no re-author)", async () => {
    let authorCalls = 0;
    const baseAuthor = makeAuthorFor(() => "");
    const author = async (input: any) => {
      authorCalls += 1;
      return await baseAuthor(input);
    };
    const provider = new LlmRecipeProvider({ cacheRoot: cacheDir, author, reviewRequired: false });
    const manager = new WorkspaceManager({
      root: workspaceRoot,
      cache: { strategy: "llm", reviewRequired: false, recipeTtlHours: 168 },
      cacheDir,
      refsOptions: { cacheRoot },
      recipeProvider: provider,
      hooks: {
        afterCreate: `git clone --quiet "$ISSUE_REPO_FULL_NAME" .`,
      },
      hookTimeoutMs: 30_000,
    });
    const first = await manager.prepare({ issue: issue(), attempt: null });
    expect(authorCalls).toBe(1);
    expect(first.cacheEnv?.SYMPHONY_RECIPE).toBeDefined();

    // Second prepare() — workspace exists; no after_create hook fires; the
    // recipe lookup should be a pure cache hit.
    const second = await manager.prepare({ issue: issue(), attempt: 1 });
    expect(authorCalls).toBe(1);
    expect(second.cacheEnv?.SYMPHONY_RECIPE).toBe(first.cacheEnv?.SYMPHONY_RECIPE);
  });
});
