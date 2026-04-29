import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Orchestrator } from "../src/orchestrator/index.js";

afterEach(() => {
  vi.useRealTimers();
});

describe("orchestrator scheduling", () => {
  it("skips blocked issues and respects global concurrency", async () => {
    const runner = { start: vi.fn() };
    const tracker = {
      fetchCandidateIssues: vi.fn(async () => [
        { id: "1", identifier: "a#1", state: "Todo", priority: 2, blockedBy: [] },
        { id: "2", identifier: "a#2", state: "Todo", priority: 1, blockedBy: [{ id: "x", identifier: "a#0", state: "OPEN" }] },
      ]),
      fetchIssueStatesByIds: vi.fn(),
    };
    const workspace = { prepare: vi.fn(async () => ({ path: "/tmp/ws", key: "a_1" })) };
    const orch = new Orchestrator({
      tracker: tracker as any,
      workspace: workspace as any,
      runner: runner as any,
      renderPrompt: async () => "prompt",
      config: {
        agent: { maxConcurrentAgents: 1, maxConcurrentAgentsByState: {}, maxTurns: 20 },
        tracker: { terminalStates: ["Done"] },
      } as any,
    });

    await orch.tick();
    expect(runner.start).toHaveBeenCalledTimes(1);
    expect(runner.start.mock.calls[0][0].issue.identifier).toBe("a#1");
  });

  it("only applies blocker gating to Todo issues and uses stable dispatch sorting", async () => {
    const runner = { start: vi.fn(async () => ({ sessionId: "s1", events: emptyEvents(), startTurn: vi.fn(), cancel: vi.fn() })) };
    const tracker = {
      fetchCandidateIssues: vi.fn(async () => [
        { id: "3", identifier: "a#3", state: "In Progress", priority: 1, createdAt: "2026-04-03T00:00:00Z", blockedBy: [{ id: "x", identifier: "a#0", state: "OPEN" }] },
        { id: "2", identifier: "a#2", state: "Todo", priority: 1, createdAt: "2026-04-02T00:00:00Z", blockedBy: [] },
        { id: "1", identifier: "a#1", state: "Todo", priority: 1, createdAt: "2026-04-01T00:00:00Z", blockedBy: [] },
      ]),
      fetchIssueStatesByIds: vi.fn(async () => ({})),
    };
    const orch = new Orchestrator({
      tracker: tracker as any,
      workspace: { prepare: vi.fn(async () => ({ path: "/tmp/ws", key: "a_1" })) } as any,
      runner: runner as any,
      renderPrompt: async () => "prompt",
      config: baseConfig({ agent: { maxConcurrentAgents: 3, maxConcurrentAgentsByState: {}, maxTurns: 20, tools: { irisRun: { enabled: false }, github: { enabled: false } } } }),
    });

    await orch.tick();

    expect(runner.start.mock.calls.map((call) => call[0].issue.identifier)).toEqual(["a#1", "a#2", "a#3"]);
  });
});

it("consumes completed agent turns and runs verify when configured", async () => {
  async function* events() {
    yield { kind: "message", text: '{"verify_url":"https://preview.example.com"}', final: true } as const;
    yield { kind: "turn_completed" } as const;
  }

  const runner = { start: vi.fn(async () => ({ sessionId: "s1", events: events(), startTurn: vi.fn(), cancel: vi.fn() })) };
  const tracker = {
    fetchCandidateIssues: vi.fn(async () => [
      {
        id: "1",
        contentId: "I_1",
        identifier: "a#1",
        title: "A",
        description: "desc",
        labels: [],
        state: "Todo",
        priority: 1,
        blockedBy: [],
      },
    ]),
    fetchIssueStatesByIds: vi.fn(async () => ({})),
  };
  const workspace = { prepare: vi.fn(async () => ({ path: "/tmp/ws", key: "a_1" })) };
  const verifyStage = { run: vi.fn(async () => ({ kind: "passed" as const })) };
  const orch = new Orchestrator({
    tracker: tracker as any,
    workspace: workspace as any,
    runner: runner as any,
    verifyStage: verifyStage as any,
    renderPrompt: async () => "prompt",
    config: {
      agent: { maxConcurrentAgents: 1, maxConcurrentAgentsByState: {}, maxTurns: 20, tools: { irisRun: { enabled: false }, github: { enabled: false } } },
      tracker: { terminalStates: ["Done"] },
      verify: {
        enabled: true,
        trigger: "always",
        signalMarker: "VERIFY_REQUESTED",
        urlSource: "agent_output",
        agentOutputKey: "verify_url",
        urlLabelPrefix: "deploy:",
        urlStatic: "",
        profile: "",
        instructionTemplate: "visit {{ verify_url }}",
        onPass: { transitionTo: "In Review", commentTemplate: "pass" },
        onFail: { maxAttempts: 2, feedbackTemplate: "fail", finalTransitionTo: "Needs Human", finalCommentTemplate: "final" },
        onNoUrl: { transitionTo: "Needs Human", commentTemplate: "no url" },
      },
      iris: { defaultProfile: "default", profileOverrides: {}, onBlocked: "fail" },
    } as any,
  });

  await orch.tick();
  await vi.waitFor(() => expect(verifyStage.run).toHaveBeenCalledTimes(1));
  expect(orch.snapshot().running).toBe(0);
});

