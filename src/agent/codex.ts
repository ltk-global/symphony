import { spawn, type ChildProcessByStdio } from "node:child_process";
import { existsSync } from "node:fs";
import { copyFile, mkdir, symlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";
import type { NormalizedEvent } from "../types.js";
import { resolveMcpServerCommand } from "./claude_code.js";
import type { AgentRunner, AgentSession } from "./types.js";
import type { TurnSink } from "../observability/turn_recorder.js";

export interface CodexSpawnOptions {
  cwd: string;
  stdio: ["pipe", "pipe", "pipe"];
  env?: NodeJS.ProcessEnv;
}

export interface CodexOptions {
  command: string;
  config?: Record<string, unknown>;
  reasoningEffort?: "low" | "medium" | "high" | "minimal" | "xhigh" | "max";
  spawnProcess?: (command: string, args: string[], options: CodexSpawnOptions) => ChildProcessByStdio<Writable, Readable, Readable>;
  // Optional hook called with every raw JSON-RPC frame from the codex
  // subprocess. Useful for tests that need to verify mcpToolCall occurred.
  onRawEvent?: (raw: any) => void;
}

interface MessageBuffer {
  itemId: string;
  text: string;
}

export class CodexAdapter implements AgentRunner {
  constructor(private readonly options: CodexOptions) {}

  async start(input: Parameters<AgentRunner["start"]>[0]): Promise<AgentSession> {
    const spawnProcess = this.options.spawnProcess ?? spawn;
    const irisEnv = buildCodexIrisEnv(input.tools, input.issue, input.workspacePath);
    const codexHome = await prepareIsolatedCodexHome(input.workspacePath, irisEnv, this.options.reasoningEffort ?? "low");
    await writeWorkspaceAgentsMd(input.workspacePath);
    const childEnv: NodeJS.ProcessEnv = { ...process.env, CODEX_HOME: codexHome };
    const child = spawnProcess("/bin/bash", ["-lc", this.options.command], { cwd: input.workspacePath, stdio: ["pipe", "pipe", "pipe"], env: childEnv });
    if (process.env.SYMPHONY_CODEX_DEBUG) {
      child.stderr?.on("data", (d) => process.stderr.write(`[codex-stderr] ${d.toString()}`));
    }
    const queue = new AsyncEventQueue<NormalizedEvent>();
    const config = this.options.config ?? {};

    let nextRequestId = 1;
    const initId = nextRequestId++;
    const threadStartId = nextRequestId++;
    let turnStartId = nextRequestId++;
    let threadId: string | null = null;
    let turnDispatched = false;
    const messages = new Map<string, MessageBuffer>();

    let currentSink: TurnSink | null = input.openTurnSink ? await input.openTurnSink().catch(() => null) : null;
    const rotateSink = async () => {
      const previous = currentSink;
      currentSink = input.openTurnSink ? await input.openTurnSink().catch(() => null) : null;
      await previous?.close();
    };

    const write = (message: unknown) => {
      const line = JSON.stringify(message);
      currentSink?.write(`>>> ${line}`);
      child.stdin.write(line + "\n");
    };
    child.once?.("error", () => {
      queue.close();
      void currentSink?.close();
    });
    child.once?.("exit", () => {
      void currentSink?.close();
    });

    const onRawEvent = this.options.onRawEvent;
    void pumpCodexEvents(child, (raw) => {
      currentSink?.write(`<<< ${JSON.stringify(raw)}`);
      onRawEvent?.(raw);
      if (process.env.SYMPHONY_CODEX_DEBUG) {
        const summary = raw.method ?? `id:${raw.id}${raw.error ? " ERROR" : raw.result ? " ok" : ""}`;
        const detail = raw.method === "mcpServer/startupStatus/updated" || (raw.error)
          ? ` ${JSON.stringify(raw.params ?? raw.error).slice(0, 400)}`
          : "";
        process.stderr.write(`[codex-event] ${summary}${detail}\n`);
      }
      // ID-matched responses (request results, not notifications).
      if (raw.id !== undefined) {
        if (raw.id === initId && raw.result) {
          // initialize succeeded → notify initialized → start thread.
          write({ jsonrpc: "2.0", method: "notifications/initialized" });
          write({ jsonrpc: "2.0", id: threadStartId, method: "thread/start", params: { ...config, cwd: input.workspacePath } });
          return;
        }
        if (raw.id === threadStartId && raw.result?.thread?.id) {
          threadId = String(raw.result.thread.id);
          if (!turnDispatched) {
            turnDispatched = true;
            write({
              jsonrpc: "2.0",
              id: turnStartId,
              method: "turn/start",
              params: { threadId, input: [{ type: "text", text: input.prompt }] },
            });
          }
          return;
        }
        if (raw.error) {
          queue.push({ kind: "turn_failed", reason: typeof raw.error.message === "string" ? raw.error.message : "codex_error" });
          return;
        }
        return;
      }

      // Notifications (no id).
      const event = mapCodexEvent(raw, messages);
      if (!event) return;
      if (event.kind === "session_started" && event.sessionId) threadId = event.sessionId;
      queue.push(event);
    })
      .then((sawTerminal) => {
        if (!sawTerminal) queue.close();
      })
      .catch(() => queue.close());

    write({
      jsonrpc: "2.0",
      id: initId,
      method: "initialize",
      params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "symphony", version: "0.1.0" } },
    });

    return {
      get sessionId() {
        return threadId ?? "pending";
      },
      events: queue,
      async startTurn(turnInput) {
        if (!threadId) throw new Error("codex_thread_id_not_available");
        await rotateSink();
        const id = nextRequestId++;
        turnStartId = id;
        const text = continuationPrompt(turnInput.text, turnInput.toolResults);
        write({
          jsonrpc: "2.0",
          id,
          method: "turn/start",
          params: { threadId, input: [{ type: "text", text }] },
        });
      },
      async cancel() {
        try {
          if (threadId) write({ jsonrpc: "2.0", id: nextRequestId++, method: "turn/interrupt", params: { threadId } });
        } catch {
          // ignore — child may already be gone
        }
        child.kill("SIGTERM");
      },
    };
  }
}

