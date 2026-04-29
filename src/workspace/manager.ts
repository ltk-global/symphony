import { mkdir, rm } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { exec } from "node:child_process";
import { promisify } from "node:util";
import { log } from "../log.js";

const execAsync = promisify(exec);

export interface WorkspaceIssueInput {
  id: string;
  identifier: string;
  title: string;
  state: string;
  url?: string | null;
  repoFullName?: string | null;
  branchName?: string | null;
}

export interface WorkspaceManagerOptions {
  root: string;
  hooks?: {
    afterCreate?: string;
    beforeRun?: string;
    afterRun?: string;
    beforeRemove?: string;
  };
  hookTimeoutMs?: number;
}

export interface WorkspaceRef {
  key: string;
  path: string;
}

export class WorkspaceManager {
  private readonly root: string;
  private readonly hooks: Required<NonNullable<WorkspaceManagerOptions["hooks"]>>;
  private readonly hookTimeoutMs: number;

  constructor(options: WorkspaceManagerOptions) {
    this.root = resolve(options.root);
    this.hooks = {
      afterCreate: options.hooks?.afterCreate ?? "",
      beforeRun: options.hooks?.beforeRun ?? "",
      afterRun: options.hooks?.afterRun ?? "",
      beforeRemove: options.hooks?.beforeRemove ?? "",
    };
    this.hookTimeoutMs = options.hookTimeoutMs ?? 60_000;
  }

  async prepare(input: { issue: WorkspaceIssueInput; attempt: number | null }): Promise<WorkspaceRef> {
    const key = sanitizeWorkspaceKey(input.issue.identifier);
    const path = this.workspacePath(key);
    await mkdir(this.root, { recursive: true });
    let created = false;
    try {
      await mkdir(path);
      created = true;
    } catch (error) {
      if (!isNodeError(error) || error.code !== "EEXIST") throw error;
    }
    if (created) {
      try {
        await this.runHook(this.hooks.afterCreate, path, input.issue, key, input.attempt);
      } catch (error) {
        await rm(path, { recursive: true, force: true });
        throw error;
      }
    }
    return { key, path };
  }

  async beforeRun(workspace: WorkspaceRef, issue: WorkspaceIssueInput, attempt: number | null): Promise<void> {
    await this.runHook(this.hooks.beforeRun, workspace.path, issue, workspace.key, attempt);
  }

  async afterRun(workspace: WorkspaceRef, issue: WorkspaceIssueInput, attempt: number | null): Promise<void> {
    try {
      await this.runHook(this.hooks.afterRun, workspace.path, issue, workspace.key, attempt);
    } catch (error) {
      log.warn({ error, issue_id: issue.id, issue_identifier: issue.identifier }, "after_run hook failed");
      return;
    }
  }

  async remove(workspace: WorkspaceRef, issue: WorkspaceIssueInput): Promise<void> {
    try {
      await this.runHook(this.hooks.beforeRemove, workspace.path, issue, workspace.key, null);
    } catch (error) {
      log.warn({ error, issue_id: issue.id, issue_identifier: issue.identifier }, "before_remove hook failed");
    }
    await rm(workspace.path, { recursive: true, force: true });
  }

  refForIssue(issue: Pick<WorkspaceIssueInput, "identifier">): WorkspaceRef {
    const key = sanitizeWorkspaceKey(issue.identifier);
    return { key, path: this.workspacePath(key) };
  }

  private workspacePath(key: string): string {
    const path = resolve(join(this.root, key));
    const rel = relative(this.root, path);
    if (rel.startsWith("..") || isAbsolute(rel)) throw new Error("workspace_path_outside_root");
    return path;
  }

  private async runHook(
    script: string,
    cwd: string,
    issue: WorkspaceIssueInput,
    workspaceKey: string,
    attempt: number | null,
  ): Promise<void> {
    if (!script.trim()) return;
    await execAsync(script, {
      cwd,
      shell: "/bin/bash",
      timeout: this.hookTimeoutMs,
      env: {
        ...process.env,
        ISSUE_ID: issue.id,
        ISSUE_IDENTIFIER: issue.identifier,
        ISSUE_TITLE: issue.title,
        ISSUE_STATE: issue.state,
        ISSUE_URL: issue.url ?? "",
        ISSUE_REPO_FULL_NAME: issue.repoFullName ?? "",
        ISSUE_BRANCH_NAME: issue.branchName ?? "",
        ISSUE_WORKSPACE_KEY: workspaceKey,
        ISSUE_WORKSPACE_PATH: cwd,
        SYMPHONY_ATTEMPT: attempt === null ? "null" : String(attempt),
      },
    });
  }
}

export function sanitizeWorkspaceKey(identifier: string): string {
  return identifier.replace(/[^A-Za-z0-9._-]/g, "_");
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