it("accumulates token totals from completed turns in the runtime snapshot", async () => {
  async function* events() {
    yield { kind: "turn_completed", usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 } } as const;
  }
  const orch = new Orchestrator({
    tracker: candidateTracker([{ id: "1", identifier: "a#1", state: "Todo", priority: 1, blockedBy: [] }]),
    workspace: { prepare: vi.fn(async () => ({ path: "/tmp/ws", key: "a_1" })) } as any,
    runner: { start: vi.fn(async () => ({ sessionId: "s1", events: events(), startTurn: vi.fn(), cancel: vi.fn() })) } as any,
    renderPrompt: async () => "prompt",
    config: baseConfig(),
  });

  await orch.tick();
  await vi.waitFor(() => expect(orch.snapshot().codexTotals.totalTokens).toBe(15));

  expect(orch.snapshot().codexTotals).toMatchObject({ inputTokens: 10, outputTokens: 5, totalTokens: 15 });
});

it("queues a short continuation retry after a clean completed turn", async () => {
  vi.useFakeTimers();
  async function* events() {
    yield { kind: "turn_completed" } as const;
  }
  const issue = { id: "1", contentId: "I_1", identifier: "a#1", title: "A", description: "desc", labels: [], state: "Todo", priority: 1, blockedBy: [] };
  const runner = { start: vi.fn(async () => ({ sessionId: "s1", events: events(), startTurn: vi.fn(), cancel: vi.fn() })) };
  const tracker = {
    fetchCandidateIssues: vi.fn(async () => [issue]),
    fetchIssueStatesByIds: vi.fn(async () => ({ "1": "Todo" })),
  };
  const orch = new Orchestrator({
    tracker: tracker as any,
    workspace: { prepare: vi.fn(async () => ({ path: "/tmp/ws", key: "a_1" })) } as any,
    runner: runner as any,
    renderPrompt: async () => "prompt",
    config: baseConfig({ tracker: { terminalStates: ["Done"], activeStates: ["Todo"], needsHumanState: "Needs Human" } }),
  });

  await orch.tick();
  await vi.waitFor(() => expect(orch.snapshot().retrying).toHaveLength(1));

  await vi.advanceTimersByTimeAsync(1_000);

  await vi.waitFor(() => expect(runner.start).toHaveBeenCalledTimes(2));
  expect(runner.start.mock.calls[1][0].attempt).toBe(1);
});

it("passes only implemented and available tool specs to the agent runner", async () => {
  const runner = { start: vi.fn(async () => ({ sessionId: "s1", events: emptyEvents(), startTurn: vi.fn(), cancel: vi.fn() })) };
  const renderPrompt = vi.fn(async () => "prompt");
  const orch = new Orchestrator({
    tracker: candidateTracker([{ id: "1", identifier: "a#1", state: "Todo", priority: 1, blockedBy: [] }]),
    workspace: { prepare: vi.fn(async () => ({ path: "/tmp/ws", key: "a_1" })) } as any,
    runner: runner as any,
    iris: { run: vi.fn() } as any,
    renderPrompt,
    config: baseConfig({
      agent: {
        maxConcurrentAgents: 1,
        maxConcurrentAgentsByState: {},
        maxTurns: 20,
        tools: {
          irisRun: { enabled: true, maxCallsPerTurn: 3, allowProfileOverride: true },
          github: { enabled: true },
        },
      },
      iris: { enabled: true, defaultProfile: "default", profileOverrides: {}, onBlocked: "fail", blockedCommentTemplate: "blocked" },
    }),
  });

  await orch.tick();

  expect(runner.start.mock.calls[0][0].tools.map((tool: any) => tool.name)).toEqual(["iris_run"]);
  expect(renderPrompt.mock.calls[0][0].tools).toEqual({ iris_run: true, github: false });
});

it("does not advertise iris_run when IRIS is disabled or unavailable", async () => {
  const runner = { start: vi.fn(async () => ({ sessionId: "s1", events: emptyEvents(), startTurn: vi.fn(), cancel: vi.fn() })) };
  const renderPrompt = vi.fn(async () => "prompt");
  const orch = new Orchestrator({
    tracker: candidateTracker([{ id: "1", identifier: "a#1", state: "Todo", priority: 1, blockedBy: [] }]),
    workspace: { prepare: vi.fn(async () => ({ path: "/tmp/ws", key: "a_1" })) } as any,
    runner: runner as any,
    renderPrompt,
    config: baseConfig({
      agent: {
        maxConcurrentAgents: 1,
        maxConcurrentAgentsByState: {},
        maxTurns: 20,
        tools: {
          irisRun: { enabled: true, maxCallsPerTurn: 3, allowProfileOverride: true },
          github: { enabled: true },
        },
      },
      iris: { enabled: false, defaultProfile: "default", profileOverrides: {}, onBlocked: "fail", blockedCommentTemplate: "blocked" },
    }),
  });

  await orch.tick();

  expect(runner.start.mock.calls[0][0].tools).toEqual([]);
  expect(renderPrompt.mock.calls[0][0].tools).toEqual({ iris_run: false, github: false });
});

