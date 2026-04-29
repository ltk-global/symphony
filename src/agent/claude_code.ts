import { spawn, type ChildProcessByStdio } from "node:child_process";
import type { Readable } from "node:stream";
import { createInterface } from "node:readline";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { NormalizedEvent } from "../types.js";
import type { AgentRunner, AgentSession } from "./types.js";
import type { TurnSink } from "../observability/turn_recorder.js";

export interface ClaudeCodeOptions {
  command: string;
  model?: string;
  permissionMode: string;
  allowedTools: string[];
  disallowedTools: string[];
  appendSystemPrompt: string;
  maxTurns: number;
  spawnProcess?: (command: string, args: string[], options: { cwd: string; stdio: ["ignore", "pipe", "pipe"] }) => ChildProcessByStdio<null, Readable, Readable>;
}

export class ClaudeCodeAdapter implements AgentRunner {
  constructor(private readonly options: ClaudeCodeOptions) {}

  async start(input: Parameters<AgentRunner["start"]>[0]): Promise<AgentSession> {
    const queue = new AsyncEventQueue<NormalizedEvent>();
    const children: Array<ChildProcessByStdio<null, Readable, Readable>> = [];
    const toolRegistration = buildClaudeToolRegistration(input.tools, input.issue, input.workspacePath);
    let sessionId = "pending";
    const launch = async (args: string[]) => {
      const sink = input.openTurnSink ? await input.openTurnSink().catch(() => null) : null;
      const child = this.spawnProcess(args, input.workspacePath);
      children.push(child);
      child.once?.("error", () => {
        queue.close();
        void sink?.close();
      });
      void pumpClaudeEvents(
        child,
        (normalized) => {
          if (normalized.kind === "session_started") sessionId = normalized.sessionId;
          queue.push(normalized);
        },
        sink ?? undefined,
      )
        .then((sawTerminal) => {
          if (!sawTerminal) queue.close();
        })
        .catch(() => queue.close())
        .finally(() => sink?.close());
    };
    await launch(this.baseArgs(input.prompt, toolRegistration));
    const adapter = this;

    return {
      get sessionId() {
        return sessionId;
      },
      events: queue,
      async startTurn(turnInput) {
        if (sessionId === "pending") throw new Error("claude_code_session_id_not_available");
        await launch(adapter.resumeArgs(sessionId, continuationPrompt(turnInput.text, turnInput.toolResults), toolRegistration));
      },
      async cancel(reason: string) {
        for (const child of children) child.kill("SIGTERM");
        void reason;
      },
    };
  }

  private baseArgs(prompt: string, toolRegistration: ClaudeToolRegistration): string[] {
    const args = ["--output-format", "stream-json", "--verbose", "--print", withSystemPrompt(prompt, this.options.appendSystemPrompt), "--permission-mode", this.options.permissionMode];
    if (this.options.model) args.push("--model", this.options.model);
    const allowedTools = [...this.options.allowedTools, ...toolRegistration.allowedTools];
    if (allowedTools.length) args.push("--allowed-tools", allowedTools.join(","));
    if (this.options.disallowedTools.length) args.push("--disallowed-tools", this.options.disallowedTools.join(","));
    if (toolRegistration.mcpConfig) args.push("--mcp-config", toolRegistration.mcpConfig, "--strict-mcp-config");
    return args;
  }

  private resumeArgs(sessionId: string, text: string, toolRegistration: ClaudeToolRegistration): string[] {
    const args = ["--resume", sessionId, "--output-format", "stream-json", "--verbose", "--print", text, "--permission-mode", this.options.permissionMode];
    if (this.options.model) args.push("--model", this.options.model);
    const allowedTools = [...this.options.allowedTools, ...toolRegistration.allowedTools];
    if (allowedTools.length) args.push("--allowed-tools", allowedTools.join(","));
    if (this.options.disallowedTools.length) args.push("--disallowed-tools", this.options.disallowedTools.join(","));
    if (toolRegistration.mcpConfig) args.push("--mcp-config", toolRegistration.mcpConfig, "--strict-mcp-config");
    return args;
  }

