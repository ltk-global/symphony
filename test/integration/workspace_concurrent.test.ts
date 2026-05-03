import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WorkspaceManager } from "../../src/workspace/manager.js";
import { makeTinyRepo } from "./_fixture.js";

let workspaceRoot: string;
let cacheRoot: string;
let cacheDir: string;
let upstream: string;

beforeEach(() => {
  workspaceRoot = mkdtempSync(join(tmpdir(), "ws-"));
  cacheRoot = mkdtempSync(join(tmpdir(), "refs-"));
  cacheDir = mkdtempSync(join(tmpdir(), "cache-"));
  upstream = makeTinyRepo();
});

afterEach(() => {
  for (const p of [workspaceRoot, cacheRoot, cacheDir, upstream]) {
    if (p) rmSync(p, { recursive: true, force: true });
  }
});

describe("integration: concurrent prepares for the same repo", () => {
  it("serializes 5 parallel prepares and all succeed with the same SYMPHONY_REPO_REF", async () => {
    const manager = new WorkspaceManager({
      root: workspaceRoot,
      cache: { strategy: "reference_only", reviewRequired: false, recipeTtlHours: 168 },
      cacheDir,
      refsOptions: { cacheRoot },
      hooks: { afterCreate: "true" },
      hookTimeoutMs: 30_000,
    });

    const issues = [0, 1, 2, 3, 4].map((i) => ({
      id: `PVI_${i}`,
      identifier: `issue-${i}`,
      title: `Issue ${i}`,
      state: "Todo",
      repoFullName: upstream,
      branchName: null,
    }));

    const results = await Promise.all(
      issues.map((issue) => manager.prepare({ issue, attempt: null })),
    );

    const refs = new Set(results.map((r) => r.envSnapshot?.SYMPHONY_REPO_REF));
    expect(refs.size).toBe(1);
    const ref = [...refs][0];
    expect(ref).toBeDefined();
    expect(ref).toContain(cacheRoot);
  });
});