it("continues the same agent session with verification retry feedback", async () => {
  async function* events() {
    yield { kind: "message", text: '{"verify_url":"https://preview.example.com"}', final: true } as const;
    yield { kind: "turn_completed" } as const;
  }
  const startTurn = vi.fn();
  const runner = { start: vi.fn(async () => ({ sessionId: "s1", events: events(), startTurn, cancel: vi.fn() })) };
  const verifyStage = { run: vi.fn(async () => ({ kind: "retry" as const, feedback: "IRIS failed; fix it" })) };
  const orch = new Orchestrator({
    tracker: candidateTracker([{ id: "1", contentId: "I_1", identifier: "a#1", title: "A", description: "desc", labels: [], state: "Todo", priority: 1, blockedBy: [] }]),
    workspace: { prepare: vi.fn(async () => ({ path: "/tmp/ws", key: "a_1" })) } as any,
    runner: runner as any,
    verifyStage: verifyStage as any,
    renderPrompt: async () => "prompt",
    config: baseConfig({ verify: enabledVerifyConfig() }),
  });

  await orch.tick();
  await vi.waitFor(() => expect(startTurn).toHaveBeenCalledWith({ text: "IRIS failed; fix it" }));
});

it("handles advertised iris_run tool calls and returns tool results to the session", async () => {
  async function* events() {
    yield { kind: "tool_call", toolName: "iris_run", callId: "call_1", args: { instruction: "Check https://example.com", profile: "custom" } } as const;
  }
  const startTurn = vi.fn();
  const iris = { run: vi.fn(async () => ({ status: "success", containerId: "c1", result: '{"ok":true}', events: [] })) };
  const runner = { start: vi.fn(async () => ({ sessionId: "s1", events: events(), startTurn, cancel: vi.fn() })) };
  const orch = new Orchestrator({
    tracker: candidateTracker([{ id: "1", contentId: "I_1", identifier: "a#1", title: "A", description: "desc", labels: [], state: "Todo", priority: 1, blockedBy: [] }]),
    workspace: { prepare: vi.fn(async () => ({ path: "/tmp/ws", key: "a_1" })) } as any,
    runner: runner as any,
    iris: iris as any,
    renderPrompt: async () => "prompt",
    config: baseConfig({
      agent: {
        maxConcurrentAgents: 1,
        maxConcurrentAgentsByState: {},
        maxTurns: 20,
        tools: { irisRun: { enabled: true, maxCallsPerTurn: 3, allowProfileOverride: true }, github: { enabled: false } },
      },
      iris: { enabled: true, defaultProfile: "default", profileOverrides: {}, onBlocked: "fail", blockedCommentTemplate: "blocked" },
    }),
  });

  await orch.tick();
  await vi.waitFor(() =>
    expect(startTurn).toHaveBeenCalledWith({
      text: "",
      toolResults: [{ callId: "call_1", result: { status: "success", containerId: "c1", result: '{"ok":true}', events: [] } }],
    }),
  );
  expect(iris.run).toHaveBeenCalledWith(expect.objectContaining({ instruction: "Check https://example.com", profile: "custom" }));
});

it("passes the live abort signal into iris_run tool calls", async () => {
  async function* events() {
    yield { kind: "tool_call", toolName: "iris_run", callId: "call_1", args: { instruction: "Check https://example.com" } } as const;
  }
  const iris = { run: vi.fn(async () => ({ status: "success", containerId: "c1", result: "ok", events: [] })) };
  const runner = { start: vi.fn(async () => ({ sessionId: "s1", events: events(), startTurn: vi.fn(), cancel: vi.fn() })) };
  const orch = new Orchestrator({
    tracker: candidateTracker([{ id: "1", contentId: "I_1", identifier: "a#1", title: "A", description: "desc", labels: [], state: "Todo", priority: 1, blockedBy: [] }]),
    workspace: { prepare: vi.fn(async () => ({ path: "/tmp/ws", key: "a_1" })) } as any,
    runner: runner as any,
    iris: iris as any,
    renderPrompt: async () => "prompt",
    config: baseConfig({
      iris: { enabled: true, defaultProfile: "default", profileOverrides: {}, onBlocked: "fail", blockedCommentTemplate: "blocked" },
    }),
  });

  await orch.tick();
  await vi.waitFor(() => expect(iris.run).toHaveBeenCalledTimes(1));

  expect(iris.run.mock.calls[0][0].abortSignal).toBeInstanceOf(AbortSignal);
});