export function mapCodexEvent(raw: any, messages: Map<string, MessageBuffer> = new Map()): NormalizedEvent | null {
  const method = raw.method ?? raw.type ?? raw.event;
  const params = raw.params ?? raw;
  if (method === "thread/started" || method === "thread.started" || method === "thread/start/complete") {
    return { kind: "session_started", sessionId: params.thread?.id ?? params.thread_id ?? params.threadId ?? params.sessionId };
  }
  if (method === "turn/started" || method === "turn.started") {
    return { kind: "turn_started", turnId: params.turn?.id ?? params.turn_id ?? params.turnId };
  }
  if (method === "turn/completed" || method === "turn.completed") {
    return { kind: "turn_completed" };
  }
  if (method === "turn/failed" || method === "turn.failed") {
    return { kind: "turn_failed", reason: params.error?.message ?? params.reason ?? "turn_failed" };
  }
  if (method === "turn/cancelled" || method === "turn.cancelled") {
    return { kind: "turn_cancelled", reason: params.reason ?? "turn_cancelled" };
  }
  if (method === "item/agentMessage/delta") {
    const itemId = String(params.itemId ?? "");
    const delta = String(params.delta ?? "");
    if (!itemId || !delta) return null;
    const existing = messages.get(itemId) ?? { itemId, text: "" };
    existing.text += delta;
    messages.set(itemId, existing);
    return null;
  }
  if (method === "item/completed" && params.item?.type === "agentMessage") {
    const itemId = String(params.item.id ?? "");
    const buffered = messages.get(itemId)?.text ?? "";
    const text = typeof params.item.text === "string" && params.item.text.length > 0 ? params.item.text : buffered;
    messages.delete(itemId);
    if (!text) return null;
    return { kind: "message", text, final: true };
  }
  if (method === "thread/tokenUsage/updated") {
    const usage = params.tokenUsage?.last ?? params.tokenUsage?.total;
    if (!usage) return null;
    return {
      kind: "usage",
      inputTokens: Number(usage.inputTokens ?? 0),
      outputTokens: Number(usage.outputTokens ?? 0),
      totalTokens: Number(usage.totalTokens ?? 0),
    };
  }
  // Legacy/upstream Symphony Codex protocol — kept so unit tests built around it still cover the mapper.
  if (method === "message") return { kind: "message", text: params.text ?? "", final: params.final };
  if (method === "tool.call" || method === "tool/call") return { kind: "tool_call", toolName: params.name, args: params.arguments, callId: params.call_id };
  if (method === "tool.result" || method === "tool/result") return { kind: "tool_result", callId: params.call_id, result: params.result };
  return null;
}

