import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import type { AgentRunner, AgentSession } from "../agent/types.js";
import type { ServiceConfig } from "../config/index.js";
import type { Issue, NormalizedEvent, ToolResult, ToolSpec } from "../types.js";
import type { VerifyRunResult, VerifyStage } from "../verify/stage.js";
import type { WorkspaceManager } from "../workspace/manager.js";

const BLOCKED_MARKER_RELATIVE_PATH = join(".symphony", "iris-blocked.json");

export interface TrackerLike {
  fetchCandidateIssues(): Promise<Issue[]>;
  fetchIssueStatesByIds(ids: string[]): Promise<Record<string, string>>;
  transitionIssue?(issue: Pick<Issue, "id">, state: string): Promise<void>;
  commentOnIssue?(issue: Pick<Issue, "contentId">, body: string): Promise<void>;
}

export interface OrchestratorOptions {
  tracker: TrackerLike;
  workspace: Pick<WorkspaceManager, "prepare"> & Partial<Pick<WorkspaceManager, "beforeRun" | "afterRun">>;
  runner: AgentRunner;
  verifyStage?: Pick<VerifyStage, "run">;
  iris?: {
    run(input: { instruction: string; profile: string; containerId?: string; abortSignal?: AbortSignal }): Promise<unknown>;
  };
  renderPrompt(input: { issue: Issue; attempt: number | null; tools: { iris_run: boolean; github: boolean } }): Promise<string>;
  config: ServiceConfig;
}

interface LiveSession {
  issue: Issue;
  abort: AbortController;
  state: string;
  attempt: number | null;
  startedAtMs: number;
  lastEventAtMs: number;
  session?: AgentSession;
  workspace?: { key: string; path: string };
  verifyTriggeredForState?: string;
}

interface RetryEntry {
  issue: Issue;
  attempt: number;
  dueAtMs: number;
  error: string | null;
  timer: ReturnType<typeof setTimeout>;
}