it("enforces the iris_run per-turn call limit", async () => {
  async function* events() {
    yield { kind: "tool_call", toolName: "iris_run", callId: "call_1", args: { instruction: "One" } } as const;
    yield { kind: "tool_call", toolName: "iris_run", callId: "call_2", args: { instruction: "Two" } } as const;
  }
  const startTurn = vi.fn();
  const iris = { run: vi.fn(async () => ({ status: "success", containerId: "c1", result: "ok", events: [] })) };
  const runner = { start: vi.fn(async () => ({ sessionId: "s1", events: events(), startTurn, cancel: vi.fn() })) };
  const orch = new Orchestrator({
    tracker: candidateTracker([{ id: "1", contentId: "I_1", identifier: "a#1", title: "A", description: "desc", labels: [], state: "Todo", priority: 1, blockedBy: [] }]),
    workspace: { prepare: vi.fn(async () => ({ path: "/tmp/ws", key: "a_1" })) } as any,
    runner: runner as any,
    iris: iris as any,
    renderPrompt: async () => "prompt",
    config: baseConfig({
      agent: {
        maxConcurrentAgents: 1,
        maxConcurrentAgentsByState: {},
        maxTurns: 20,
        tools: { irisRun: { enabled: true, maxCallsPerTurn: 1, allowProfileOverride: true }, github: { enabled: false } },
      },
      iris: { enabled: true, defaultProfile: "default", profileOverrides: {}, onBlocked: "fail", blockedCommentTemplate: "blocked" },
    }),
  });

  await orch.tick();
  await vi.waitFor(() => expect(startTurn).toHaveBeenCalledTimes(2));

  expect(iris.run).toHaveBeenCalledTimes(1);
  expect(startTurn.mock.calls[1][0]).toEqual({
    text: "",
    toolResults: [{ callId: "call_2", result: { error: "iris_run_call_limit_exceeded" } }],
  });
});

it("resets iris_run call count before a verification retry continuation", async () => {
  async function* events() {
    yield { kind: "tool_call", toolName: "iris_run", callId: "call_1", args: { instruction: "One" } } as const;
    yield { kind: "message", text: '{"verify_url":"https://preview.example.com"}', final: true } as const;
    yield { kind: "turn_completed" } as const;
    yield { kind: "tool_call", toolName: "iris_run", callId: "call_2", args: { instruction: "Two" } } as const;
  }
  const startTurn = vi.fn();
  const iris = { run: vi.fn(async () => ({ status: "success", containerId: "c1", result: "ok", events: [] })) };
  const verifyStage = { run: vi.fn(async () => ({ kind: "retry" as const, feedback: "try again" })) };
  const runner = { start: vi.fn(async () => ({ sessionId: "s1", events: events(), startTurn, cancel: vi.fn() })) };
  const orch = new Orchestrator({
    tracker: candidateTracker([{ id: "1", contentId: "I_1", identifier: "a#1", title: "A", description: "desc", labels: [], state: "Todo", priority: 1, blockedBy: [] }]),
    workspace: { prepare: vi.fn(async () => ({ path: "/tmp/ws", key: "a_1" })) } as any,
    runner: runner as any,
    iris: iris as any,
    verifyStage: verifyStage as any,
    renderPrompt: async () => "prompt",
    config: baseConfig({
      agent: {
        maxConcurrentAgents: 1,
        maxConcurrentAgentsByState: {},
        maxTurns: 20,
        tools: { irisRun: { enabled: true, maxCallsPerTurn: 1, allowProfileOverride: true }, github: { enabled: false } },
      },
      iris: { enabled: true, defaultProfile: "default", profileOverrides: {}, onBlocked: "fail", blockedCommentTemplate: "blocked" },
      verify: enabledVerifyConfig(),
    }),
  });

  await orch.tick();
  await vi.waitFor(() => expect(iris.run).toHaveBeenCalledTimes(2));

  expect(startTurn.mock.calls.at(-1)?.[0]).toEqual({
    text: "",
    toolResults: [{ callId: "call_2", result: { status: "success", containerId: "c1", result: "ok", events: [] } }],
  });
});

