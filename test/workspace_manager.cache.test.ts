import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WorkspaceManager } from "../src/workspace/manager.js";

let workspaceRoot: string;
let cacheRoot: string;
let cacheDir: string;
let upstream: string;

function makeUpstream(): string {
  const dir = mkdtempSync(join(tmpdir(), "symphony-upstream-"));
  execSync("git init --quiet", { cwd: dir });
  execSync("git config user.email 'test@example.com'", { cwd: dir });
  execSync("git config user.name 'test'", { cwd: dir });
  execSync("echo hello > README.md", { cwd: dir, shell: "/bin/bash" });
  execSync("git add . && git commit -m 'initial' --quiet", { cwd: dir, shell: "/bin/bash" });
  return dir;
}

beforeEach(() => {
  workspaceRoot = mkdtempSync(join(tmpdir(), "symphony-ws-"));
  cacheRoot = mkdtempSync(join(tmpdir(), "symphony-refs-"));
  cacheDir = mkdtempSync(join(tmpdir(), "symphony-cache-"));
  upstream = makeUpstream();
});

afterEach(() => {
  for (const p of [workspaceRoot, cacheRoot, cacheDir, upstream]) {
    if (p) rmSync(p, { recursive: true, force: true });
  }
});

const issue = () => ({
  id: "PVI_1",
  identifier: "ltk-global/symphony#42",
  title: "Implement",
  state: "Todo",
  url: null,
  repoFullName: upstream,
  branchName: null,
});