export function buildCodexIrisEnv(
  tools: Array<{ name: string }>,
  issue: { labels?: string[] },
  workspacePath: string,
): Record<string, string> | null {
  const hasIris = tools.some((tool) => tool.name === "iris_run");
  if (!hasIris) return null;
  const baseUrl = process.env.SYMPHONY_IRIS_BASE_URL ?? "https://swarmy.firsttofly.com";
  const tokenEnv = process.env.SYMPHONY_IRIS_TOKEN_ENV ?? "IRIS_TOKEN";
  return {
    SYMPHONY_IRIS_BASE_URL: baseUrl,
    SYMPHONY_IRIS_TOKEN_ENV: tokenEnv,
    [tokenEnv]: process.env[tokenEnv] ?? "",
    SYMPHONY_IRIS_DEFAULT_PROFILE: process.env.SYMPHONY_IRIS_DEFAULT_PROFILE ?? "claude-default-latest",
    SYMPHONY_IRIS_REQUEST_TIMEOUT_MS: process.env.SYMPHONY_IRIS_REQUEST_TIMEOUT_MS ?? "600000",
    SYMPHONY_IRIS_MAX_CONCURRENT: process.env.SYMPHONY_IRIS_MAX_CONCURRENT ?? "1",
    SYMPHONY_IRIS_PROFILE_OVERRIDES: process.env.SYMPHONY_IRIS_PROFILE_OVERRIDES ?? "{}",
    SYMPHONY_IRIS_SHARED_SEMAPHORE_KEY: process.env.SYMPHONY_IRIS_SHARED_SEMAPHORE_KEY ?? `iris:${baseUrl}`,
    SYMPHONY_IRIS_SHARED_SEMAPHORE_ROOT: process.env.SYMPHONY_IRIS_SHARED_SEMAPHORE_ROOT ?? "",
    SYMPHONY_IRIS_MAX_CALLS_PER_TURN: process.env.SYMPHONY_IRIS_MAX_CALLS_PER_TURN ?? "10",
    SYMPHONY_IRIS_ALLOW_PROFILE_OVERRIDE: process.env.SYMPHONY_IRIS_ALLOW_PROFILE_OVERRIDE ?? "true",
    SYMPHONY_IRIS_ON_BLOCKED: process.env.SYMPHONY_IRIS_ON_BLOCKED ?? "needs_human",
    SYMPHONY_BLOCKED_MARKER_PATH: join(workspacePath, ".symphony", "iris-blocked.json"),
    SYMPHONY_ISSUE_LABELS: (issue.labels ?? []).join(","),
    SYMPHONY_MCP_DEBUG: process.env.SYMPHONY_MCP_DEBUG ?? "",
  };
}

// Per-session Codex config: lives at <workspace>/.codex. Keeps the global
// ~/.codex out of the picture so the user's MCP servers (jamdev, context7,
// playwright) don't burn startup time and pollute the log. We symlink the
// user's auth.json so OpenAI credentials are still available.
export async function prepareIsolatedCodexHome(
  workspacePath: string,
  irisEnv: Record<string, string> | null,
  reasoningEffort: "low" | "medium" | "high" | "minimal" | "xhigh" | "max",
): Promise<string> {
  const codexHome = join(workspacePath, ".codex");
  await mkdir(codexHome, { recursive: true });
  await linkUserAuth(codexHome);

  const lines: string[] = [];
  lines.push(`model_reasoning_effort = ${tomlString(reasoningEffort)}`);
  // Symphony runs Codex unattended — no human is around to answer the
  // mcpServer/elicitation/request prompts that Codex emits by default for
  // `approval_policy = "on-request"`. Without `never` here, every MCP tool
  // call (e.g. iris_run) hangs waiting for approval.
  lines.push(`approval_policy = "never"`);
  lines.push(`sandbox_mode = "danger-full-access"`);

  if (irisEnv) {
    const { command, args } = resolveMcpServerCommand();
    lines.push("");
    lines.push("[mcp_servers.symphony]");
    lines.push(`command = ${tomlString(command)}`);
    lines.push(`args = ${tomlStringArray(args)}`);
    lines.push("");
    lines.push("[mcp_servers.symphony.env]");
    for (const [key, value] of Object.entries(irisEnv)) {
      lines.push(`${key} = ${tomlString(value)}`);
    }
  }

  await writeFile(join(codexHome, "config.toml"), lines.join("\n") + "\n", "utf8");
  return codexHome;
}