it("hands off blocked iris_run calls to needs human and cancels the session", async () => {
  async function* events() {
    yield { kind: "tool_call", toolName: "iris_run", callId: "call_1", args: { instruction: "Log in" } } as const;
  }
  const cancel = vi.fn();
  const startTurn = vi.fn();
  const iris = { run: vi.fn(async () => ({ status: "blocked", containerId: "c1", result: "", blocked: { vncUrl: "https://vnc.example.com", reason: "MFA" }, events: [] })) };
  const tracker = {
    ...candidateTracker([{ id: "1", contentId: "I_1", identifier: "a#1", title: "A", description: "desc", labels: [], state: "Todo", priority: 1, blockedBy: [] }]),
    transitionIssue: vi.fn(),
    commentOnIssue: vi.fn(),
  };
  const runner = { start: vi.fn(async () => ({ sessionId: "s1", events: events(), startTurn, cancel })) };
  const orch = new Orchestrator({
    tracker: tracker as any,
    workspace: { prepare: vi.fn(async () => ({ path: "/tmp/ws", key: "a_1" })) } as any,
    runner: runner as any,
    iris: iris as any,
    renderPrompt: async () => "prompt",
    config: baseConfig({
      agent: {
        maxConcurrentAgents: 1,
        maxConcurrentAgentsByState: {},
        maxTurns: 20,
        tools: { irisRun: { enabled: true, maxCallsPerTurn: 3, allowProfileOverride: true }, github: { enabled: false } },
      },
      iris: {
        enabled: true,
        defaultProfile: "default",
        profileOverrides: {},
        onBlocked: "needs_human",
        blockedCommentTemplate: "Blocked {{ blocked.reason }} {{ blocked.vnc_url }}",
      },
    }),
  });

  await orch.tick();
  await vi.waitFor(() => expect(cancel).toHaveBeenCalledWith("iris_blocked_handed_off"));
  expect(tracker.transitionIssue).toHaveBeenCalledWith(expect.objectContaining({ id: "1" }), "Needs Human");
  expect(tracker.commentOnIssue).toHaveBeenCalledWith(expect.objectContaining({ contentId: "I_1" }), "Blocked MFA https://vnc.example.com");
  expect(startTurn).not.toHaveBeenCalled();
});

it("hands off blocked Claude MCP iris_run results to needs human and cancels the session", async () => {
  const blockedResult = {
    status: "blocked",
    containerId: "c1",
    result: "",
    blocked: { vncUrl: "https://vnc.example.com", reason: "MFA" },
    events: [],
  };
  async function* events() {
    yield {
      kind: "tool_result",
      callId: "toolu_1",
      result: [{ type: "text", text: JSON.stringify(blockedResult) }],
    } as const;
  }
  const cancel = vi.fn();
  const tracker = {
    ...candidateTracker([{ id: "1", contentId: "I_1", identifier: "a#1", title: "A", description: "desc", labels: [], state: "Todo", priority: 1, blockedBy: [] }]),
    transitionIssue: vi.fn(),
    commentOnIssue: vi.fn(),
  };
  const orch = new Orchestrator({
    tracker: tracker as any,
    workspace: { prepare: vi.fn(async () => ({ path: "/tmp/ws", key: "a_1" })) } as any,
    runner: { start: vi.fn(async () => ({ sessionId: "s1", events: events(), startTurn: vi.fn(), cancel })) } as any,
    renderPrompt: async () => "prompt",
    config: baseConfig({
      iris: {
        enabled: true,
        defaultProfile: "default",
        profileOverrides: {},
        onBlocked: "needs_human",
        blockedCommentTemplate: "Blocked {{ blocked.reason }} {{ blocked.vnc_url }}",
      },
    }),
  });

  await orch.tick();
  await vi.waitFor(() => expect(cancel).toHaveBeenCalledWith("iris_blocked_handed_off"));
  expect(tracker.transitionIssue).toHaveBeenCalledWith(expect.objectContaining({ id: "1" }), "Needs Human");
  expect(tracker.commentOnIssue).toHaveBeenCalledWith(expect.objectContaining({ contentId: "I_1" }), "Blocked MFA https://vnc.example.com");
});

it("runs before_run before the agent and after_run after the session ends", async () => {
  const order: string[] = [];
  async function* events() {
    order.push("event");
    yield { kind: "turn_completed" } as const;
  }
  const workspace = {
    prepare: vi.fn(async () => ({ path: "/tmp/ws", key: "a_1" })),
    beforeRun: vi.fn(async () => order.push("before")),
    afterRun: vi.fn(async () => order.push("after")),
  };
  const runner = {
    start: vi.fn(async () => {
      order.push("start");
      return { sessionId: "s1", events: events(), startTurn: vi.fn(), cancel: vi.fn() };
    }),
  };
  const orch = new Orchestrator({
    tracker: candidateTracker([{ id: "1", identifier: "a#1", state: "Todo", priority: 1, blockedBy: [] }]),
    workspace: workspace as any,
    runner: runner as any,
    renderPrompt: async () => "prompt",
    config: baseConfig(),
  });

  await orch.tick();
  await vi.waitFor(() => expect(workspace.afterRun).toHaveBeenCalledTimes(1));
  expect(order).toEqual(["before", "start", "event", "after"]);
});

