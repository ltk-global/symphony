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

// Minimal contract for the recipe provider, kept structural so tests can pass
// a stub without importing the real LlmRecipeProvider class. Matches the
// shape of `LlmRecipeProvider.ensureRecipe` in src/workspace/recipes.ts.
export interface WorkspaceRecipeProvider {
  ensureRecipe(input: {
    repoId: string;
    repoFullName: string;
    repoCheckoutDir: string;
  }): Promise<{ recipePath: string; manifest: unknown; generated: boolean }>;
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
  recipeProvider?: WorkspaceRecipeProvider;
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
  private readonly recipeProvider: WorkspaceRecipeProvider | undefined;

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
    this.recipeProvider = options.recipeProvider;
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
        // Lazy recipe bootstrap — only after the after_create hook clones the
        // workspace successfully. The recipe is generated for SUBSEQUENT
        // invocations (before_run / next dispatch), not the current
        // after_create. The wizard's eager bootstrap covers the first-issue
        // cold-dispatch path so this only fires when the wizard was skipped
        // OR a new repo has shown up since the wizard ran.
        await this.maybeGenerateRecipe(input.issue, path, cacheEnv);
        return { key, path, afterCreateOutput: result.stdout, envSnapshot: { ...result.envSnapshot, ...cacheEnv }, cacheEnv };
      } catch (error) {
        await rm(path, { recursive: true, force: true });
        throw error;
      }
    }
    // Existing workspace re-use — try to surface a previously-cached recipe
    // so before_run sees the same cacheEnv as a fresh prepare.
    await this.maybeGenerateRecipe(input.issue, path, cacheEnv);
    return { key, path, envSnapshot: { ...cacheEnv }, cacheEnv };
  }

  private async maybeGenerateRecipe(
    issue: WorkspaceIssueInput,
    workspaceDir: string,
    cacheEnv: Record<string, string | undefined>,
  ): Promise<void> {
    if (this.cache.strategy !== "llm") return;
    if (!this.recipeProvider) return;
    if (!issue.repoFullName) return;
    try {
      const result = await this.recipeProvider.ensureRecipe({
        // Use repoFullName as the cache key on both sides (daemon + wizard
        // eager bootstrap). recipeStem() sanitizes internally and includes
        // a hash suffix; double-sanitizing here would diverge from the
        // wizard's lookup key.
        repoId: issue.repoFullName,
        repoFullName: issue.repoFullName,
        repoCheckoutDir: workspaceDir,
      });
      cacheEnv.SYMPHONY_RECIPE = result.recipePath;
      // `.pending` recipes are gated behind operator review — surface them so
      // the agent's hook can choose to skip-or-warn rather than silently run
      // an unreviewed bootstrap. The default convention: any consumer that
      // sees SYMPHONY_RECIPE_DISABLED=1 should treat the recipe as advisory.
      if (result.recipePath.endsWith(".pending")) {
        cacheEnv.SYMPHONY_RECIPE_DISABLED = "1";
      }
    } catch (error) {
      log.warn(
        { error, issue_id: issue.id, issue_identifier: issue.identifier },
        "recipe_provider_failed_skipping",
      );
    }
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
