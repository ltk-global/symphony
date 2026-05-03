import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
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

describe("integration: workspace dispatch with reference clone", () => {
  it("runs after_create hook with SYMPHONY_REPO_REF visible and bare clone created", async () => {
    const manager = new WorkspaceManager({
      root: workspaceRoot,
      cache: { strategy: "reference_only", reviewRequired: false, recipeTtlHours: 168 },
      cacheDir,
      refsOptions: { cacheRoot },
      hooks: {
        afterCreate:
          'echo "REF=$SYMPHONY_REPO_REF" > out.txt; echo "CACHE=$SYMPHONY_CACHE_DIR" >> out.txt; ls -d "$SYMPHONY_REPO_REF/objects" >> out.txt',
      },
      hookTimeoutMs: 30_000,
    });

    const ws = await manager.prepare({
      issue: {
        id: "PVI_1",
        identifier: "tiny#1",
        title: "Test",
        state: "Todo",
        repoFullName: upstream,
        branchName: null,
      },
      attempt: null,
    });

    const out = readFileSync(join(ws.path, "out.txt"), "utf8");
    expect(out).toMatch(new RegExp(`REF=${cacheRoot}/.+\\.git`));
    expect(out).toContain(`CACHE=${cacheDir}`);
    expect(out).toContain("/objects");
    expect(ws.envSnapshot?.SYMPHONY_REPO_REF).toBeDefined();
    expect(existsSync(ws.envSnapshot!.SYMPHONY_REPO_REF!)).toBe(true);
  });
});
