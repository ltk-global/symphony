import { homedir, tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { z } from "zod";
import { defaultDataDir } from "../observability/data_dir.js";

const rawSchema = z
  .object({
    tracker: z.record(z.string(), z.unknown()).optional(),
    polling: z.record(z.string(), z.unknown()).optional(),
    workspace: z.record(z.string(), z.unknown()).optional(),
    hooks: z.record(z.string(), z.unknown()).optional(),
    agent: z.record(z.string(), z.unknown()).optional(),
    codex: z.record(z.string(), z.unknown()).optional(),
    claude_code: z.record(z.string(), z.unknown()).optional(),
    iris: z.record(z.string(), z.unknown()).optional(),
    verify: z.record(z.string(), z.unknown()).optional(),
    server: z.record(z.string(), z.unknown()).optional(),
  })
  .passthrough();

export interface ServiceConfig {
  dataDir: string;
  tracker: {
    kind: "github_projects";
    endpoint: string;
    apiToken: string;
    projectUrl?: string;
    projectOwner?: string;
    projectNumber?: number;
    statusField: string;
    priorityField: string | null;
    activeStates: string[];
    terminalStates: string[];
    needsHumanState: string;
    filters: {
      assignee?: string;
      labelRequired: string[];
      labelExcluded: string[];
    };
  };
  polling: { intervalMs: number };
  workspace: {
    root: string;
    cache: {
      strategy: "llm" | "reference_only" | "none";
      reviewRequired: boolean;
      recipeTtlHours: number;
    };
  };
  hooks: {
    afterCreate?: string;
    beforeRun?: string;
    afterRun?: string;
    beforeRemove?: string;
    timeoutMs: number;
    onEvent: Array<{
      name: string;
      types: string[];
      script: string;
      timeoutMs: number;
    }>;
  };
  agent: {
    kind: "codex" | "claude_code";
    maxConcurrentAgents: number;
    maxTurns: number;
    maxRetryBackoffMs: number;
    maxConcurrentAgentsByState: Record<string, number>;
    tools: {
      irisRun: { enabled: boolean; maxCallsPerTurn: number; allowProfileOverride: boolean };
      github: { enabled: boolean };
    };
  };
  codex: Record<string, unknown>;
  claudeCode: {
    command: string;
    model?: string;
    outputFormat: "stream-json";
    permissionMode: string;
    allowedTools: string[];
    disallowedTools: string[];
    appendSystemPrompt: string;
    maxTurns: number;
    readTimeoutMs: number;
    turnTimeoutMs: number;
    stallTimeoutMs: number;
  };
  iris: {
    enabled: boolean;
    baseUrl: string;
    tokenEnv: string;
    token: string;
    defaultProfile: string;
    profileOverrides: Record<string, string>;
    maxConcurrent: number;
    requestTimeoutMs: number;
    onBlocked: "needs_human" | "fail" | "pass_through";
    blockedCommentTemplate: string;
  };
  verify: Record<string, unknown>;
  server: {
    port: number | null;
    host: string;
    refreshIntervalSec: number;
    recentEventsLimit: number;
  };
}

export function buildConfig(
  rawInput: unknown,
  env: NodeJS.ProcessEnv = process.env,
  options: { baseDir?: string; workflowPath?: string } = {},
): ServiceConfig {
  const raw = rawSchema.parse(rawInput);
  const tracker = raw.tracker ?? {};
  const agent = raw.agent ?? {};
  const iris = raw.iris ?? {};

  if (tracker.kind !== "github_projects") throw new Error("unsupported_tracker_kind");
  const apiToken = resolveSecret(stringValue(tracker.api_token, "$GITHUB_TOKEN"), env);
  if (!apiToken) throw new Error("missing_github_token");
  const projectUrl = optionalString(tracker.project_url);
  const projectOwner = optionalString(tracker.project_owner);
  const projectNumber = optionalNumber(tracker.project_number);
  if (!projectUrl && (!projectOwner || !projectNumber)) throw new Error("missing_project_identification");

  const irisEnabled = booleanValue(iris.enabled, false);
  const tokenEnv = stringValue(iris.token_env, "IRIS_TOKEN");
  const irisToken = irisEnabled ? env[tokenEnv] : "";
  if (irisEnabled && !irisToken) throw new Error("missing_iris_token");
  const agentKind = agentKindValue(agent.kind);
  const baseDir = options.baseDir ?? process.cwd();

  const dataDirRaw = (raw as Record<string, unknown>).data_dir;
  const dataDir = pathValue(dataDirRaw, defaultDataDir(options.workflowPath ?? ""), env, baseDir);

  return {
    dataDir,
    tracker: {
      kind: "github_projects",
      endpoint: stringValue(tracker.endpoint, "https://api.github.com/graphql"),
      apiToken,
      projectUrl,
      projectOwner,
      projectNumber,
      statusField: stringValue(tracker.status_field, "Status"),
      priorityField: tracker.priority_field === null ? null : stringValue(tracker.priority_field, "Priority"),
      activeStates: stringArray(tracker.active_states, ["Todo", "In Progress"]),
      terminalStates: stringArray(tracker.terminal_states, ["Done", "Cancelled", "Won't Do"]),
      needsHumanState: stringValue(tracker.needs_human_state, "Needs Human"),
      filters: {
        assignee: optionalString(recordValue(tracker.filters, "assignee")),
        labelRequired: stringArray(recordValue(tracker.filters, "label_required"), []),
        labelExcluded: stringArray(recordValue(tracker.filters, "label_excluded"), []),
      },
    },
    polling: { intervalMs: positiveNumberValue(raw.polling?.interval_ms, 30_000, "invalid_polling_interval_ms") },
    workspace: {
      root: pathValue(raw.workspace?.root, join(tmpdir(), "symphony_workspaces"), env, baseDir),
      cache: parseWorkspaceCache(recordValue(raw.workspace, "cache")),
    },
    hooks: {
      afterCreate: optionalString(raw.hooks?.after_create),
      beforeRun: optionalString(raw.hooks?.before_run),
      afterRun: optionalString(raw.hooks?.after_run),
      beforeRemove: optionalString(raw.hooks?.before_remove),
      timeoutMs: positiveNumberValue(raw.hooks?.timeout_ms, 60_000, "invalid_hooks_timeout_ms"),
      onEvent: parseEventHooks((raw.hooks ?? {}).on_event),
    },
    agent: {
      kind: agentKind,
      maxConcurrentAgents: positiveNumberValue(agent.max_concurrent_agents, 10, "invalid_agent_max_concurrent_agents"),
      maxTurns: positiveNumberValue(agent.max_turns, 20, "invalid_agent_max_turns"),
      maxRetryBackoffMs: positiveNumberValue(agent.max_retry_backoff_ms, 300_000, "invalid_agent_max_retry_backoff_ms"),
      maxConcurrentAgentsByState: stringNumberRecord(agent.max_concurrent_agents_by_state),
      tools: {
        irisRun: {
          enabled: booleanValue(recordValue(agent.tools, "iris_run", "enabled"), true),
          maxCallsPerTurn: positiveNumberValue(recordValue(agent.tools, "iris_run", "max_calls_per_turn"), 10, "invalid_iris_run_max_calls_per_turn"),
          allowProfileOverride: booleanValue(recordValue(agent.tools, "iris_run", "allow_profile_override"), true),
        },
        github: { enabled: booleanValue(recordValue(agent.tools, "github", "enabled"), true) },
      },
    },
    codex: raw.codex ?? {},
    claudeCode: {
      command: stringValue(raw.claude_code?.command, "claude"),
      model: optionalString(raw.claude_code?.model),
      outputFormat: "stream-json",
      permissionMode: stringValue(raw.claude_code?.permission_mode, "acceptEdits"),
      allowedTools: stringArray(raw.claude_code?.allowed_tools, []),
      disallowedTools: stringArray(raw.claude_code?.disallowed_tools, []),
      appendSystemPrompt: stringValue(raw.claude_code?.append_system_prompt, ""),
      maxTurns: numberValue(raw.claude_code?.max_turns, 50),
      readTimeoutMs: numberValue(raw.claude_code?.read_timeout_ms, 5_000),
      turnTimeoutMs: numberValue(raw.claude_code?.turn_timeout_ms, 3_600_000),
      stallTimeoutMs: numberValue(raw.claude_code?.stall_timeout_ms, 300_000),
    },
    iris: {
      enabled: irisEnabled,
      baseUrl: stringValue(iris.base_url, "https://swarmy.firsttofly.com"),
      tokenEnv,
      token: irisToken ?? "",
      defaultProfile: stringValue(iris.default_profile, "claude-default-latest"),
      profileOverrides: stringRecord(iris.profile_overrides),
      maxConcurrent: positiveNumberValue(iris.max_concurrent, 3, "invalid_iris_max_concurrent"),
      requestTimeoutMs: positiveNumberValue(iris.request_timeout_ms, 600_000, "invalid_iris_request_timeout_ms"),
      onBlocked: blockedMode(iris.on_blocked),
      blockedCommentTemplate: stringValue(
        iris.blocked_comment_template,
        "The agent hit a step requiring a human.\nVNC URL: {{ blocked.vnc_url }}\nReason: {{ blocked.reason }}",
      ),
    },
    verify: raw.verify ?? {},
    server: buildServerConfig(raw.server),
  };
}

function parseWorkspaceCache(raw: unknown): ServiceConfig["workspace"]["cache"] {
  const record = (raw && typeof raw === "object" && !Array.isArray(raw)) ? (raw as Record<string, unknown>) : {};
  const strategyRaw = record.strategy;
  let strategy: "llm" | "reference_only" | "none" = "llm";
  if (strategyRaw !== undefined && strategyRaw !== null) {
    if (strategyRaw === "llm" || strategyRaw === "reference_only" || strategyRaw === "none") {
      strategy = strategyRaw;
    } else {
      throw new Error("invalid_workspace_cache_strategy");
    }
  }
  const reviewRequired = booleanValue(record.review_required, false);
  const recipeTtlHours = positiveNumberValue(record.recipe_ttl_hours, 168, "invalid_workspace_cache_recipe_ttl_hours");
  return { strategy, reviewRequired, recipeTtlHours };
}

function parseEventHooks(raw: unknown): ServiceConfig["hooks"]["onEvent"] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) throw new Error("invalid_hooks_on_event");
  return raw.map((rule, index) => {
    if (!rule || typeof rule !== "object" || Array.isArray(rule)) throw new Error("invalid_hooks_on_event_rule");
    const r = rule as Record<string, unknown>;
    const types = stringArray(r.types, []);
    if (types.length === 0) throw new Error("invalid_hooks_on_event_types");
    const script = typeof r.script === "string" ? r.script.trim() : "";
    if (!script) throw new Error("invalid_hooks_on_event_script");
    return {
      name: typeof r.name === "string" && r.name.length > 0 ? r.name : `rule_${index + 1}`,
      types,
      script,
      timeoutMs: positiveNumberValue(r.timeout_ms, 10_000, "invalid_hooks_on_event_timeout_ms"),
    };
  });
}

