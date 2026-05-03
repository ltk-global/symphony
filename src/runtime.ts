import { stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, resolve, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { loadWorkflow, renderPrompt } from "./workflow/loader.js";
import { buildConfig, type ServiceConfig } from "./config/index.js";
import { GitHubProjectsTracker } from "./tracker/github_projects.js";
import { WorkspaceManager, type WorkspaceIssueInput, type WorkspaceRecipeProvider } from "./workspace/manager.js";
import { LlmRecipeProvider, type AuthorRecipeFn } from "./workspace/recipes.js";
import { ClaudeCodeAdapter } from "./agent/claude_code.js";
import { CodexAdapter } from "./agent/codex.js";
import { Orchestrator } from "./orchestrator/index.js";
import { IrisClient } from "./iris/client.js";
import { VerifyStage } from "./verify/stage.js";
import { FileEventLog, type EventLog } from "./observability/event_log.js";
import { eventLogPath } from "./observability/data_dir.js";
import { EventHookRunner } from "./hooks/event_hooks.js";
import { log } from "./log.js";

export interface RuntimeComponents {
  config: ServiceConfig;
  orchestrator: Orchestrator;
  tracker: GitHubProjectsTracker;
  workspace: WorkspaceManager;
  eventLog: EventLog;
}

export class SymphonyRuntime {
  private components: RuntimeComponents | null = null;
  private workflowMtimeMs = -1;

  constructor(
    private readonly workflowPath: string,
    private readonly env: NodeJS.ProcessEnv = process.env,
  ) {}

  async initialize(): Promise<void> {
    await this.reload(true);
    if (this.components) await cleanupTerminalWorkspaces(this.components.tracker, this.components.workspace, this.components.config.tracker.terminalStates);
  }

  async tick(): Promise<void> {
    await this.reload(false);
    if (!this.components) throw new Error("runtime_not_initialized");
    await this.components.orchestrator.tick();
  }

  snapshot(): ReturnType<Orchestrator["snapshot"]> | null {
    return this.components?.orchestrator.snapshot() ?? null;
  }

  pollIntervalMs(): number {
    return this.components?.config.polling.intervalMs ?? 30_000;
  }

  serviceConfig(): ServiceConfig | null {
    return this.components?.config ?? null;
  }

  orchestratorRef(): Orchestrator | null {
    return this.components?.orchestrator ?? null;
  }

  private async reload(force: boolean): Promise<void> {
    const workflowPath = resolve(this.workflowPath);
    const stats = await stat(workflowPath);
    if (!force && stats.mtimeMs === this.workflowMtimeMs) return;
    if (!force && this.components && this.components.orchestrator.snapshot().running > 0) return;
    try {
      this.components = await buildRuntimeComponents(workflowPath, this.env);
      this.workflowMtimeMs = stats.mtimeMs;
    } catch (error) {
      if (!this.components) throw error;
      log.error({ error }, "workflow reload failed; keeping last known good config");
    }
  }
}

export async function buildRuntimeComponents(workflowPath: string, env: NodeJS.ProcessEnv = process.env): Promise<RuntimeComponents> {
  const absoluteWorkflowPath = resolve(workflowPath);
  const workflow = await loadWorkflow(absoluteWorkflowPath);
  const config = buildConfig(workflow.config, env, { baseDir: dirname(absoluteWorkflowPath), workflowPath: absoluteWorkflowPath });
  configureIrisEnvironment(config, env);
  const fileEventLog = new FileEventLog(eventLogPath(config.dataDir));
  const eventLog: EventLog = fileEventLog;
  const hookRunner = new EventHookRunner({ rules: config.hooks.onEvent });
  if (hookRunner.ruleCount > 0) {
    fileEventLog.setObserver((event) => hookRunner.fire(event));
    log.info({ ruleCount: hookRunner.ruleCount }, "event hooks registered");
  }
  await eventLog.emit({
    type: "daemon_reload",
    payload: {
      workflowPath: absoluteWorkflowPath,
      dataDir: config.dataDir,
      agentKind: config.agent.kind,
      irisEnabled: config.iris.enabled,
      eventHookRuleCount: hookRunner.ruleCount,
    },
  });
  const tracker = new GitHubProjectsTracker({
    endpoint: config.tracker.endpoint,
    apiToken: config.tracker.apiToken,
    projectUrl: config.tracker.projectUrl,
    projectOwner: config.tracker.projectOwner,
    projectNumber: config.tracker.projectNumber,
    statusField: config.tracker.statusField,
    priorityField: config.tracker.priorityField,
    activeStates: config.tracker.activeStates,
    terminalStates: config.tracker.terminalStates,
    filters: config.tracker.filters,
  });
  // One cache root drives BOTH the recipe provider's storage and the
  // SYMPHONY_CACHE_DIR env var that hooks read. Recipes write into
  // $SYMPHONY_CACHE_DIR (e.g., `node_modules` cache), so the two MUST
  // match — otherwise hooks export one path while the provider stores
  // recipes under another. SYMPHONY_CACHE_DIR is the operator override
  // (also used by `symphony recipe …`); falls back to undefined so
  // both sides take their default `~/.symphony-cache`. Read from the
  // injected `env` object (callers may pass a custom env).
  const cacheRootOverride = env.SYMPHONY_CACHE_DIR;
  const recipeProvider: WorkspaceRecipeProvider | undefined =
    config.workspace.cache.strategy === "llm"
      ? new LlmRecipeProvider({
          cacheRoot: cacheRootOverride,
          author: createAuthorRecipe(),
          reviewRequired: config.workspace.cache.reviewRequired,
          recipeTtlHours: config.workspace.cache.recipeTtlHours,
        })
      : undefined;
  const workspace = new WorkspaceManager({
    root: config.workspace.root,
    hooks: config.hooks,
    hookTimeoutMs: config.hooks.timeoutMs,
    cacheDir: cacheRootOverride,
    cache: config.workspace.cache,
    githubToken: config.tracker.apiToken,
    recipeProvider,
  });
  const runner =
    config.agent.kind === "codex"
      ? new CodexAdapter({ command: String(config.codex.command ?? "codex app-server"), config: config.codex })
      : new ClaudeCodeAdapter(config.claudeCode);
  const iris = config.iris.enabled
    ? new IrisClient({
        baseUrl: config.iris.baseUrl,
        token: config.iris.token,
        maxConcurrent: config.iris.maxConcurrent,
        requestTimeoutMs: config.iris.requestTimeoutMs,
        sharedSemaphoreKey: env.SYMPHONY_IRIS_SHARED_SEMAPHORE_KEY,
      })
    : null;
  const verifyStage = iris ? new VerifyStage({ tracker, iris, eventLog }) : undefined;
  const orchestrator = new Orchestrator({
    tracker,
    workspace,
    runner,
    verifyStage,
    iris: iris ?? undefined,
    config,
    eventLog,
    renderPrompt: ({ issue, attempt, tools }) => renderPrompt(workflow.promptTemplate, { issue: aliasIssue(issue), attempt, tools }),
  });
  return { config, orchestrator, tracker, workspace, eventLog };
}

export async function cleanupTerminalWorkspaces(
  tracker: Pick<GitHubProjectsTracker, "fetchIssuesByStates">,
  workspace: Pick<WorkspaceManager, "refForIssue" | "remove">,
  terminalStates: string[],
): Promise<void> {
  let terminalIssues: WorkspaceIssueInput[];
  try {
    terminalIssues = await tracker.fetchIssuesByStates(terminalStates);
  } catch (error) {
    log.warn({ error }, "startup terminal workspace cleanup failed to fetch issues");
    return;
  }
  for (const issue of terminalIssues) {
    const ref = workspace.refForIssue(issue);
    try {
      await workspace.remove(ref, issue);
    } catch (error) {
      log.warn({ error, issue_id: issue.id, issue_identifier: issue.identifier }, "startup terminal workspace cleanup failed");
    }
  }
}

// Liquid templates often want snake_case (the SPEC §5.3.2 env-var convention).
// The Issue type uses camelCase. Expose both so either spelling resolves.
function aliasIssue(issue: import("./types.js").Issue): Record<string, unknown> {
  return {
    ...issue,
    content_id: issue.contentId,
    repo_full_name: issue.repoFullName,
    branch_name: issue.branchName,
    blocked_by: issue.blockedBy,
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
  };
}

// Wraps the .mjs `authorRecipe` into the AuthorRecipeFn shape LlmRecipeProvider
// expects. The .mjs file lives at `<repoRoot>/scripts/lib/workspace-bootstrap.mjs`
// in BOTH dev (where this module is at `<repoRoot>/src/runtime.ts`) and prod
// (where the compiled module is at `<repoRoot>/dist/src/runtime.js`) — but
// `dist/scripts/` doesn't exist. We resolve dynamically by walking up from
// `import.meta.url` to find a directory containing `scripts/lib/...`. If the
// file isn't found (e.g., bundled deployment), fall back to a stub that
// always returns "no LLM available" so the provider falls back to canned
// templates without crashing.
let cachedAuthor: AuthorRecipeFn | null = null;
function createAuthorRecipe(): AuthorRecipeFn {
  return async (input) => {
    if (!cachedAuthor) {
      cachedAuthor = await loadAuthorRecipe();
    }
    return cachedAuthor(input);
  };
}

async function loadAuthorRecipe(): Promise<AuthorRecipeFn> {
  const here = fileURLToPath(import.meta.url);
  let dir = dirname(here);
  for (let i = 0; i < 6; i++) {
    const candidate = join(dir, "scripts", "lib", "workspace-bootstrap.mjs");
    if (existsSync(candidate)) {
      const mod = await import(pathToFileURL(candidate).href);
      const fn = mod.authorRecipe;
      if (typeof fn === "function") {
        return async (input) => fn({ context: input.context, repoCheckoutDir: input.repoCheckoutDir });
      }
      break;
    }
    dir = dirname(dir);
  }
  log.warn({ from: here }, "workspace_bootstrap_mjs_not_found_using_canned_fallback");
  return async () => ({ source: null, fallback: true, reason: "bootstrap_mjs_not_found" });
}

function configureIrisEnvironment(config: ServiceConfig, env: NodeJS.ProcessEnv): void {
  if (!config.iris.enabled) return;
  env.SYMPHONY_IRIS_BASE_URL = config.iris.baseUrl;
  env.SYMPHONY_IRIS_TOKEN_ENV = config.iris.tokenEnv;
  env.SYMPHONY_IRIS_DEFAULT_PROFILE = config.iris.defaultProfile;
  env.SYMPHONY_IRIS_REQUEST_TIMEOUT_MS = String(config.iris.requestTimeoutMs);
  env.SYMPHONY_IRIS_MAX_CONCURRENT = String(config.iris.maxConcurrent);
  env.SYMPHONY_IRIS_PROFILE_OVERRIDES = JSON.stringify(config.iris.profileOverrides);
  env.SYMPHONY_IRIS_SHARED_SEMAPHORE_KEY = `iris:${config.iris.baseUrl}`;
  env.SYMPHONY_IRIS_ON_BLOCKED = config.iris.onBlocked;
  env.SYMPHONY_IRIS_MAX_CALLS_PER_TURN = String(config.agent.tools.irisRun.maxCallsPerTurn);
  env.SYMPHONY_IRIS_ALLOW_PROFILE_OVERRIDE = String(config.agent.tools.irisRun.allowProfileOverride);
}