export class Orchestrator {
  private readonly live = new Map<string, LiveSession>();
  private readonly retryAttempts = new Map<string, RetryEntry>();
  private readonly codexTotals = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };

  constructor(private readonly options: OrchestratorOptions) {}

  snapshot(): {
    running: number;
    issues: string[];
    retrying: Array<{ issueId: string; identifier: string; attempt: number; dueAtMs: number; error: string | null }>;
    codexTotals: { inputTokens: number; outputTokens: number; totalTokens: number };
  } {
    return {
      running: this.live.size,
      issues: [...this.live.values()].map((entry) => entry.issue.identifier),
      retrying: [...this.retryAttempts.values()].map((entry) => ({
        issueId: entry.issue.id,
        identifier: entry.issue.identifier,
        attempt: entry.attempt,
        dueAtMs: entry.dueAtMs,
        error: entry.error,
      })),
      codexTotals: { ...this.codexTotals },
    };
  }

  async tick(): Promise<void> {
    await this.reconcile();
    const candidates = await this.options.tracker.fetchCandidateIssues();
    candidates.sort(compareIssuesForDispatch);
    for (const issue of candidates) {
      if (this.live.has(issue.id)) continue;
      if (this.retryAttempts.has(issue.id)) continue;
      if (isBlockedForDispatch(issue, this.options.config.tracker.terminalStates)) continue;
      if (!this.hasCapacity(issue.state)) continue;
      await this.dispatch(issue, null);
    }
  }

  private async dispatch(issue: Issue, attempt: number | null): Promise<void> {
    const abort = new AbortController();
    this.clearRetry(issue.id);
    const now = Date.now();
    this.live.set(issue.id, { issue, abort, state: issue.state, attempt, startedAtMs: now, lastEventAtMs: now });
    try {
      const workspace = await this.options.workspace.prepare({ issue, attempt });
      const toolAvailability = this.toolAvailability();
      const tools = this.buildToolSpecs();
      const prompt = await this.options.renderPrompt({
        issue,
        attempt,
        tools: toolAvailability,
      });
      await this.options.workspace.beforeRun?.(workspace, issue, attempt);
      const session = await this.options.runner.start({ workspacePath: workspace.path, prompt, issue, attempt, tools, abortSignal: abort.signal });
      if (!session) {
        this.live.delete(issue.id);
        return;
      }
      const live = this.live.get(issue.id);
      if (live) {
        live.session = session;
        live.workspace = workspace;
      }
      void this.consumeSession(issue, session, workspace).catch((error) => {
        this.live.delete(issue.id);
        this.scheduleRetry(issue, nextFailureAttempt(attempt), error instanceof Error ? error.message : String(error));
      });
    } catch (error) {
      this.live.delete(issue.id);
      throw error;
    }
  }

  private async consumeSession(issue: Issue, session: AgentSession, workspace?: { key: string; path: string }): Promise<void> {
    const finalMessages: string[] = [];
    let irisCallsInTurn = 0;
    let retry: { attempt: number; error: string | null } | null = null;
    try {
      for await (const event of session.events) {
        const live = this.live.get(issue.id);
        if (live) live.lastEventAtMs = Date.now();
        if (event.kind === "message" && event.final) finalMessages.push(event.text);
        if (event.kind === "usage") this.addUsage(event);
        if (event.kind === "tool_call") {
          if (event.toolName === "iris_run") {
            irisCallsInTurn += 1;
            const maxCalls = this.options.config.agent.tools?.irisRun?.maxCallsPerTurn ?? 10;
            if (irisCallsInTurn > maxCalls) {
              await session.startTurn({
                text: "",
                toolResults: [{ callId: event.callId, result: { error: "iris_run_call_limit_exceeded" } }],
              });
              continue;
            }
          }
          const toolResult = await this.handleToolCall(issue, event, session);
          if (!toolResult) break;
          await session.startTurn({ text: "", toolResults: [toolResult] });
          continue;
        }
        if (event.kind === "tool_result") {
          const blockedResult = extractBlockedIrisResult(event.result);
          if (blockedResult && this.options.config.iris.onBlocked === "needs_human") {
            await this.handleBlockedIrisResult(issue, blockedResult);
            await session.cancel("iris_blocked_handed_off");
            break;
          }
        }
        if (event.kind === "turn_completed") {
          if (event.usage) this.addUsage(event.usage);
          const observedState = await this.refreshLiveStateAfterTurn(issue, session);
          if (observedState === "released") break;
          const verifyResult = await this.maybeVerify(issue, { finalMessages }, observedState ?? undefined);
          if (verifyResult?.kind === "retry") {
            finalMessages.length = 0;
            irisCallsInTurn = 0;
            await session.startTurn({ text: verifyResult.feedback });
            continue;
          }
          irisCallsInTurn = 0;
          retry = { attempt: 1, error: null };
          break;
        }
        if (event.kind === "turn_failed" || event.kind === "turn_cancelled" || event.kind === "turn_input_required") {
          retry = { attempt: nextFailureAttempt(this.live.get(issue.id)?.attempt ?? null), error: event.kind };
          break;
        }
      }
    } finally {
      const attempt = this.live.get(issue.id)?.attempt ?? null;
      const blockedHandedOff = workspace ? await this.consumeBlockedMarker(issue, workspace) : false;
      if (workspace) await this.options.workspace.afterRun?.(workspace, issue, attempt);
      this.live.delete(issue.id);
      if (retry && !blockedHandedOff) this.scheduleRetry(issue, retry.attempt, retry.error);
    }
  }

  private async consumeBlockedMarker(issue: Issue, workspace: { path: string }): Promise<boolean> {
    const markerPath = join(workspace.path, BLOCKED_MARKER_RELATIVE_PATH);
    let raw: string;
    try {
      raw = await readFile(markerPath, "utf8");
    } catch {
      return false;
    }
    try {
      const parsed = JSON.parse(raw) as { vncUrl?: string; reason?: string };
      await this.handleBlockedIrisResult(issue, { blocked: { vncUrl: parsed.vncUrl, reason: parsed.reason } });
    } finally {
      await rm(markerPath, { force: true });
    }
    return true;
  }

  private addUsage(usage: { inputTokens: number; outputTokens: number; totalTokens: number }): void {
    this.codexTotals.inputTokens += usage.inputTokens;
    this.codexTotals.outputTokens += usage.outputTokens;
    this.codexTotals.totalTokens += usage.totalTokens;
  }

  private async handleToolCall(
    issue: Issue,
    event: Extract<NormalizedEvent, { kind: "tool_call" }>,
    session: AgentSession,
  ): Promise<ToolResult | null> {
    if (event.toolName !== "iris_run") {
      return { callId: event.callId, result: { error: `unsupported_tool:${event.toolName}` } };
    }
    const args = parseIrisArgs(event.args);
    if (!args.instruction) {
      return { callId: event.callId, result: { error: "iris_run_missing_instruction" } };
    }
    if (!this.options.iris) {
      return { callId: event.callId, result: { error: "iris_unavailable" } };
    }
    const profile = this.resolveIrisProfile(issue, args.profile);
    const result = await this.options.iris.run({
      instruction: args.instruction,
      profile,
      containerId: args.container_id,
      abortSignal: this.live.get(issue.id)?.abort.signal,
    });
    if (isBlockedIrisResult(result) && this.options.config.iris.onBlocked === "needs_human") {
      await this.handleBlockedIrisResult(issue, result);
      await session.cancel("iris_blocked_handed_off");
      return null;
    }
    return { callId: event.callId, result };
  }

  private async handleBlockedIrisResult(issue: Issue, result: { blocked?: { vncUrl?: string; reason?: string } }): Promise<void> {
    const blocked = {
      reason: result.blocked?.reason ?? "",
      vnc_url: result.blocked?.vncUrl ?? "",
    };
    const comment = renderBlockedComment(this.options.config.iris.blockedCommentTemplate, blocked);
    await this.options.tracker.commentOnIssue?.(issue, comment);
    await this.options.tracker.transitionIssue?.(issue, this.options.config.tracker.needsHumanState);
  }

  private async maybeVerify(issue: Issue, lastTurn: { finalMessages: string[] }, observedState?: string): Promise<VerifyRunResult | null> {
    const verify = this.options.config.verify as any;
    if (!this.options.verifyStage || !verify?.enabled) return null;
    if (verify.trigger === "after_agent_signal") {
      const marker = String(verify.signalMarker ?? verify.signal_marker ?? "VERIFY_REQUESTED");
      const last = lastTurn.finalMessages.at(-1)?.trim() ?? "";
      if (!last.includes(marker)) return null;
    } else if (verify.trigger === "on_state_transition") {
      const triggerState = String(verify.triggerState ?? verify.trigger_state ?? "");
      if (!observedState || triggerState.toLowerCase() !== observedState.toLowerCase()) return null;
    } else if (verify.trigger && verify.trigger !== "always") {
      return null;
    }

    return this.options.verifyStage.run({
      issue,
      lastTurn,
      config: normalizeVerifyConfig(verify),
      irisConfig: {
        defaultProfile: this.options.config.iris.defaultProfile,
        profileOverrides: this.options.config.iris.profileOverrides,
        onBlocked: this.options.config.iris.onBlocked,
        needsHumanState: this.options.config.tracker.needsHumanState,
        blockedCommentTemplate: this.options.config.iris.blockedCommentTemplate,
      },
    });
  }

  private toolAvailability(): { iris_run: boolean; github: boolean } {
    return {
      iris_run: Boolean(this.options.config.agent.tools?.irisRun?.enabled && this.options.config.iris.enabled && this.options.iris),
      github: false,
    };
  }

  private buildToolSpecs(): ToolSpec[] {
    const availability = this.toolAvailability();
    const tools: ToolSpec[] = [];
    if (availability.iris_run) {
      tools.push({
        name: "iris_run",
        description:
          "Run a natural-language instruction against a real headful Chrome browser via IRIS. Include a full URL, concrete actions, and an explicit output format.",
        inputSchema: {
          type: "object",
          properties: {
            instruction: { type: "string" },
            profile: { type: "string" },
            container_id: { type: "string" },
          },
          required: ["instruction"],
        },
      });
    }
    if (availability.github) {
      tools.push({
        name: "github",
        description: "Use GitHub CLI or GraphQL helper capabilities to update project status, comments, branches, and pull requests.",
        inputSchema: {
          type: "object",
          properties: {
            instruction: { type: "string" },
          },
          required: ["instruction"],
        },
      });
    }
    return tools;
  }

  private resolveIrisProfile(issue: Issue, explicitProfile?: string): string {
    const irisTools = this.options.config.agent.tools?.irisRun;
    if (explicitProfile && irisTools?.allowProfileOverride !== false) return explicitProfile;
    const overrides = this.options.config.iris.profileOverrides ?? {};
    for (const [label, profile] of Object.entries(overrides)) {
      if (issue.labels?.includes(label.toLowerCase())) return profile;
    }
    return this.options.config.iris.defaultProfile;
  }

  private hasCapacity(state: string): boolean {
    if (this.live.size >= this.options.config.agent.maxConcurrentAgents) return false;
    const key = state.toLowerCase();
    const limit = this.options.config.agent.maxConcurrentAgentsByState[key];
    if (limit === undefined) return true;
    let count = 0;
    for (const session of this.live.values()) if (session.state.toLowerCase() === key) count += 1;
    return count < limit;
  }

  private async reconcile(): Promise<void> {
    const ids = [...this.live.keys()];
    if (ids.length === 0) return;
    this.cancelStalledSessions();
    const remainingIds = [...this.live.keys()];
    if (remainingIds.length === 0) return;
    let states: Record<string, string>;
    try {
      states = await this.options.tracker.fetchIssueStatesByIds(remainingIds);
    } catch {
      return;
    }
    for (const [id, state] of Object.entries(states)) {
      const live = this.live.get(id);
      if (!live) continue;
      const disposition = await this.applyObservedState(live, state);
      if (disposition === "released") continue;
      live.state = state;
      if (this.shouldVerifyOnStateTransition(live, state)) {
        live.verifyTriggeredForState = state;
        const verifyResult = await this.maybeVerify(live.issue, { finalMessages: [] }, state);
        if (verifyResult?.kind === "retry") {
          await live.session?.startTurn({ text: verifyResult.feedback });
        }
      }
    }
  }

  private cancelStalledSessions(): void {
    const stallTimeoutMs = this.options.config.claudeCode?.stallTimeoutMs ?? this.options.config.codex?.stall_timeout_ms ?? 300_000;
    if (typeof stallTimeoutMs !== "number" || stallTimeoutMs <= 0) return;
    const now = Date.now();
    for (const live of this.live.values()) {
      if (now - live.lastEventAtMs <= stallTimeoutMs) continue;
      void live.session?.cancel("stalled");
      live.abort.abort();
      this.live.delete(live.issue.id);
      this.scheduleRetry(live.issue, nextFailureAttempt(live.attempt), "stalled");
    }
  }

  private async refreshLiveStateAfterTurn(issue: Issue, session: AgentSession): Promise<string | "released" | null> {
    const state = (await this.options.tracker.fetchIssueStatesByIds([issue.id]))[issue.id];
    if (!state) return null;
    const live = this.live.get(issue.id);
    if (!live) return "released";
    live.session = session;
    const disposition = await this.applyObservedState(live, state);
    if (disposition === "released") return "released";
    live.state = state;
    return state;
  }

  private async applyObservedState(live: LiveSession, state: string): Promise<"running" | "released"> {
    const normalized = state.toLowerCase();
    const terminal = new Set(this.options.config.tracker.terminalStates.map((item) => item.toLowerCase()));
    const active = new Set((this.options.config.tracker.activeStates ?? []).map((item: string) => item.toLowerCase()));
    if (terminal.has(normalized)) {
      await live.session?.cancel(`terminal_state:${state}`);
      live.abort.abort();
      this.live.delete(live.issue.id);
      this.clearRetry(live.issue.id);
      return "released";
    }
    if (active.size > 0 && !active.has(normalized)) {
      await live.session?.cancel(`inactive_state:${state}`);
      live.abort.abort();
      this.live.delete(live.issue.id);
      this.clearRetry(live.issue.id);
      return "released";
    }
    return "running";
  }

  private scheduleRetry(issue: Issue, attempt: number, error: string | null): void {
    if (this.retryAttempts.has(issue.id) || this.live.has(issue.id)) this.clearRetry(issue.id);
    const delay = error === null ? 1_000 : Math.min(10_000 * 2 ** Math.max(attempt - 1, 0), this.options.config.agent.maxRetryBackoffMs);
    const dueAtMs = Date.now() + delay;
    const timer = setTimeout(() => {
      void this.runRetry(issue.id);
    }, delay);
    timer.unref?.();
    this.retryAttempts.set(issue.id, { issue, attempt, dueAtMs, error, timer });
  }

  private clearRetry(issueId: string): void {
    const retry = this.retryAttempts.get(issueId);
    if (retry) clearTimeout(retry.timer);
    this.retryAttempts.delete(issueId);
  }

  private async runRetry(issueId: string): Promise<void> {
    const retry = this.retryAttempts.get(issueId);
    if (!retry) return;
    const candidates = await this.options.tracker.fetchCandidateIssues();
    const issue = candidates.find((candidate) => candidate.id === issueId);
    if (!issue) {
      this.clearRetry(issueId);
      return;
    }
    if (isBlockedForDispatch(issue, this.options.config.tracker.terminalStates) || !this.hasCapacity(issue.state)) {
      this.scheduleRetry(issue, retry.attempt, "no available orchestrator slots");
      return;
    }
    await this.dispatch(issue, retry.attempt);
  }

  private shouldVerifyOnStateTransition(live: LiveSession, state: string): boolean {
    const verify = this.options.config.verify as any;
    if (!this.options.verifyStage || !verify?.enabled) return false;
    const trigger = verify.trigger ?? verify.trigger_state;
    if (trigger !== "on_state_transition") return false;
    const triggerState = String(verify.triggerState ?? verify.trigger_state ?? "");
    if (!triggerState || triggerState.toLowerCase() !== state.toLowerCase()) return false;
    return live.verifyTriggeredForState?.toLowerCase() !== state.toLowerCase();
  }
}