it("cancels the live agent session when reconciliation sees a terminal state", async () => {
  async function* events() {
    await new Promise(() => undefined);
  }
  const cancel = vi.fn();
  const tracker = {
    fetchCandidateIssues: vi
      .fn()
      .mockResolvedValueOnce([{ id: "1", identifier: "a#1", state: "Todo", priority: 1, blockedBy: [] }])
      .mockResolvedValue([]),
    fetchIssueStatesByIds: vi.fn(async (ids: string[]) => (ids.length ? { "1": "Done" } : {})),
  };
  const orch = new Orchestrator({
    tracker: tracker as any,
    workspace: { prepare: vi.fn(async () => ({ path: "/tmp/ws", key: "a_1" })) } as any,
    runner: { start: vi.fn(async () => ({ sessionId: "s1", events: events(), startTurn: vi.fn(), cancel })) } as any,
    renderPrompt: async () => "prompt",
    config: baseConfig(),
  });

  await orch.tick();
  expect(orch.snapshot().running).toBe(1);
  await orch.tick();

  expect(cancel).toHaveBeenCalledWith("terminal_state:Done");
  expect(orch.snapshot().running).toBe(0);
});

it("cancels the live agent session when reconciliation sees a non-active state", async () => {
  async function* events() {
    await new Promise(() => undefined);
  }
  const cancel = vi.fn();
  const tracker = {
    fetchCandidateIssues: vi
      .fn()
      .mockResolvedValueOnce([{ id: "1", identifier: "a#1", state: "Todo", priority: 1, blockedBy: [] }])
      .mockResolvedValue([]),
    fetchIssueStatesByIds: vi.fn(async (ids: string[]) => (ids.length ? { "1": "Paused" } : {})),
  };
  const orch = new Orchestrator({
    tracker: tracker as any,
    workspace: { prepare: vi.fn(async () => ({ path: "/tmp/ws", key: "a_1" })) } as any,
    runner: { start: vi.fn(async () => ({ sessionId: "s1", events: events(), startTurn: vi.fn(), cancel })) } as any,
    renderPrompt: async () => "prompt",
    config: baseConfig({ tracker: { terminalStates: ["Done"], activeStates: ["Todo"], needsHumanState: "Needs Human" } }),
  });

  await orch.tick();
  await orch.tick();

  expect(cancel).toHaveBeenCalledWith("inactive_state:Paused");
  expect(orch.snapshot().running).toBe(0);
});

it("keeps live sessions running when state refresh fails", async () => {
  async function* events() {
    await new Promise(() => undefined);
  }
  const cancel = vi.fn();
  const tracker = {
    fetchCandidateIssues: vi
      .fn()
      .mockResolvedValueOnce([{ id: "1", identifier: "a#1", state: "Todo", priority: 1, blockedBy: [] }])
      .mockResolvedValue([]),
    fetchIssueStatesByIds: vi.fn(async () => {
      throw new Error("github down");
    }),
  };
  const orch = new Orchestrator({
    tracker: tracker as any,
    workspace: { prepare: vi.fn(async () => ({ path: "/tmp/ws", key: "a_1" })) } as any,
    runner: { start: vi.fn(async () => ({ sessionId: "s1", events: events(), startTurn: vi.fn(), cancel })) } as any,
    renderPrompt: async () => "prompt",
    config: baseConfig({ tracker: { terminalStates: ["Done"], activeStates: ["Todo"], needsHumanState: "Needs Human" } }),
  });

  await orch.tick();
  await orch.tick();

  expect(cancel).not.toHaveBeenCalled();
  expect(orch.snapshot().running).toBe(1);
});

it("cancels stalled sessions and queues retry", async () => {
  vi.useFakeTimers();
  async function* events() {
    await new Promise(() => undefined);
  }
  const cancel = vi.fn();
  const issue = { id: "1", identifier: "a#1", state: "Todo", priority: 1, blockedBy: [] };
  const orch = new Orchestrator({
    tracker: {
      fetchCandidateIssues: vi.fn().mockResolvedValueOnce([issue]).mockResolvedValue([]),
      fetchIssueStatesByIds: vi.fn(async () => ({ "1": "Todo" })),
    } as any,
    workspace: { prepare: vi.fn(async () => ({ path: "/tmp/ws", key: "a_1" })) } as any,
    runner: { start: vi.fn(async () => ({ sessionId: "s1", events: events(), startTurn: vi.fn(), cancel })) } as any,
    renderPrompt: async () => "prompt",
    config: baseConfig({ claudeCode: { stallTimeoutMs: 100 }, tracker: { terminalStates: ["Done"], activeStates: ["Todo"], needsHumanState: "Needs Human" } }),
  });

  await orch.tick();
  await vi.advanceTimersByTimeAsync(101);
  await orch.tick();

  expect(cancel).toHaveBeenCalledWith("stalled");
  expect(orch.snapshot().retrying[0]).toMatchObject({ issueId: "1", attempt: 1, error: "stalled" });
});

