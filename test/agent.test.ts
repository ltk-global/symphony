import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { ClaudeCodeAdapter, mapClaudeStreamEvent, resolveMcpServerCommand } from "../src/agent/claude_code.js";
import { hasJsonRpcResponseId, resolveMcpIrisProfile } from "../src/agent/claude_iris_mcp.js";
import { CodexAdapter, mapCodexEvent } from "../src/agent/codex.js";

describe("agent event mappers", () => {
  it("maps Claude Code stream-json events", () => {
    expect(mapClaudeStreamEvent({ type: "system", subtype: "init", session_id: "s1" })).toEqual({
      kind: "session_started",
      sessionId: "s1",
    });
    // Claude built-ins (Bash/Edit/etc) and the MCP-routed iris_run are handled inside the
    // Claude subprocess. The adapter forwards only text messages, never tool_use blocks.
    expect(
      mapClaudeStreamEvent({
        type: "assistant",
        message: { content: [{ type: "text", text: "hello" }, { type: "tool_use", id: "t1", name: "Bash", input: { command: "ls" } }] },
      }),
    ).toEqual([{ kind: "message", text: "hello", final: true }]);
  });

  it("starts Claude continuation turns with --resume and the captured session id", async () => {
    const spawned: Array<{ args: string[]; stdout: PassThrough }> = [];
    const spawnProcess = vi.fn((_command: string, args: string[]) => {
      const stdout = new PassThrough();
      const proc = Object.assign(new EventEmitter(), {
        stdout,
        stderr: new PassThrough(),
        kill: vi.fn(),
      });
      spawned.push({ args, stdout });
      return proc;
    });
    const adapter = new ClaudeCodeAdapter({
      command: "claude",
      permissionMode: "acceptEdits",
      allowedTools: [],
      disallowedTools: [],
      appendSystemPrompt: "",
      maxTurns: 10,
      spawnProcess,
    } as any);

    const session = await adapter.start({
      workspacePath: "/tmp/ws",
      prompt: "initial",
      issue: {} as any,
      attempt: null,
      tools: [],
      abortSignal: new AbortController().signal,
    });
    const firstEvent = session.events[Symbol.asyncIterator]().next();
    spawned[0].stdout.write(`${JSON.stringify({ type: "system", subtype: "init", session_id: "claude-session-1" })}\n`);
    await expect(firstEvent).resolves.toMatchObject({ value: { kind: "session_started", sessionId: "claude-session-1" } });

    await session.startTurn({ text: "fix the verification failure" });

    expect(spawnProcess).toHaveBeenCalledTimes(2);
    expect(spawned[1].args).toEqual(expect.arrayContaining(["--resume", "claude-session-1", "--print", "fix the verification failure"]));
  });

  it("registers advertised Claude MCP tools before launch", async () => {
    const spawned: Array<{ args: string[]; stdout: PassThrough }> = [];
    const spawnProcess = vi.fn((_command: string, args: string[]) => {
      const stdout = new PassThrough();
      const proc = Object.assign(new EventEmitter(), {
        stdout,
        stderr: new PassThrough(),
        kill: vi.fn(),
      });
      spawned.push({ args, stdout });
      return proc;
    });
    const adapter = new ClaudeCodeAdapter({
      command: "claude",
      permissionMode: "acceptEdits",
      allowedTools: [],
      disallowedTools: [],
      appendSystemPrompt: "",
      maxTurns: 10,
      spawnProcess,
    } as any);

    await adapter.start({
      workspacePath: "/tmp/ws",
      prompt: "initial",
      issue: {} as any,
      attempt: null,
      tools: [{ name: "iris_run", description: "Run IRIS", inputSchema: { type: "object" } }],
      abortSignal: new AbortController().signal,
    });

    const args = spawned[0].args;
    expect(args).toContain("--mcp-config");
    expect(args).toContain("--allowed-tools");
    expect(args.join(" ")).toContain("mcp__symphony__iris_run");
    const config = JSON.parse(args[args.indexOf("--mcp-config") + 1]);
    // After build the MCP server is the compiled .js; under tsx dev it's the .ts source.
    expect(config.mcpServers.symphony.args.join(" ")).toMatch(/claude_iris_mcp\.(js|ts)$/);
  });

  it("runs the dev MCP server through the current Node executable", () => {
    const command = resolveMcpServerCommand();

    if (command.args.some((arg) => /claude_iris_mcp\.ts$/.test(arg))) {
      expect(command.command).toBe(process.execPath);
      expect(command.args[0]).toMatch(/tsx$/);
    }
  });

  it("passes issue labels and shared IRIS limiter configuration to Claude MCP", async () => {
    const spawned: Array<{ args: string[]; stdout: PassThrough }> = [];
    const spawnProcess = vi.fn((_command: string, args: string[]) => {
      const stdout = new PassThrough();
      const proc = Object.assign(new EventEmitter(), {
        stdout,
        stderr: new PassThrough(),
        kill: vi.fn(),
      });
      spawned.push({ args, stdout });
      return proc;
    });
    const adapter = new ClaudeCodeAdapter({
      command: "claude",
      permissionMode: "acceptEdits",
      allowedTools: [],
      disallowedTools: [],
      appendSystemPrompt: "",
      maxTurns: 10,
      spawnProcess,
    } as any);

    await adapter.start({
      workspacePath: "/tmp/ws",
      prompt: "initial",
      issue: { labels: ["mobile"] } as any,
      attempt: null,
      tools: [{ name: "iris_run", description: "Run IRIS", inputSchema: { type: "object" } }],
      abortSignal: new AbortController().signal,
    });

    const args = spawned[0].args;
    const config = JSON.parse(args[args.indexOf("--mcp-config") + 1]);
    expect(config.mcpServers.symphony.env.SYMPHONY_ISSUE_LABELS).toBe("mobile");
    expect(config.mcpServers.symphony.env.SYMPHONY_IRIS_PROFILE_OVERRIDES).toBeDefined();
    expect(config.mcpServers.symphony.env.SYMPHONY_IRIS_SHARED_SEMAPHORE_KEY).toBeDefined();
  });

  it("applies Claude MCP IRIS profile overrides from issue labels", () => {
    expect(
      resolveMcpIrisProfile(
        {},
        {
          SYMPHONY_IRIS_DEFAULT_PROFILE: "default",
          SYMPHONY_IRIS_PROFILE_OVERRIDES: JSON.stringify({ mobile: "mobile-profile" }),
          SYMPHONY_ISSUE_LABELS: "mobile,ready",
        },
      ),
    ).toBe("mobile-profile");
    expect(resolveMcpIrisProfile({ profile: "explicit" }, { SYMPHONY_IRIS_DEFAULT_PROFILE: "default" })).toBe("explicit");
  });

  it("ignores agent profile arg when allow_profile_override=false", () => {
    expect(
      resolveMcpIrisProfile(
        { profile: "explicit" },
        {
          SYMPHONY_IRIS_DEFAULT_PROFILE: "default",
          SYMPHONY_IRIS_PROFILE_OVERRIDES: JSON.stringify({ mobile: "mobile-profile" }),
          SYMPHONY_ISSUE_LABELS: "mobile",
          SYMPHONY_IRIS_ALLOW_PROFILE_OVERRIDE: "false",
        },
      ),
    ).toBe("mobile-profile");
    // No labels, no override allowed → falls back to default.
    expect(
      resolveMcpIrisProfile(
        { profile: "explicit" },
        { SYMPHONY_IRIS_DEFAULT_PROFILE: "default", SYMPHONY_IRIS_ALLOW_PROFILE_OVERRIDE: "false" },
      ),
    ).toBe("default");
  });

  it("does not re-emit any tool_use blocks to the orchestrator", () => {
    expect(
      mapClaudeStreamEvent({
        type: "assistant",
        message: { content: [{ type: "tool_use", id: "t1", name: "mcp__symphony__iris_run", input: { instruction: "go" } }] },
      }),
    ).toEqual([]);
    expect(
      mapClaudeStreamEvent({
        type: "user",
        message: { content: [{ type: "tool_result", tool_use_id: "t1", content: [{ type: "text", text: "ok" }] }] },
      }),
    ).toEqual([]);
  });

  it("treats JSON-RPC id 0 as requiring a response", () => {
    expect(hasJsonRpcResponseId({ id: 0 })).toBe(true);
    expect(hasJsonRpcResponseId({ id: null })).toBe(false);
    expect(hasJsonRpcResponseId({})).toBe(false);
  });

  it("forwards tool results into Claude continuation prompts", async () => {
    const spawned: Array<{ args: string[]; stdout: PassThrough }> = [];
    const spawnProcess = vi.fn((_command: string, args: string[]) => {
      const stdout = new PassThrough();
      const proc = Object.assign(new EventEmitter(), {
        stdout,
        stderr: new PassThrough(),
        kill: vi.fn(),
      });
      spawned.push({ args, stdout });
      return proc;
    });
    const adapter = new ClaudeCodeAdapter({
      command: "claude",
      permissionMode: "acceptEdits",
      allowedTools: [],
      disallowedTools: [],
      appendSystemPrompt: "",
      maxTurns: 10,
      spawnProcess,
    } as any);
    const session = await adapter.start({ workspacePath: "/tmp/ws", prompt: "initial", issue: {} as any, attempt: null, tools: [], abortSignal: new AbortController().signal });
    const firstEvent = session.events[Symbol.asyncIterator]().next();
    spawned[0].stdout.write(`${JSON.stringify({ type: "system", subtype: "init", session_id: "claude-session-1" })}\n`);
    await firstEvent;

    await session.startTurn({ text: "", toolResults: [{ callId: "call_1", result: { status: "success", result: "ok" } }] });

    const printed = spawned[1].args[spawned[1].args.indexOf("--print") + 1];
    expect(printed).toContain("Tool results:");
    expect(printed).toContain("call_1");
    expect(printed).toContain('"status":"success"');
  });

  it("closes Claude event streams when the process exits without a result event", async () => {
    const stdout = new PassThrough();
    const proc = Object.assign(new EventEmitter(), {
      stdout,
      stderr: new PassThrough(),
      kill: vi.fn(),
    });
    const adapter = new ClaudeCodeAdapter({
      command: "claude",
      permissionMode: "acceptEdits",
      allowedTools: [],
      disallowedTools: [],
      appendSystemPrompt: "",
      maxTurns: 10,
      spawnProcess: vi.fn(() => proc),
    } as any);
    const session = await adapter.start({ workspacePath: "/tmp/ws", prompt: "initial", issue: {} as any, attempt: null, tools: [], abortSignal: new AbortController().signal });
    const iterator = session.events[Symbol.asyncIterator]();
    const next = iterator.next();

    stdout.end();
    proc.emit("close", 1);

    await expect(next).resolves.toEqual({ value: undefined, done: true });
  });

  it("does an MCP-style handshake, then thread/start, then turn/start with the captured threadId", async () => {
    const stdinWrites: string[] = [];
    const stdout = new PassThrough();
    const spawnProcess = vi.fn(() =>
      Object.assign(new EventEmitter(), {
        stdin: { write: vi.fn((chunk: string) => stdinWrites.push(chunk)) },
        stdout,
        stderr: new PassThrough(),
        kill: vi.fn(),
      }),
    );
    const adapter = new CodexAdapter({ command: "codex app-server", spawnProcess, config: { approval_policy: "never" } } as any);

    await adapter.start({ workspacePath: "/tmp/ws", prompt: "do work", issue: { identifier: "a#1", title: "Fix it" } as any, attempt: null, tools: [], abortSignal: new AbortController().signal });

    // Right after start: only the initialize request has been written.
    expect(stdinWrites).toHaveLength(1);
    const init = JSON.parse(stdinWrites[0]);
    expect(init.method).toBe("initialize");
    expect(init.params).toMatchObject({ protocolVersion: expect.any(String), clientInfo: { name: "symphony" } });

    // Server returns the initialize result → adapter sends notifications/initialized + thread/start.
    stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: init.id, result: { userAgent: "test" } })}\n`);
    await vi.waitFor(() => expect(stdinWrites).toHaveLength(3));
    const messages = stdinWrites.map((line) => JSON.parse(line));
    expect(messages[1].method).toBe("notifications/initialized");
    expect(messages[2].method).toBe("thread/start");
    expect(messages[2].params).toMatchObject({ cwd: "/tmp/ws", approval_policy: "never" });

    // thread/start response with thread.id → adapter sends turn/start with input.
    stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: messages[2].id, result: { thread: { id: "thread_1" } } })}\n`);
    await vi.waitFor(() => expect(stdinWrites).toHaveLength(4));
    const turnStart = JSON.parse(stdinWrites[3]);
    expect(turnStart.method).toBe("turn/start");
    expect(turnStart.params).toMatchObject({ threadId: "thread_1", input: [{ type: "text", text: "do work" }] });
  });

  it("closes Codex event streams when the process exits before a terminal event", async () => {
    const stdout = new PassThrough();
    const proc = Object.assign(new EventEmitter(), {
      stdin: { write: vi.fn() },
      stdout,
      stderr: new PassThrough(),
      kill: vi.fn(),
    });
    const adapter = new CodexAdapter({ command: "codex app-server", spawnProcess: vi.fn(() => proc) } as any);
    const session = await adapter.start({ workspacePath: "/tmp/ws", prompt: "do work", issue: {} as any, attempt: null, tools: [], abortSignal: new AbortController().signal });
    const iterator = session.events[Symbol.asyncIterator]();
    const next = iterator.next();

    stdout.end();
    proc.emit("close", 1);

    await expect(next).resolves.toEqual({ value: undefined, done: true });
  });

  it("maps Codex JSON events (current and legacy method names)", () => {
    // Current Codex 0.125+ slash-style notifications.
    expect(mapCodexEvent({ method: "thread/started", params: { thread: { id: "th1" } } })).toEqual({
      kind: "session_started",
      sessionId: "th1",
    });
    expect(mapCodexEvent({ method: "turn/completed", params: { threadId: "th1" } })).toEqual({
      kind: "turn_completed",
    });
    expect(mapCodexEvent({ method: "turn/started", params: { turn: { id: "t1" } } })).toEqual({
      kind: "turn_started",
      turnId: "t1",
    });

    // Streaming agentMessage delta accumulates and emits one final message on item/completed.
    const messages = new Map();
    expect(mapCodexEvent({ method: "item/agentMessage/delta", params: { itemId: "msg_1", delta: "Hello " } }, messages)).toBeNull();
    expect(mapCodexEvent({ method: "item/agentMessage/delta", params: { itemId: "msg_1", delta: "world" } }, messages)).toBeNull();
    expect(mapCodexEvent({ method: "item/completed", params: { item: { type: "agentMessage", id: "msg_1", text: "" } } }, messages)).toEqual({
      kind: "message",
      text: "Hello world",
      final: true,
    });

    // Token usage from thread/tokenUsage/updated.
    expect(
      mapCodexEvent({ method: "thread/tokenUsage/updated", params: { tokenUsage: { last: { inputTokens: 10, outputTokens: 5, totalTokens: 15 } } } }),
    ).toEqual({ kind: "usage", inputTokens: 10, outputTokens: 5, totalTokens: 15 });

    // Legacy dot-style names still recognized.
    expect(mapCodexEvent({ method: "thread.started", params: { thread_id: "th2" } })).toEqual({ kind: "session_started", sessionId: "th2" });
    expect(mapCodexEvent({ method: "turn.completed", params: { turn_id: "t1" } })).toEqual({ kind: "turn_completed" });
  });
});