function parseIrisArgs(args: unknown): { instruction: string; profile?: string; container_id?: string } {
  if (!args || typeof args !== "object") return { instruction: "" };
  const record = args as Record<string, unknown>;
  return {
    instruction: typeof record.instruction === "string" ? record.instruction : "",
    profile: typeof record.profile === "string" ? record.profile : undefined,
    container_id: typeof record.container_id === "string" ? record.container_id : undefined,
  };
}

function compareIssuesForDispatch(a: Issue, b: Issue): number {
  const priority = (a.priority ?? Number.MAX_SAFE_INTEGER) - (b.priority ?? Number.MAX_SAFE_INTEGER);
  if (priority !== 0) return priority;
  const created = timestampValue(a.createdAt) - timestampValue(b.createdAt);
  if (created !== 0) return created;
  return a.identifier.localeCompare(b.identifier);
}

function timestampValue(value: string | null | undefined): number {
  if (!value) return Number.MAX_SAFE_INTEGER;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : Number.MAX_SAFE_INTEGER;
}

function isBlockedForDispatch(issue: Issue, terminalStates: string[]): boolean {
  if (issue.state.toLowerCase() !== "todo") return false;
  const terminal = new Set(terminalStates.map((state) => state.toLowerCase()));
  return (issue.blockedBy ?? []).some((blocker) => !terminal.has(String(blocker.state ?? "").toLowerCase()));
}

