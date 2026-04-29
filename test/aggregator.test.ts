import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createServer, type Server } from "node:http";
import { parseAggregatorConfig } from "../src/aggregator/config.js";
import { DaemonPoller } from "../src/aggregator/poller.js";
import { startAggregator, type AggregatorServer } from "../src/aggregator/index.js";

interface FakeState {
  running: number;
  runningSessions: any[];
  retrying: any[];
  codexTotals: { inputTokens: number; outputTokens: number; totalTokens: number };
  recentEvents: any[];
  workflowPath?: string;
}

function startFakeDaemon(state: FakeState | "fail" | (() => FakeState | "fail")): Promise<{ url: string; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const server: Server = createServer((req, res) => {
      const current = typeof state === "function" ? state() : state;
      if (current === "fail") {
        res.statusCode = 500;
        res.end("nope");
        return;
      }
      if (req.url === "/api/v1/state") {
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify(current));
        return;
      }
      res.statusCode = 404;
      res.end("nope");
    });
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as { port: number }).port;
      resolve({
        url: `http://127.0.0.1:${port}`,
        close: () => new Promise<void>((r) => server.close(() => r())),
      });
    });
  });
}

describe("parseAggregatorConfig", () => {
  it("parses a minimal config with sane defaults", () => {
    const config = parseAggregatorConfig(`
daemons:
  - name: a
    url: http://127.0.0.1:8787
  - name: b
    url: http://127.0.0.1:8788
`);
    expect(config.port).toBe(9000);
    expect(config.host).toBe("127.0.0.1");
    expect(config.daemons).toHaveLength(2);
    expect(config.daemons[0]).toEqual({ name: "a", url: "http://127.0.0.1:8787" });
  });

  it("rejects empty daemons", () => {
    expect(() => parseAggregatorConfig(`daemons: []`)).toThrow(/missing_daemons/);
    expect(() => parseAggregatorConfig(``)).toThrow(/missing_daemons/);
  });

  it("rejects duplicate daemon names", () => {
    expect(() =>
      parseAggregatorConfig(`
daemons:
  - { name: x, url: http://127.0.0.1:1 }
  - { name: x, url: http://127.0.0.1:2 }
`),
    ).toThrow(/duplicate_aggregator_daemon_name:x/);
  });

  it("rejects non-http URLs", () => {
    expect(() =>
      parseAggregatorConfig(`
daemons:
  - { name: x, url: "ftp://example" }
`),
    ).toThrow(/invalid_aggregator_daemon_url/);
  });
});

describe("DaemonPoller", () => {
  let alpha: { url: string; close: () => Promise<void> };
  let beta: { url: string; close: () => Promise<void> };

  beforeEach(async () => {
    alpha = await startFakeDaemon({
      running: 1,
      runningSessions: [{ issueId: "1", identifier: "alpha#1", state: "Todo", attempt: null, startedAtMs: 0, lastEventAtMs: 0, turnCount: 1, tokens: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } }],
      retrying: [],
      codexTotals: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      recentEvents: [{ ts: "2026-04-29T10:00:00.000Z", type: "turn_completed", issueIdentifier: "alpha#1" }],
      workflowPath: "/alpha/WORKFLOW.md",
    });
    beta = await startFakeDaemon("fail");
  });

  afterEach(async () => {
    await alpha.close();
    await beta.close();
  });

  it("marks reachable daemons reachable and others unreachable", async () => {
    const poller = new DaemonPoller({
      daemons: [
        { name: "alpha", url: alpha.url },
        { name: "beta", url: beta.url },
      ],
      intervalMs: 60_000,
      timeoutMs: 1_000,
    });
    await poller.pollOnce();
    const snap = poller.snapshot();
    const a = snap.find((d) => d.name === "alpha")!;
    const b = snap.find((d) => d.name === "beta")!;
    expect(a.reachable).toBe(true);
    expect(a.state?.running).toBe(1);
    expect(b.reachable).toBe(false);
    expect(b.lastError).toMatch(/^http_500$/);
  });
});

describe("aggregator HTTP server", () => {
  let alpha: { url: string; close: () => Promise<void> };
  let server: AggregatorServer;
  let baseUrl: string;

  beforeEach(async () => {
    alpha = await startFakeDaemon({
      running: 2,
      runningSessions: [
        { issueId: "1", identifier: "alpha#1", state: "Todo", sessionId: "s1", attempt: null, startedAtMs: Date.now(), lastEventAtMs: Date.now(), turnCount: 1, lastEventKind: "agent_message", tokens: { inputTokens: 10, outputTokens: 5, totalTokens: 15 }, workspacePath: "/tmp/a" },
        { issueId: "2", identifier: "alpha#2", state: "Review", sessionId: "s2", attempt: 1, startedAtMs: Date.now(), lastEventAtMs: Date.now(), turnCount: 3, lastEventKind: "tool_call", tokens: { inputTokens: 100, outputTokens: 50, totalTokens: 150 } },
      ],
      retrying: [{ issueId: "3", identifier: "alpha#3", attempt: 2, dueAtMs: Date.now() + 10000, error: "rate_limited" }],
      codexTotals: { inputTokens: 110, outputTokens: 55, totalTokens: 165 },
      recentEvents: [{ ts: "2026-04-29T11:00:00.000Z", type: "iris_blocked_handed_off", issueIdentifier: "alpha#9", payload: { reason: "captcha" } }],
      workflowPath: "/alpha/WORKFLOW.md",
    });

    server = await startAggregator({
      port: 0,
      host: "127.0.0.1",
      pollIntervalMs: 60_000,
      pollTimeoutMs: 2_000,
      recentEventsLimit: 20,
      refreshIntervalSec: 5,
      daemons: [{ name: "alpha", url: alpha.url }],
    });
    baseUrl = `http://${server.host}:${server.port}`;
    // Force a poll round before assertions, since startup poll is async.
    await new Promise((r) => setTimeout(r, 200));
  });

  afterEach(async () => {
    await server.close();
    await alpha.close();
  });

  it("GET / renders unified dashboard with sessions tagged by daemon", async () => {
    const res = await fetch(baseUrl + "/");
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("aggregator");
    expect(body).toContain("alpha#1");
    expect(body).toContain("alpha#2");
    expect(body).toContain("alpha#3");
    expect(body).toContain("rate_limited");
    expect(body).toContain("iris_blocked_handed_off");
  });

  it("GET /api/v1/state returns merged totals + per-daemon status", async () => {
    const res = await fetch(baseUrl + "/api/v1/state");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.counts.running).toBe(2);
    expect(body.counts.retrying).toBe(1);
    expect(body.counts.daemons).toBe(1);
    expect(body.counts.reachable).toBe(1);
    expect(body.tokens.totalTokens).toBe(165);
    expect(body.daemons).toHaveLength(1);
    expect(body.daemons[0].reachable).toBe(true);
    expect(body.recentEvents).toHaveLength(1);
  });

  it("POST /api/v1/refresh returns 202 and triggers a poll", async () => {
    const res = await fetch(baseUrl + "/api/v1/refresh", { method: "POST" });
    expect(res.status).toBe(202);
    const body = await res.json();
    expect(body.queued).toBe(true);
  });
});
