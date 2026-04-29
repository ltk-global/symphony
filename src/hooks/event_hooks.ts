import { spawn, type ChildProcess } from "node:child_process";
import { log } from "../log.js";
import type { SymphonyEvent } from "../observability/event_log.js";

export interface EventHookRule {
  name: string;
  types: string[];
  script: string;
  timeoutMs: number;
}

export interface EventHookSpawn {
  (command: string, args: string[], options: { env: NodeJS.ProcessEnv; stdio: ["ignore", "pipe", "pipe"] }): ChildProcess;
}

export interface EventHookRunnerOptions {
  rules: EventHookRule[];
  spawnImpl?: EventHookSpawn;
  baseEnv?: NodeJS.ProcessEnv;
}

export class EventHookRunner {
  private readonly inflight = new Set<ChildProcess>();

  constructor(private readonly options: EventHookRunnerOptions) {}

  get ruleCount(): number {
    return this.options.rules.length;
  }

  fire(event: SymphonyEvent): void {
    if (this.options.rules.length === 0) return;
    for (const rule of this.options.rules) {
      if (!ruleMatches(rule, event)) continue;
      this.runRule(rule, event);
    }
  }

  async drain(): Promise<void> {
    if (this.inflight.size === 0) return;
    await Promise.all(
      [...this.inflight].map(
        (child) =>
          new Promise<void>((resolve) => {
            if (child.exitCode !== null || child.signalCode !== null) return resolve();
            child.once("exit", () => resolve());
            child.once("error", () => resolve());
          }),
      ),
    );
  }

  private runRule(rule: EventHookRule, event: SymphonyEvent): void {
    const spawnImpl = this.options.spawnImpl ?? (spawn as unknown as EventHookSpawn);
    const env = buildEnv(this.options.baseEnv ?? process.env, event);
    let child: ChildProcess;
    try {
      child = spawnImpl("bash", ["-lc", rule.script], { env, stdio: ["ignore", "pipe", "pipe"] });
    } catch (error) {
      log.warn({ error, rule: rule.name, eventType: event.type }, "event hook spawn failed");
      return;
    }
    this.inflight.add(child);

    let stderr = "";
    child.stderr?.on("data", (chunk) => {
      stderr += chunk.toString();
      if (stderr.length > 4096) stderr = stderr.slice(-4096);
    });

    const timer = setTimeout(() => {
      log.warn({ rule: rule.name, eventType: event.type, timeoutMs: rule.timeoutMs }, "event hook timed out — killing");
      child.kill("SIGKILL");
    }, rule.timeoutMs);
    timer.unref?.();

    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      this.inflight.delete(child);
      if (code === 0) return;
      log.warn(
        { rule: rule.name, eventType: event.type, exitCode: code, signal, stderr: stderr.trim().slice(-512) },
        "event hook exited non-zero",
      );
    });

    child.once("error", (error) => {
      clearTimeout(timer);
      this.inflight.delete(child);
      log.warn({ error, rule: rule.name, eventType: event.type }, "event hook errored");
    });
  }
}

function ruleMatches(rule: EventHookRule, event: SymphonyEvent): boolean {
  if (rule.types.includes("*")) return true;
  return rule.types.includes(event.type);
}

function buildEnv(base: NodeJS.ProcessEnv, event: SymphonyEvent): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...base,
    SYMPHONY_EVENT_TYPE: event.type,
    SYMPHONY_EVENT_TS: event.ts,
  };
  if (event.issueId) env.SYMPHONY_ISSUE_ID = event.issueId;
  if (event.issueIdentifier) env.SYMPHONY_ISSUE_IDENTIFIER = event.issueIdentifier;
  if (event.sessionId) env.SYMPHONY_SESSION_ID = event.sessionId;
  if (event.turnSeq !== undefined) env.SYMPHONY_TURN_SEQ = String(event.turnSeq);
  env.SYMPHONY_EVENT_PAYLOAD = event.payload ? JSON.stringify(event.payload) : "{}";
  return env;
}
