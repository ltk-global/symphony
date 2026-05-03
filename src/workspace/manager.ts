import { mkdir, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { exec } from "node:child_process";
import { promisify } from "node:util";
import { log } from "../log.js";
import { ensureBareClone, type RefsOptions } from "./refs.js";

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

export type WorkspaceCacheStrategy = "llm" | "reference_only" | "none";

export interface WorkspaceCacheOptions {
  strategy: WorkspaceCacheStrategy;
  reviewRequired: boolean;
  recipeTtlHours: number;
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
  cache?: WorkspaceCacheOptions;
  cacheDir?: string;
  refsOptions?: RefsOptions;
  githubToken?: string;
}

export interface WorkspaceRef {
  key: string;
  path: string;
  afterCreateOutput?: string;
  envSnapshot?: Record<string, string | undefined>;
  // Cached cache-env (SYMPHONY_CACHE_DIR + SYMPHONY_REPO_REF). Set by prepare()
  // so beforeRun/afterRun/remove don't redo the bare-clone fetch each call.
  cacheEnv?: Record<string, string | undefined>;
}

const DEFAULT_CACHE: WorkspaceCacheOptions = {
  strategy: "none",
  reviewRequired: false,
  recipeTtlHours: 168,
};

export class WorkspaceManager {
  private readonly root: string;
  private readonly hooks: Required<NonNullable<WorkspaceManagerOptions["hooks"]>>;
  private readonly hookTimeoutMs: number;
  private readonly cache: WorkspaceCacheOptions;
  private readonly cacheDir: string;
  private readonly refsOptions: RefsOptions;
  private readonly githubToken: string | undefined;

  constructor(options: WorkspaceManagerOptions) {
    this.root = resolve(options.root);
    this.hooks = {
      afterCreate: options.hooks?.afterCreate ?? "",
      beforeRun: options.hooks?.beforeRun ?? "",
      afterRun: options.hooks?.afterRun ?? "",
      beforeRemove: options.hooks?.beforeRemove ?? "",
    };
    this.hookTimeoutMs = options.hookTimeoutMs ?? 60_000;
    this.cache = options.cache ?? DEFAULT_CACHE;
    this.cacheDir = options.cacheDir ?? join(homedir(), ".symphony-cache");
    this.refsOptions = options.refsOptions ?? {};
    this.githubToken = options.githubToken;
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

    const cacheEnv = await this.computeCacheEnv(input.issue);

    if (created) {
      try {
        const result = await this.runHook(
          this.hooks.afterCreate,
          path,
          input.issue,
          key,
          input.attempt,
          cacheEnv,
        );
        return { key, path, afterCreateOutput: result.stdout, envSnapshot: result.envSnapshot, cacheEnv };
      } catch (error) {
        await rm(path, { recursive: true, force: true });
        throw error;
      }
    }
    return { key, path, envSnapshot: { ...cacheEnv }, cacheEnv };
  }

  async beforeRun(workspace: WorkspaceRef, issue: WorkspaceIssueInput, attempt: number | null): Promise<void> {
    if (!this.hooks.beforeRun.trim()) return;
    const cacheEnv = workspace.cacheEnv ?? await this.computeCacheEnv(issue);
    await this.runHook(this.hooks.beforeRun, workspace.path, issue, workspace.key, attempt, cacheEnv);
  }

  async afterRun(workspace: WorkspaceRef, issue: WorkspaceIssueInput, attempt: number | null): Promise<void> {
    if (!this.hooks.afterRun.trim()) return;
    try {
      const cacheEnv = workspace.cacheEnv ?? await this.computeCacheEnv(issue);
      await this.runHook(this.hooks.afterRun, workspace.path, issue, workspace.key, attempt, cacheEnv);
    } catch (error) {
      log.warn({ error, issue_id: issue.id, issue_identifier: issue.identifier }, "after_run hook failed");
      return;
    }
  }

  async remove(workspace: WorkspaceRef, issue: WorkspaceIssueInput): Promise<void> {
    if (this.hooks.beforeRemove.trim()) {
      try {
        const cacheEnv = workspace.cacheEnv ?? await this.computeCacheEnv(issue);
        await this.runHook(this.hooks.beforeRemove, workspace.path, issue, workspace.key, null, cacheEnv);
      } catch (error) {
        log.warn({ error, issue_id: issue.id, issue_identifier: issue.identifier }, "before_remove hook failed");
      }
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

  private async computeCacheEnv(issue: WorkspaceIssueInput): Promise<Record<string, string | undefined>> {
    const env: Record<string, string | undefined> = {
      SYMPHONY_CACHE_DIR: this.cacheDir,
    };
    if (this.cache.strategy === "none") return env;
    if (!issue.repoFullName) return env;
    const isPath = isAbsolute(issue.repoFullName);
    const token = this.githubToken ?? process.env.GITHUB_TOKEN;
    if (!isPath && !token) {
      log.warn(
        { issue_id: issue.id, issue_identifier: issue.identifier, repo: issue.repoFullName },
        "missing_github_token_skipping_reference_clone",
      );
      return env;
    }
    try {
      const repoId = sanitizeWorkspaceKey(issue.repoFullName);
      // Use the public clone URL (no token) so it's safe to persist in the
      // bare's remote.origin.url. Auth is supplied per-invocation via
      // `git -c http.extraHeader=...` so the token never lands on disk.
      const cloneUrl = isPath
        ? issue.repoFullName
        : `https://github.com/${issue.repoFullName}.git`;
      const authHeader = !isPath && token ? `Authorization: Bearer ${token}` : undefined;
      const refPath = await ensureBareClone(repoId, cloneUrl, {
        ...this.refsOptions,
        authHeader,
      });
      env.SYMPHONY_REPO_REF = refPath;
    } catch (error) {
      log.warn(
        { error, issue_id: issue.id, issue_identifier: issue.identifier, repo: issue.repoFullName },
        "ensure_bare_clone_failed_skipping_reference",
      );
    }
    return env;
  }

  private async runHook(
    script: string,
    cwd: string,
    issue: WorkspaceIssueInput,
    workspaceKey: string,
    attempt: number | null,
    extraEnv: Record<string, string | undefined>,
  ): Promise<{ stdout: string; envSnapshot: Record<string, string | undefined> }> {
    const envSnapshot: Record<string, string | undefined> = {
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
      ...extraEnv,
    };
    if (!script.trim()) return { stdout: "", envSnapshot };
    const { stdout } = await execAsync(script, {
      cwd,
      shell: "/bin/bash",
      timeout: this.hookTimeoutMs,
      env: {
        ...process.env,
        ...envSnapshot,
      },
    });
    return { stdout: typeof stdout === "string" ? stdout : "", envSnapshot };
  }
}

export function sanitizeWorkspaceKey(identifier: string): string {
  return identifier.replace(/[^A-Za-z0-9._-]/g, "_");
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