  private spawnProcess(args: string[], cwd: string): ChildProcessByStdio<null, Readable, Readable> {
    const spawnProcess = this.options.spawnProcess ?? spawn;
    return spawnProcess(this.options.command, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
  }
}

export function mapClaudeStreamEvent(raw: any): NormalizedEvent | NormalizedEvent[] | null {
  if (raw.type === "system" && raw.subtype === "init") return { kind: "session_started", sessionId: raw.session_id };
  if (raw.type === "assistant") {
    const mapped: NormalizedEvent[] = [];
    for (const block of raw.message?.content ?? raw.content ?? []) {
      if (block.type === "text" && block.text) mapped.push({ kind: "message", text: block.text, final: true });
      // tool_use blocks (Claude built-ins like Bash/Edit and the MCP-routed iris_run) are
      // handled inside the Claude subprocess; we don't forward them to the orchestrator.
    }
    return mapped;
  }
  if (raw.type === "user") {
    // tool_result blocks pair with tool_use blocks we never forwarded; skip.
    return [];
  }
  if (raw.type === "result" && raw.subtype === "success") {
    return {
      kind: "turn_completed",
      usage: raw.usage
        ? {
            inputTokens: raw.usage.input_tokens ?? 0,
            outputTokens: raw.usage.output_tokens ?? 0,
            totalTokens: raw.usage.total_tokens ?? 0,
          }
        : undefined,
    };
  }
  if (raw.type === "result" && raw.subtype === "error_max_turns") return { kind: "turn_failed", reason: "max_turns" };
  if (raw.type === "result" && raw.subtype === "error_during_execution") {
    const message = String(raw.message ?? raw.error ?? "");
    if (/user input/i.test(message)) return { kind: "turn_input_required", prompt: message };
    return { kind: "turn_failed", reason: message || "error_during_execution" };
  }
  return null;
}

async function pumpClaudeEvents(
  child: ChildProcessByStdio<null, Readable, Readable>,
  push: (event: NormalizedEvent) => void,
  sink?: TurnSink,
): Promise<boolean> {
  let sawTerminal = false;
  const lines = createInterface({ input: child.stdout });
  for await (const line of lines) {
    if (!line.trim()) continue;
    sink?.write(line);
    const mapped = mapClaudeStreamEvent(JSON.parse(line));
    const list = Array.isArray(mapped) ? mapped : mapped ? [mapped] : [];
    for (const normalized of list) {
      if (
        normalized.kind === "turn_completed" ||
        normalized.kind === "turn_failed" ||
        normalized.kind === "turn_cancelled" ||
        normalized.kind === "turn_input_required"
      ) {
        sawTerminal = true;
      }
      push(normalized);
    }
  }
  return sawTerminal;
}

function withSystemPrompt(prompt: string, append: string): string {
  return append.trim() ? `${append.trim()}\n\n${prompt}` : prompt;
}

function continuationPrompt(text: string, toolResults?: Array<{ callId: string; result: unknown }>): string {
  if (!toolResults?.length) return text;
  const serialized = JSON.stringify(toolResults);
  return text.trim() ? `${text.trim()}\n\nTool results:\n${serialized}` : `Tool results:\n${serialized}`;
}

interface ClaudeToolRegistration {
  allowedTools: string[];
  mcpConfig?: string;
}

function buildClaudeToolRegistration(tools: Array<{ name: string }>, issue: { labels?: string[] }, workspacePath: string): ClaudeToolRegistration {
  const hasIris = tools.some((tool) => tool.name === "iris_run");
  if (!hasIris) return { allowedTools: [] };
  const { command: mcpCommand, args: mcpArgs } = resolveMcpServerCommand();
  const baseUrl = process.env.SYMPHONY_IRIS_BASE_URL ?? "https://swarmy.firsttofly.com";
  const tokenEnv = process.env.SYMPHONY_IRIS_TOKEN_ENV ?? "IRIS_TOKEN";
  return {
    allowedTools: ["mcp__symphony__iris_run"],
    mcpConfig: JSON.stringify({
      mcpServers: {
        symphony: {
          command: mcpCommand,
          args: mcpArgs,
          env: {
            SYMPHONY_IRIS_BASE_URL: baseUrl,
            SYMPHONY_IRIS_TOKEN_ENV: tokenEnv,
            [tokenEnv]: process.env[tokenEnv] ?? "",
            SYMPHONY_IRIS_DEFAULT_PROFILE: process.env.SYMPHONY_IRIS_DEFAULT_PROFILE ?? "claude-default-latest",
            SYMPHONY_IRIS_REQUEST_TIMEOUT_MS: process.env.SYMPHONY_IRIS_REQUEST_TIMEOUT_MS ?? "600000",
            SYMPHONY_IRIS_MAX_CONCURRENT: process.env.SYMPHONY_IRIS_MAX_CONCURRENT ?? "1",
            SYMPHONY_IRIS_PROFILE_OVERRIDES: process.env.SYMPHONY_IRIS_PROFILE_OVERRIDES ?? "{}",
            SYMPHONY_IRIS_SHARED_SEMAPHORE_KEY: process.env.SYMPHONY_IRIS_SHARED_SEMAPHORE_KEY ?? defaultSharedSemaphoreKey(baseUrl),
            SYMPHONY_IRIS_SHARED_SEMAPHORE_ROOT: process.env.SYMPHONY_IRIS_SHARED_SEMAPHORE_ROOT ?? "",
            SYMPHONY_IRIS_MAX_CALLS_PER_TURN: process.env.SYMPHONY_IRIS_MAX_CALLS_PER_TURN ?? "10",
            SYMPHONY_IRIS_ALLOW_PROFILE_OVERRIDE: process.env.SYMPHONY_IRIS_ALLOW_PROFILE_OVERRIDE ?? "true",
            SYMPHONY_IRIS_ON_BLOCKED: process.env.SYMPHONY_IRIS_ON_BLOCKED ?? "needs_human",
            SYMPHONY_BLOCKED_MARKER_PATH: join(workspacePath, ".symphony", "iris-blocked.json"),
            SYMPHONY_ISSUE_LABELS: (issue.labels ?? []).join(","),
          },
        },
      },
    }),
  };
}

export const BLOCKED_MARKER_RELATIVE_PATH = join(".symphony", "iris-blocked.json");

function defaultSharedSemaphoreKey(baseUrl: string): string {
  return `iris:${baseUrl}`;
}

export function resolveMcpServerCommand(): { command: string; args: string[] } {
  const here = dirname(fileURLToPath(import.meta.url));
  const jsPath = join(here, "claude_iris_mcp.js");
  if (existsSync(jsPath)) {
    return { command: process.execPath, args: [jsPath] };
  }
  // Dev mode: source-only (running under tsx). Spawn the .ts file via the local tsx binary.
  const tsPath = join(here, "claude_iris_mcp.ts");
  const tsxBin = findTsxBinary(here);
  if (tsxBin && existsSync(tsPath)) {
    return { command: process.execPath, args: [tsxBin, tsPath] };
  }
  // Fall through: let it fail visibly so the user knows to build first.
  return { command: process.execPath, args: [jsPath] };
}

function findTsxBinary(startDir: string): string | undefined {
  let dir = startDir;
  for (let i = 0; i < 8; i += 1) {
    const candidate = join(dir, "node_modules", ".bin", "tsx");
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return undefined;
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
