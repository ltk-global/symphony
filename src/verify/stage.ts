import { Liquid } from "liquidjs";
import type { Issue } from "../types.js";
import type { IrisClient } from "../iris/client.js";
import type { EventLog } from "../observability/event_log.js";

const liquid = new Liquid({ strictVariables: false, strictFilters: true });

export interface TurnTranscript {
  finalMessages: string[];
}

export interface VerifyUrlConfig {
  urlSource: string | string[];
  agentOutputKey: string;
  urlLabelPrefix: string;
  urlStatic: string;
}

export interface VerifyConfig extends VerifyUrlConfig {
  profile: string;
  instructionTemplate: string;
  onPass: { transitionTo: string; commentTemplate: string };
  onFail: {
    maxAttempts: number;
    feedbackTemplate: string;
    finalTransitionTo: string;
    finalCommentTemplate: string;
  };
  onNoUrl: { transitionTo: string; commentTemplate: string };
}

export interface VerifyStageDeps {
  tracker: {
    transitionIssue(issue: Pick<Issue, "id">, state: string): Promise<void>;
    commentOnIssue(issue: Pick<Issue, "contentId">, body: string): Promise<void>;
  };
  iris: Pick<IrisClient, "run">;
  eventLog?: EventLog;
}

export type VerifyRunResult =
  | { kind: "passed" }
  | { kind: "retry"; feedback: string }
  | { kind: "terminal_failed" }
  | { kind: "no_url" }
  | { kind: "blocked" };

export class VerifyStage {
  private readonly attempts = new Map<string, number>();

  constructor(private readonly deps: VerifyStageDeps) {}

  async run(input: {
    issue: Issue;
    lastTurn: TurnTranscript;
    config: VerifyConfig;
    irisConfig: {
      defaultProfile: string;
      profileOverrides: Record<string, string>;
      onBlocked: "needs_human" | "fail" | "pass_through";
      needsHumanState?: string;
      blockedCommentTemplate?: string;
    };
  }): Promise<VerifyRunResult> {
    const emit = (type: string, payload?: Record<string, unknown>) =>
      this.deps.eventLog?.emit({ type, issueId: input.issue.id, issueIdentifier: input.issue.identifier, payload });

    const resolved = resolveVerifyUrl(input.issue, input.lastTurn, input.config);
    if (!resolved) {
      await emit("verify_no_url", { attemptedSources: normalizeSources(input.config.urlSource) });
      await this.deps.tracker.commentOnIssue(input.issue, await render(input.config.onNoUrl.commentTemplate, { issue: input.issue, verify: { attempted_sources: normalizeSources(input.config.urlSource) } }));
      await this.deps.tracker.transitionIssue(input.issue, input.config.onNoUrl.transitionTo);
      return { kind: "no_url" };
    }

    const instruction = await render(input.config.instructionTemplate, {
      verify_url: resolved.url,
      issue: input.issue,
    });
    const profile = input.config.profile || resolveProfile(input.issue, input.irisConfig);
    const startedAt = Date.now();
    await emit("verify_iris_call_started", { url: resolved.url, source: resolved.source, profile });
    const irisResult = await this.deps.iris.run({ instruction, profile });
    await emit("verify_iris_call_completed", { url: resolved.url, profile, durationMs: Date.now() - startedAt, status: irisResult.status });

    if (irisResult.status === "blocked" && input.irisConfig.onBlocked === "needs_human") {
      await emit("verify_blocked", { reason: irisResult.blocked?.reason ?? "", vncUrl: irisResult.blocked?.vncUrl ?? "", transitionTo: input.irisConfig.needsHumanState ?? "Needs Human" });
      const body = await render(input.irisConfig.blockedCommentTemplate ?? "Blocked: {{ blocked.reason }}", {
        issue: input.issue,
        blocked: {
          reason: irisResult.blocked?.reason ?? "",
          vnc_url: irisResult.blocked?.vncUrl ?? "",
        },
      });
      await this.deps.tracker.commentOnIssue(input.issue, body);
      await this.deps.tracker.transitionIssue(input.issue, input.irisConfig.needsHumanState ?? "Needs Human");
      return { kind: "blocked" };
    }

    const parsed = parseVerifyResult(irisResult.result);
    if (parsed.pass) {
      await emit("verify_passed", { transitionTo: input.config.onPass.transitionTo, summary: parsed.summary, evidenceUrl: parsed.evidenceUrl ?? null });
      await this.deps.tracker.commentOnIssue(input.issue, await render(input.config.onPass.commentTemplate, { issue: input.issue, result: parsed }));
      await this.deps.tracker.transitionIssue(input.issue, input.config.onPass.transitionTo);
      this.attempts.delete(input.issue.id);
      return { kind: "passed" };
    }

    const nextAttempts = (this.attempts.get(input.issue.id) ?? 0) + 1;
    this.attempts.set(input.issue.id, nextAttempts);
    if (nextAttempts < input.config.onFail.maxAttempts) {
      await emit("verify_retry", { attempt: nextAttempts, maxAttempts: input.config.onFail.maxAttempts, summary: parsed.summary });
      return {
        kind: "retry",
        feedback: await render(input.config.onFail.feedbackTemplate, { issue: input.issue, result: parsed, verify: { attempts: nextAttempts } }),
      };
    }

    await emit("verify_terminal_failed", { attempts: nextAttempts, transitionTo: input.config.onFail.finalTransitionTo, summary: parsed.summary });
    await this.deps.tracker.commentOnIssue(input.issue, await render(input.config.onFail.finalCommentTemplate, { issue: input.issue, result: parsed, verify: { attempts: nextAttempts } }));
    await this.deps.tracker.transitionIssue(input.issue, input.config.onFail.finalTransitionTo);
    this.attempts.delete(input.issue.id);
    return { kind: "terminal_failed" };
  }
}