it("runs state-triggered verify after a completed turn observes the trigger state", async () => {
  async function* events() {
    yield { kind: "turn_completed" } as const;
  }
  const issue = { id: "1", contentId: "I_1", identifier: "a#1", title: "A", description: "desc", labels: [], state: "Todo", priority: 1, blockedBy: [] };
  const verifyStage = { run: vi.fn(async () => ({ kind: "passed" as const })) };
  const tracker = {
    fetchCandidateIssues: vi.fn(async () => [issue]),
    fetchIssueStatesByIds: vi.fn(async (ids: string[]) => (ids.length ? { "1": "Ready For Verify" } : {})),
  };
  const orch = new Orchestrator({
    tracker: tracker as any,
    workspace: { prepare: vi.fn(async () => ({ path: "/tmp/ws", key: "a_1" })) } as any,
    runner: { start: vi.fn(async () => ({ sessionId: "s1", events: events(), startTurn: vi.fn(), cancel: vi.fn() })) } as any,
    verifyStage: verifyStage as any,
    renderPrompt: async () => "prompt",
    config: baseConfig({
      tracker: { terminalStates: ["Done"], activeStates: ["Todo", "Ready For Verify"], needsHumanState: "Needs Human" },
      verify: { ...enabledVerifyConfig(), trigger: "on_state_transition", triggerState: "Ready For Verify" },
    }),
  });

  await orch.tick();
  await vi.waitFor(() => expect(verifyStage.run).toHaveBeenCalledTimes(1));
});

it("runs verify when reconciliation observes the trigger state", async () => {
  async function* events() {
    await new Promise(() => undefined);
  }
  const issue = { id: "1", contentId: "I_1", identifier: "a#1", title: "A", description: "desc", labels: [], state: "Todo", priority: 1, blockedBy: [] };
  const verifyStage = { run: vi.fn(async () => ({ kind: "passed" as const })) };
  const tracker = {
    fetchCandidateIssues: vi.fn().mockResolvedValueOnce([issue]).mockResolvedValue([]),
    fetchIssueStatesByIds: vi.fn(async (ids: string[]) => (ids.length ? { "1": "Ready For Verify" } : {})),
  };
  const orch = new Orchestrator({
    tracker: tracker as any,
    workspace: { prepare: vi.fn(async () => ({ path: "/tmp/ws", key: "a_1" })) } as any,
    runner: { start: vi.fn(async () => ({ sessionId: "s1", events: events(), startTurn: vi.fn(), cancel: vi.fn() })) } as any,
    verifyStage: verifyStage as any,
    renderPrompt: async () => "prompt",
    config: baseConfig({
      verify: { ...enabledVerifyConfig(), trigger: "on_state_transition", triggerState: "Ready For Verify" },
    }),
  });

  await orch.tick();
  await orch.tick();

  expect(verifyStage.run).toHaveBeenCalledWith(expect.objectContaining({ issue: expect.objectContaining({ id: "1" }) }));
});

it("delivers retry feedback from state-triggered verify to the live session", async () => {
  async function* events() {
    await new Promise(() => undefined);
  }
  const startTurn = vi.fn();
  const issue = { id: "1", contentId: "I_1", identifier: "a#1", title: "A", description: "desc", labels: [], state: "Todo", priority: 1, blockedBy: [] };
  const verifyStage = { run: vi.fn(async () => ({ kind: "retry" as const, feedback: "state verify failed" })) };
  const tracker = {
    fetchCandidateIssues: vi.fn().mockResolvedValueOnce([issue]).mockResolvedValue([]),
    fetchIssueStatesByIds: vi.fn(async (ids: string[]) => (ids.length ? { "1": "Ready For Verify" } : {})),
  };
  const orch = new Orchestrator({
    tracker: tracker as any,
    workspace: { prepare: vi.fn(async () => ({ path: "/tmp/ws", key: "a_1" })) } as any,
    runner: { start: vi.fn(async () => ({ sessionId: "s1", events: events(), startTurn, cancel: vi.fn() })) } as any,
    verifyStage: verifyStage as any,
    renderPrompt: async () => "prompt",
    config: baseConfig({
      verify: { ...enabledVerifyConfig(), trigger: "on_state_transition", triggerState: "Ready For Verify" },
    }),
  });

  await orch.tick();
  await orch.tick();

  expect(startTurn).toHaveBeenCalledWith({ text: "state verify failed" });
});

it("refreshes live state during reconciliation for per-state concurrency accounting", async () => {
  async function* events() {
    await new Promise(() => undefined);
  }
  const runner = { start: vi.fn(async () => ({ sessionId: "s1", events: events(), startTurn: vi.fn(), cancel: vi.fn() })) };
  const tracker = {
    fetchCandidateIssues: vi
      .fn()
      .mockResolvedValueOnce([{ id: "1", identifier: "a#1", state: "Todo", priority: 1, blockedBy: [] }])
      .mockResolvedValueOnce([{ id: "2", identifier: "a#2", state: "In Progress", priority: 1, blockedBy: [] }]),
    fetchIssueStatesByIds: vi.fn(async (ids: string[]) => (ids.length ? { "1": "In Progress" } : {})),
  };
  const orch = new Orchestrator({
    tracker: tracker as any,
    workspace: { prepare: vi.fn(async () => ({ path: "/tmp/ws", key: "a_1" })) } as any,
    runner: runner as any,
    renderPrompt: async () => "prompt",
    config: baseConfig({
      agent: {
        maxConcurrentAgents: 2,
        maxConcurrentAgentsByState: { "in progress": 1 },
        maxTurns: 20,
        tools: { irisRun: { enabled: false }, github: { enabled: false } },
      },
    }),
  });

  await orch.tick();
  await orch.tick();

  expect(runner.start).toHaveBeenCalledTimes(1);
});

