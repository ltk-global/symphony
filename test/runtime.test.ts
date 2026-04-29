import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanupTerminalWorkspaces } from "../src/runtime.js";
import { WorkspaceManager } from "../src/workspace/manager.js";

let root: string | undefined;

afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true });
  root = undefined;
});

describe("runtime helpers", () => {
  it("removes workspaces for terminal project items during startup cleanup", async () => {
    root = await mkdtemp(join(tmpdir(), "symphony-runtime-test-"));
    const workspace = new WorkspaceManager({
      root,
      hooks: { beforeRemove: 'printf "$ISSUE_IDENTIFIER" > ../removed.txt' },
      hookTimeoutMs: 10_000,
    });
    const issue = {
      id: "PVI_1",
      identifier: "ltk-global/symphony#42",
      title: "Done work",
      state: "Done",
      url: null,
      repoFullName: "ltk-global/symphony",
      branchName: null,
    };
    await workspace.prepare({ issue, attempt: null });
    const tracker = { fetchIssuesByStates: vi.fn(async () => [issue]) };

    await cleanupTerminalWorkspaces(tracker as any, workspace, ["Done"]);

    expect(tracker.fetchIssuesByStates).toHaveBeenCalledWith(["Done"]);
    await expect(readFile(join(root, "ltk-global_symphony_42"), "utf8")).rejects.toThrow();
    expect(await readFile(join(root, "removed.txt"), "utf8")).toBe("ltk-global/symphony#42");
  });
});