// Codex picks up AGENTS.md from the workspace cwd as project-level
// instructions. Symphony writes a minimal one to neutralize any "use
// superpowers/plans first" behavior the model may have internalized from
// other Codex usage, since the orchestrator drives the workflow itself.
async function writeWorkspaceAgentsMd(workspacePath: string): Promise<void> {
  const path = join(workspacePath, "AGENTS.md");
  if (existsSync(path)) return;
  const body = [
    "# Symphony Session",
    "",
    "You are running unattended inside Symphony's orchestrator. Follow these rules:",
    "",
    "- Do NOT invoke any superpowers, skill plugins, or meta-workflows. None are required.",
    "- Do NOT plan, brainstorm, or write design docs. Just do the task.",
    "- When the user prompt names an MCP tool, call it directly. Do not narrate that you are calling it; emit the tool call.",
    "- Output only what the user prompt asks for.",
    "",
  ].join("\n");
  await writeFile(path, body, "utf8");
}

async function linkUserAuth(codexHome: string): Promise<void> {
  const userAuth = join(homedir(), ".codex", "auth.json");
  if (!existsSync(userAuth)) return;
  const sessionAuth = join(codexHome, "auth.json");
  if (existsSync(sessionAuth)) return;
  try {
    await symlink(userAuth, sessionAuth);
  } catch {
    await copyFile(userAuth, sessionAuth);
  }
}

function tomlString(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function tomlStringArray(values: string[]): string {
  return `[${values.map(tomlString).join(", ")}]`;
}

function continuationPrompt(text: string, toolResults?: Array<{ callId: string; result: unknown }>): string {
  if (!toolResults?.length) return text;
  const serialized = JSON.stringify(toolResults);
  return text.trim() ? `${text.trim()}\n\nTool results:\n${serialized}` : `Tool results:\n${serialized}`;
}

async function pumpCodexEvents(
  child: ChildProcessByStdio<Writable, Readable, Readable>,
  onRaw: (raw: any) => void,
): Promise<boolean> {
  let sawTerminal = false;
  const messages = new Map<string, MessageBuffer>();
  const lines = createInterface({ input: child.stdout });
  for await (const line of lines) {
    if (!line.trim()) continue;
    let raw: any;
    try {
      raw = JSON.parse(line);
    } catch {
      continue;
    }
    const event = mapCodexEvent(raw, messages);
    if (
      event?.kind === "turn_completed" ||
      event?.kind === "turn_failed" ||
      event?.kind === "turn_cancelled" ||
      event?.kind === "turn_input_required"
    ) {
      sawTerminal = true;
    }
    onRaw(raw);
  }
  return sawTerminal;
}

class AsyncEventQueue<T> implements AsyncIterable<T> {
  private readonly values: T[] = [];
  private readonly waiters: Array<(value: IteratorResult<T>) => void> = [];
  private closed = false;

  push(value: T): void {
    if (this.closed) return;
    const waiter = this.waiters.shift();
    if (waiter) waiter({ value, done: false });
    else this.values.push(value);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    while (this.waiters.length > 0) {
      this.waiters.shift()?.({ value: undefined, done: true });
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () => {
        const value = this.values.shift();
        if (value) return Promise.resolve({ value, done: false });
        if (this.closed) return Promise.resolve({ value: undefined, done: true });
        return new Promise<IteratorResult<T>>((resolve) => this.waiters.push(resolve));
      },
    };
  }
}