it("consumes the IRIS blocked marker after the session ends and skips retry", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "symphony-marker-"));
  try {
    const markerDir = join(workspaceRoot, ".symphony");
    await mkdir(markerDir, { recursive: true });
    await writeFile(join(markerDir, "iris-blocked.json"), JSON.stringify({ vncUrl: "https://vnc.example/x", reason: "captcha", writtenAt: "2026-04-29T00:00:00Z" }));

    async function* events() {
      // Claude exits with turn_completed after the MCP returned the blocked error.
      yield { kind: "turn_completed" } as const;
    }

    const startTurn = vi.fn();
    const cancel = vi.fn();
    const runner = { start: vi.fn(async () => ({ sessionId: "s1", events: events(), startTurn, cancel })) };
    const tracker = {
      fetchCandidateIssues: vi.fn(async () => [{ id: "1", contentId: "I_1", identifier: "a#1", state: "In Progress", priority: 1, labels: [], blockedBy: [] }]),
      fetchIssueStatesByIds: vi.fn(async () => ({ "1": "In Progress" })),
      transitionIssue: vi.fn(async () => undefined),
      commentOnIssue: vi.fn(async () => undefined),
    };
    const workspace = { prepare: vi.fn(async () => ({ path: workspaceRoot, key: "a_1" })) };
    const orch = new Orchestrator({
      tracker: tracker as any,
      workspace: workspace as any,
      runner: runner as any,
      renderPrompt: async () => "prompt",
      config: baseConfig({
        tracker: { terminalStates: ["Done"], activeStates: ["In Progress", "Todo"], needsHumanState: "Needs Human" },
        iris: { enabled: true, defaultProfile: "default", profileOverrides: {}, onBlocked: "needs_human", blockedCommentTemplate: "blocked: {{ blocked.reason }} ({{ blocked.vnc_url }})" },
      }),
    });

    await orch.tick();
    // Allow the consumeSession promise + finally block to complete.
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(tracker.transitionIssue).toHaveBeenCalledWith(expect.objectContaining({ id: "1" }), "Needs Human");
    expect(tracker.commentOnIssue).toHaveBeenCalled();
    const commentBody = (tracker.commentOnIssue.mock.calls[0] as any[])[1] as string;
    expect(commentBody).toContain("captcha");
    expect(commentBody).toContain("https://vnc.example/x");
    expect(orch.snapshot().retrying).toEqual([]);
    await expect(readFile(join(workspaceRoot, ".symphony", "iris-blocked.json"))).rejects.toThrow();
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

it("rolls back live state when workspace setup fails", async () => {
  const runner = { start: vi.fn() };
  const tracker = candidateTracker([{ id: "1", identifier: "a#1", state: "Todo", priority: 1, blockedBy: [] }]);
  const orch = new Orchestrator({
    tracker,
    workspace: { prepare: vi.fn(async () => { throw new Error("hook failed"); }) } as any,
    runner: runner as any,
    renderPrompt: async () => "prompt",
    config: baseConfig(),
  });

  await expect(orch.tick()).rejects.toThrow("hook failed");
  expect(orch.snapshot().running).toBe(0);
});

async function* emptyEvents() {}

function candidateTracker(issues: any[]) {
  return {
    fetchCandidateIssues: vi.fn(async () => issues),
    fetchIssueStatesByIds: vi.fn(async () => ({})),
  } as any;
}

function baseConfig(overrides: Record<string, any> = {}) {
  return {
    agent: { maxConcurrentAgents: 1, maxConcurrentAgentsByState: {}, maxTurns: 20, tools: { irisRun: { enabled: false }, github: { enabled: false } } },
    tracker: { terminalStates: ["Done"], needsHumanState: "Needs Human" },
    iris: { enabled: false, defaultProfile: "default", profileOverrides: {}, onBlocked: "fail", blockedCommentTemplate: "blocked" },
    verify: {},
    ...overrides,
  } as any;
}

function enabledVerifyConfig() {
  return {
    enabled: true,
    trigger: "always",
    signalMarker: "VERIFY_REQUESTED",
    urlSource: "agent_output",
    agentOutputKey: "verify_url",
    urlLabelPrefix: "deploy:",
    urlStatic: "",
    profile: "",
    instructionTemplate: "visit {{ verify_url }}",
    onPass: { transitionTo: "In Review", commentTemplate: "pass" },
    onFail: { maxAttempts: 2, feedbackTemplate: "fail", finalTransitionTo: "Needs Human", finalCommentTemplate: "final" },
    onNoUrl: { transitionTo: "Needs Human", commentTemplate: "no url" },
  };
}