function nextFailureAttempt(current: number | null): number {
  return current === null ? 1 : current + 1;
}

function isBlockedIrisResult(result: unknown): result is { status: "blocked"; blocked?: { vncUrl?: string; reason?: string } } {
  return Boolean(result && typeof result === "object" && (result as Record<string, unknown>).status === "blocked");
}

function extractBlockedIrisResult(result: unknown): { status: "blocked"; blocked?: { vncUrl?: string; reason?: string } } | null {
  if (isBlockedIrisResult(result)) return result;
  if (typeof result === "string") {
    try {
      return extractBlockedIrisResult(JSON.parse(result));
    } catch {
      return null;
    }
  }
  if (Array.isArray(result)) {
    for (const item of result) {
      const blocked = extractBlockedIrisResult(item);
      if (blocked) return blocked;
    }
    return null;
  }
  if (result && typeof result === "object") {
    const record = result as Record<string, unknown>;
    return extractBlockedIrisResult(record.text ?? record.content);
  }
  return null;
}

function renderBlockedComment(template: string, blocked: { reason: string; vnc_url: string }): string {
  return template
    .replaceAll("{{ blocked.reason }}", blocked.reason)
    .replaceAll("{{ blocked.vnc_url }}", blocked.vnc_url)
    .replaceAll("{{blocked.reason}}", blocked.reason)
    .replaceAll("{{blocked.vnc_url}}", blocked.vnc_url);
}

