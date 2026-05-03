import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { rm } from "node:fs/promises";
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

describe("integration: workspace fallback after corruption", () => {
  it("recovers when the bare clone is corrupted between prepare calls", async () => {
    const manager = new WorkspaceManager({
      root: workspaceRoot,
      cache: { strategy: "reference_only", reviewRequired: false, recipeTtlHours: 168 },
      cacheDir,
      refsOptions: { cacheRoot },
      hooks: {
        afterCreate: 'echo "REF=$SYMPHONY_REPO_REF" > out.txt',
      },
      hookTimeoutMs: 30_000,
    });

    const issueA = {
      id: "PVI_1",
      identifier: "issue-a",
      title: "A",
      state: "Todo",
      repoFullName: upstream,
      branchName: null,
    };
    const issueB = { ...issueA, id: "PVI_2", identifier: "issue-b" };

    const wsA = await manager.prepare({ issue: issueA, attempt: null });
    expect(wsA.envSnapshot?.SYMPHONY_REPO_REF).toBeDefined();
    const refPath = wsA.envSnapshot!.SYMPHONY_REPO_REF!;

    // Corrupt the bare clone — wipe its objects/ directory.
    await rm(join(refPath, "objects"), { recursive: true, force: true });

    // Second prepare must succeed; ensureBareClone should recreate the bare.
    const wsB = await manager.prepare({ issue: issueB, attempt: null });
    expect(wsB.envSnapshot?.SYMPHONY_REPO_REF).toBe(refPath);
    const out = readFileSync(join(wsB.path, "out.txt"), "utf8");
    expect(out).toContain(`REF=${refPath}`);
  });
});
