import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { sanitizeWorkspaceKey, WorkspaceManager } from "../src/workspace/manager.js";

let root: string | undefined;

afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true });
  root = undefined;
});

describe("workspace manager", () => {
  it("sanitizes identifiers into stable workspace keys", () => {
    expect(sanitizeWorkspaceKey("ltk-global/symphony#42")).toBe("ltk-global_symphony_42");
    expect(sanitizeWorkspaceKey("draft:abc/123")).toBe("draft_abc_123");
  });

  it("creates a workspace and runs hooks with issue environment", async () => {
    root = await mkdtemp(join(tmpdir(), "symphony-test-"));
    const manager = new WorkspaceManager({
      root,
      hooks: {
        afterCreate: 'printf "%s|%s|%s" "$ISSUE_IDENTIFIER" "$ISSUE_WORKSPACE_KEY" "$SYMPHONY_ATTEMPT" > hook.txt',
      },
      hookTimeoutMs: 10_000,
    });

    const workspace = await manager.prepare({
      issue: {
        id: "PVI_1",
        identifier: "ltk-global/symphony#42",
        title: "Implement",
        state: "Todo",
        url: "https://github.com/ltk-global/symphony/issues/42",
        repoFullName: "ltk-global/symphony",
        branchName: null,
      },
      attempt: null,
    });

    expect(workspace.key).toBe("ltk-global_symphony_42");
    expect(await readFile(join(workspace.path, "hook.txt"), "utf8")).toBe(
      "ltk-global/symphony#42|ltk-global_symphony_42|null",
    );
  });

  it("runs after_create only when the workspace is first created", async () => {
    root = await mkdtemp(join(tmpdir(), "symphony-test-"));
    const manager = new WorkspaceManager({
      root,
      hooks: {
        afterCreate: 'printf "created\\n" >> create.log',
      },
      hookTimeoutMs: 10_000,
    });
    const input = {
      issue: {
        id: "PVI_1",
        identifier: "ltk-global/symphony#42",
        title: "Implement",
        state: "Todo",
        url: "https://github.com/ltk-global/symphony/issues/42",
        repoFullName: "ltk-global/symphony",
        branchName: null,
      },
      attempt: null,
    };

    const first = await manager.prepare(input);
    await manager.prepare(input);

    expect(await readFile(join(first.path, "create.log"), "utf8")).toBe("created\n");
  });

  it("removes a first-time workspace when after_create fails so setup can retry", async () => {
    root = await mkdtemp(join(tmpdir(), "symphony-test-"));
    const manager = new WorkspaceManager({
      root,
      hooks: {
        afterCreate: 'if [ ! -f ../failed-once ]; then touch ../failed-once; echo partial > partial.txt; exit 7; fi; echo ok > ready.txt',
      },
      hookTimeoutMs: 10_000,
    });
    const input = {
      issue: {
        id: "PVI_1",
        identifier: "ltk-global/symphony#42",
        title: "Implement",
        state: "Todo",
        url: "https://github.com/ltk-global/symphony/issues/42",
        repoFullName: "ltk-global/symphony",
        branchName: null,
      },
      attempt: null,
    };

    await expect(manager.prepare(input)).rejects.toThrow();
    await expect(access(join(root, "ltk-global_symphony_42", "partial.txt"))).rejects.toThrow();
    const workspace = await manager.prepare(input);

    expect(await readFile(join(workspace.path, "ready.txt"), "utf8")).toBe("ok\n");
  });

  it("ignores after_run and before_remove hook failures", async () => {
    root = await mkdtemp(join(tmpdir(), "symphony-test-"));
    const manager = new WorkspaceManager({
      root,
      hooks: {
        afterRun: "exit 7",
        beforeRemove: "exit 8",
      },
      hookTimeoutMs: 10_000,
    });
    const issue = {
      id: "PVI_1",
      identifier: "ltk-global/symphony#42",
      title: "Implement",
      state: "Todo",
      url: "https://github.com/ltk-global/symphony/issues/42",
      repoFullName: "ltk-global/symphony",
      branchName: null,
    };
    const workspace = await manager.prepare({ issue, attempt: null });

    await expect(manager.afterRun(workspace, issue, null)).resolves.toBeUndefined();
    await expect(manager.remove(workspace, issue)).resolves.toBeUndefined();
    await expect(access(workspace.path)).rejects.toThrow();
  });
});