function normalizeVerifyConfig(verify: any) {
  return {
    urlSource: verify.urlSource ?? verify.url_source ?? "agent_output",
    agentOutputKey: verify.agentOutputKey ?? verify.agent_output_key ?? "verify_url",
    urlLabelPrefix: verify.urlLabelPrefix ?? verify.url_label_prefix ?? "deploy:",
    urlStatic: verify.urlStatic ?? verify.url_static ?? "",
    profile: verify.profile ?? "",
    instructionTemplate: verify.instructionTemplate ?? verify.instruction_template ?? "Visit {{ verify_url }}.",
    onPass: {
      transitionTo: verify.onPass?.transitionTo ?? verify.on_pass?.transition_to ?? "In Review",
      commentTemplate: verify.onPass?.commentTemplate ?? verify.on_pass?.comment_template ?? "Verified by IRIS. {{ result.summary }}",
    },
    onFail: {
      maxAttempts: verify.onFail?.maxAttempts ?? verify.on_fail?.max_attempts ?? 2,
      feedbackTemplate: verify.onFail?.feedbackTemplate ?? verify.on_fail?.feedback_template ?? "IRIS verification failed: {{ result.summary }}",
      finalTransitionTo: verify.onFail?.finalTransitionTo ?? verify.on_fail?.final_transition_to ?? "Needs Human",
      finalCommentTemplate: verify.onFail?.finalCommentTemplate ?? verify.on_fail?.final_comment_template ?? "Verification failed {{ verify.attempts }} times.",
    },
    onNoUrl: {
      transitionTo: verify.onNoUrl?.transitionTo ?? verify.on_no_url?.transition_to ?? "Needs Human",
      commentTemplate: verify.onNoUrl?.commentTemplate ?? verify.on_no_url?.comment_template ?? "Verify stage could not resolve a URL.",
    },
  };
}