describe("WorkspaceManager cache integration", () => {
  it("reference_only exports SYMPHONY_REPO_REF and SYMPHONY_CACHE_DIR", async () => {
    const manager = new WorkspaceManager({
      root: workspaceRoot,
      cache: { strategy: "reference_only", reviewRequired: false, recipeTtlHours: 168 },
      cacheDir,
      refsOptions: { cacheRoot },
      hooks: {
        afterCreate:
          'echo "REPO_REF=$SYMPHONY_REPO_REF" > out.txt; echo "CACHE_DIR=$SYMPHONY_CACHE_DIR" >> out.txt',
      },
      hookTimeoutMs: 30_000,
    });
    const ws = await manager.prepare({ issue: issue(), attempt: null });
    const out = readFileSync(join(ws.path, "out.txt"), "utf8");
    expect(out).toContain(`REPO_REF=${cacheRoot}`);
    expect(out).toContain(`CACHE_DIR=${cacheDir}`);
    expect(ws.envSnapshot).toBeDefined();
    expect(ws.envSnapshot?.SYMPHONY_REPO_REF).toContain(cacheRoot);
    expect(ws.envSnapshot?.SYMPHONY_CACHE_DIR).toBe(cacheDir);
  });

  it("strategy=none does not export SYMPHONY_REPO_REF but still sets SYMPHONY_CACHE_DIR", async () => {
    const manager = new WorkspaceManager({
      root: workspaceRoot,
      cache: { strategy: "none", reviewRequired: false, recipeTtlHours: 168 },
      cacheDir,
      refsOptions: { cacheRoot },
      hooks: {
        afterCreate:
          'echo "REPO_REF=${SYMPHONY_REPO_REF:-UNSET}" > out.txt; echo "CACHE_DIR=$SYMPHONY_CACHE_DIR" >> out.txt',
      },
      hookTimeoutMs: 30_000,
    });
    const ws = await manager.prepare({ issue: issue(), attempt: null });
    const out = readFileSync(join(ws.path, "out.txt"), "utf8");
    expect(out).toContain("REPO_REF=UNSET");
    expect(out).toContain(`CACHE_DIR=${cacheDir}`);
    expect(ws.envSnapshot?.SYMPHONY_REPO_REF).toBeUndefined();
    expect(ws.envSnapshot?.SYMPHONY_CACHE_DIR).toBe(cacheDir);
  });

  it("propagates afterCreateOutput from the hook stdout", async () => {
    const manager = new WorkspaceManager({
      root: workspaceRoot,
      cache: { strategy: "none", reviewRequired: false, recipeTtlHours: 168 },
      cacheDir,
      hooks: {
        afterCreate: "echo HOOK_RAN_OK",
      },
      hookTimeoutMs: 10_000,
    });
    const ws = await manager.prepare({ issue: issue(), attempt: null });
    expect(ws.afterCreateOutput).toContain("HOOK_RAN_OK");
  });

  it("strategy=llm with recipeProvider exports SYMPHONY_RECIPE in cacheEnv after prepare", async () => {
    const fakeRecipePath = join(cacheDir, "recipes", "stub.sh");
    let observedRepoId: string | null = null;
    const recipeProvider = {
      ensureRecipe: async (input: { repoId: string; repoFullName: string; repoCheckoutDir: string }) => {
        observedRepoId = input.repoId;
        return ({
        recipePath: fakeRecipePath,
        manifest: {
          schema: "symphony.recipe.v1",
          repoId: input.repoId,
          repoFullName: input.repoFullName,
          generatedBy: "stub",
          generatedAt: new Date().toISOString(),
          inputHash: "sha256:stub",
          inputFiles: [],
          discoveryFiles: [],
          cacheKeys: [],
          lfs: false,
          submodules: false,
          notes: "",
          approvedBy: null,
          approvedAt: null,
        },
        generated: true,
      });
      },
    };
    const manager = new WorkspaceManager({
      root: workspaceRoot,
      cache: { strategy: "llm", reviewRequired: false, recipeTtlHours: 168 },
      cacheDir,
      refsOptions: { cacheRoot },
      recipeProvider,
      hooks: { afterCreate: 'echo "ok"', beforeRun: 'true' },
      hookTimeoutMs: 30_000,
    });
    const ws = await manager.prepare({ issue: issue(), attempt: null });
    expect(ws.cacheEnv?.SYMPHONY_RECIPE).toBe(fakeRecipePath);
    expect(ws.cacheEnv?.SYMPHONY_RECIPE_DISABLED).toBeUndefined();
    // The repoId passed to ensureRecipe must match what the wizard would
    // pass — the un-sanitized repoFullName — so eager-bootstrap recipes
    // and lazy daemon recipes share the same cache entry.
    expect(observedRepoId).toBe(issue().repoFullName);
  });

  it("strategy=llm with .pending recipePath also sets SYMPHONY_RECIPE_DISABLED=1", async () => {
    const fakeRecipePath = join(cacheDir, "recipes", "stub.sh.pending");
    const recipeProvider = {
      ensureRecipe: async () => ({
        recipePath: fakeRecipePath,
        manifest: {
          schema: "symphony.recipe.v1",
          repoId: "stub",
          repoFullName: "x/x",
          generatedBy: "stub",
          generatedAt: new Date().toISOString(),
          inputHash: "sha256:stub",
          inputFiles: [],
          discoveryFiles: [],
          cacheKeys: [],
          lfs: false,
          submodules: false,
          notes: "",
          approvedBy: null,
          approvedAt: null,
        },
        generated: true,
      }),
    };
    const manager = new WorkspaceManager({
      root: workspaceRoot,
      cache: { strategy: "llm", reviewRequired: true, recipeTtlHours: 168 },
      cacheDir,
      refsOptions: { cacheRoot },
      recipeProvider,
      hooks: { afterCreate: 'echo "ok"', beforeRun: 'true' },
      hookTimeoutMs: 30_000,
    });
    const ws = await manager.prepare({ issue: issue(), attempt: null });
    expect(ws.cacheEnv?.SYMPHONY_RECIPE).toBe(fakeRecipePath);
    expect(ws.cacheEnv?.SYMPHONY_RECIPE_DISABLED).toBe("1");
  });

  it("strategy=llm with no recipeProvider (fail-safe) does not set SYMPHONY_RECIPE", async () => {
    const manager = new WorkspaceManager({
      root: workspaceRoot,
      cache: { strategy: "llm", reviewRequired: false, recipeTtlHours: 168 },
      cacheDir,
      refsOptions: { cacheRoot },
      hooks: { afterCreate: 'echo "ok"', beforeRun: 'true' },
      hookTimeoutMs: 30_000,
    });
    const ws = await manager.prepare({ issue: issue(), attempt: null });
    expect(ws.cacheEnv?.SYMPHONY_RECIPE).toBeUndefined();
  });

  it("strategy=llm continues dispatch when recipeProvider throws", async () => {
    const recipeProvider = {
      ensureRecipe: async () => {
        throw new Error("synthetic_failure");
      },
    };
    const manager = new WorkspaceManager({
      root: workspaceRoot,
      cache: { strategy: "llm", reviewRequired: false, recipeTtlHours: 168 },
      cacheDir,
      refsOptions: { cacheRoot },
      recipeProvider,
      hooks: { afterCreate: 'echo "ok"', beforeRun: 'true' },
      hookTimeoutMs: 30_000,
    });
    const ws = await manager.prepare({ issue: issue(), attempt: null });
    expect(ws.cacheEnv?.SYMPHONY_RECIPE).toBeUndefined();
    // Workspace path itself should still exist (dispatch not blocked).
    expect(ws.path).toContain(workspaceRoot);
  });
});
