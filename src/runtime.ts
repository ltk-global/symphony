import { stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { loadWorkflow, renderPrompt } from "./workflow/loader.js";
import { buildConfig, type ServiceConfig } from "./config/index.js";
import { GitHubProjectsTracker } from "./tracker/github_projects.js";
import { WorkspaceManager, type WorkspaceIssueInput } from "./workspace/manager.js";
import { ClaudeCodeAdapter } from "./agent/claude_code.js";
import { CodexAdapter } from "./agent/codex.js";
import { Orchestrator } from "./orchestrator/index.js";
import { IrisClient } from "./iris/client.js";
import { VerifyStage } from "./verify/stage.js";
import { log } from "./log.js";

export interface RuntimeComponents {
  config: ServiceConfig;
  orchestrator: Orchestrator;
  tracker: GitHubProjectsTracker;
  workspace: WorkspaceManager;
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
  const config = buildConfig(workflow.config, env, { baseDir: dirname(absoluteWorkflowPath) });
  configureIrisEnvironment(config, env);
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
  const workspace = new WorkspaceManager({
    root: config.workspace.root,
    hooks: config.hooks,
    hookTimeoutMs: config.hooks.timeoutMs,
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
  const verifyStage = iris ? new VerifyStage({ tracker, iris }) : undefined;
  const orchestrator = new Orchestrator({
    tracker,
    workspace,
    runner,
    verifyStage,
    iris: iris ?? undefined,
    config,
    renderPrompt: ({ issue, attempt, tools }) => renderPrompt(workflow.promptTemplate, { issue, attempt, tools }),
  });
  return { config, orchestrator, tracker, workspace };
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