function buildServerConfig(raw: unknown): ServiceConfig["server"] {
  const record = (raw && typeof raw === "object" && !Array.isArray(raw)) ? (raw as Record<string, unknown>) : {};
  const portRaw = record.port;
  let port: number | null = null;
  if (portRaw === undefined || portRaw === null) port = null;
  else if (typeof portRaw === "number" && Number.isFinite(portRaw) && portRaw >= 0 && portRaw <= 65535) port = portRaw;
  else throw new Error("invalid_server_port");
  return {
    port,
    host: stringValue(record.host, "127.0.0.1"),
    refreshIntervalSec: positiveNumberValue(record.refresh_interval_sec, 5, "invalid_server_refresh_interval_sec"),
    recentEventsLimit: positiveNumberValue(record.recent_events_limit, 50, "invalid_server_recent_events_limit"),
  };
}

function resolveSecret(value: string, env: NodeJS.ProcessEnv): string {
  return value.startsWith("$") ? env[value.slice(1)] ?? "" : value;
}

function stringValue(value: unknown, fallback: string): string {
  return typeof value === "string" && value.length > 0 ? value : fallback;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function numberValue(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function positiveNumberValue(value: unknown, fallback: number, errorCode: string): number {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) throw new Error(errorCode);
  return value;
}

function booleanValue(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function agentKindValue(value: unknown): "codex" | "claude_code" {
  if (value === undefined || value === null) return "claude_code";
  if (value === "codex" || value === "claude_code") return value;
  throw new Error("unsupported_agent_kind");
}

function pathValue(value: unknown, fallback: string, env: NodeJS.ProcessEnv, baseDir: string): string {
  let path = stringValue(value, fallback);
  if (path.startsWith("$")) path = env[path.slice(1)] ?? "";
  if (!path) throw new Error("missing_workspace_root");
  if (path === "~") path = homedir();
  else if (path.startsWith("~/")) path = join(homedir(), path.slice(2));
  return isAbsolute(path) ? resolve(path) : resolve(baseDir, path);
}

function stringArray(value: unknown, fallback: string[]): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : fallback;
}

function stringRecord(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
}

function stringNumberRecord(value: unknown): Record<string, number> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value)
      .filter((entry): entry is [string, number] => typeof entry[1] === "number" && Number.isFinite(entry[1]) && entry[1] > 0)
      .map(([key, recordValue]) => [key.toLowerCase(), recordValue]),
  );
}

function recordValue(value: unknown, ...path: string[]): unknown {
  let current = value;
  for (const key of path) {
    if (!current || typeof current !== "object" || Array.isArray(current)) return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

function blockedMode(value: unknown): "needs_human" | "fail" | "pass_through" {
  return value === "fail" || value === "pass_through" ? value : "needs_human";
}