export function resolveVerifyUrl(
  issue: Pick<Issue, "labels">,
  lastTurn: TurnTranscript,
  config: VerifyUrlConfig,
): { url: string; source: string; attemptedSources: string[] } | null {
  const attemptedSources: string[] = [];
  for (const source of normalizeSources(config.urlSource)) {
    attemptedSources.push(source);
    let url: string | null = null;
    if (source === "agent_output") url = parseAgentOutputUrl(lastTurn, config.agentOutputKey);
    if (source === "label") url = parseLabelUrl(issue.labels, config.urlLabelPrefix);
    if (source === "static") url = validHttpUrl(config.urlStatic) ? config.urlStatic : null;
    if (url) return { url, source, attemptedSources: [...attemptedSources] };
  }
  return null;
}

export function parseVerifyResult(output: string): { pass: boolean; summary: string; evidenceUrl?: string | null } {
  const last = output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .at(-1);
  if (!last) return { pass: false, summary: "verify result was not parseable JSON: empty output", evidenceUrl: null };
  try {
    const parsed = JSON.parse(last);
    return {
      pass: Boolean(parsed.pass),
      summary: typeof parsed.summary === "string" ? parsed.summary : "",
      evidenceUrl: typeof parsed.evidence_url === "string" ? parsed.evidence_url : parsed.evidence_url === null ? null : undefined,
    };
  } catch {
    return { pass: false, summary: `verify result was not parseable JSON: ${last.slice(-200)}`, evidenceUrl: null };
  }
}

function parseAgentOutputUrl(lastTurn: TurnTranscript, key: string): string | null {
  const line = lastTurn.finalMessages
    .flatMap((message) => message.split(/\r?\n/))
    .map((item) => item.trim())
    .filter(Boolean)
    .at(-1);
  if (!line) return null;
  try {
    const parsed = JSON.parse(line);
    return typeof parsed?.[key] === "string" && validHttpUrl(parsed[key]) ? parsed[key] : null;
  } catch {
    return null;
  }
}

function parseLabelUrl(labels: string[], prefix: string): string | null {
  const label = labels.find((item) => item.toLowerCase().startsWith(prefix.toLowerCase()));
  if (!label) return null;
  const url = label.slice(prefix.length);
  return validHttpUrl(url) ? url : null;
}

function validHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function normalizeSources(source: string | string[]): string[] {
  return Array.isArray(source) ? source : [source];
}

function resolveProfile(issue: Pick<Issue, "labels">, config: { defaultProfile: string; profileOverrides: Record<string, string> }): string {
  for (const [label, profile] of Object.entries(config.profileOverrides)) {
    if (issue.labels.includes(label.toLowerCase())) return profile;
  }
  return config.defaultProfile;
}

async function render(template: string, input: Record<string, unknown>): Promise<string> {
  return liquid.parseAndRender(template, input);
}
