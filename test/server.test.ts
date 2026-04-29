import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startConsoleServer, type ConsoleServer } from "../src/server/index.js";
import { eventLogPath } from "../src/observability/data_dir.js";
import { eventCategory, formatPayload, sessionCategory, truncateMid } from "../src/server/render.js";

function fakeOrchestrator(snapshot: any) {
  return {
    snapshot: () => snapshot,
    tick: async () => {},
  };
}

async function fetchString(url: string): Promise<{ status: number; body: string; contentType: string }> {
  const res = await fetch(url);
  const body = await res.text();
  return { status: res.status, body, contentType: res.headers.get("content-type") ?? "" };
}

describe("render helpers", () => {
  it("eventCategory maps known event types to semantic colors", () => {
    expect(eventCategory("turn_completed")).toBe("ok");
    expect(eventCategory("verify_passed")).toBe("ok");
    expect(eventCategory("turn_failed")).toBe("err");
    expect(eventCategory("iris_blocked_handed_off")).toBe("err");
    expect(eventCategory("retry_scheduled")).toBe("warn");
    expect(eventCategory("status_drift_detected")).toBe("warn");
    expect(eventCategory("agent_message")).toBe("info");
    expect(eventCategory("daemon_reload")).toBe("neutral");
    expect(eventCategory("totally_unknown_type")).toBe("neutral");
  });

  it("sessionCategory derives color from lastEventKind", () => {
    expect(sessionCategory({ lastEventKind: "turn_completed" } as any)).toBe("ok");
    expect(sessionCategory({ lastEventKind: "turn_failed" } as any)).toBe("err");
    expect(sessionCategory({ lastEventKind: "turn_input_required" } as any)).toBe("warn");
    expect(sessionCategory({ lastEventKind: "agent_message" } as any)).toBe("info");
    expect(sessionCategory({} as any)).toBe("neutral");
  });

  it("truncateMid keeps both ends", () => {
    expect(truncateMid("short", 10)).toBe("short");
    expect(truncateMid("abcdefghijklmnop", 9)).toBe("abcd…mnop");
    expect(truncateMid("abcdefghijklmnop", 9).length).toBeLessThanOrEqual(9);
  });

  it("formatPayload joins key=value with quoting and truncation", () => {
    expect(formatPayload({ a: 1, b: "hi" })).toBe('a=1  b="hi"');
    expect(formatPayload({ x: null, y: true })).toBe("x=null  y=true");
    const long = formatPayload({ s: "x".repeat(200) }, 50);
    expect(long.length).toBeLessThanOrEqual(50);
    expect(long.endsWith("…")).toBe(true);
  });
});

describe("ConsoleServer endpoints", () => {
  let dataDir: string;
  let server: ConsoleServer;
  let baseUrl: string;

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "symphony-server-"));
    await mkdir(dataDir, { recursive: true });
    await writeFile(
      eventLogPath(dataDir),
      [
        JSON.stringify({ ts: "2026-04-29T12:00:00.000Z", type: "issue_dispatched", issueId: "i_1", issueIdentifier: "repo#1", payload: { state: "Todo" } }),
        JSON.stringify({ ts: "2026-04-29T12:00:01.000Z", type: "agent_session_started", issueId: "i_1", issueIdentifier: "repo#1", sessionId: "sess-A" }),
        JSON.stringify({ ts: "2026-04-29T12:00:02.000Z", type: "turn_completed", issueId: "i_1", issueIdentifier: "repo#1", sessionId: "sess-A", payload: { usage: { totalTokens: 42 } } }),
      ].join("\n") + "\n",
      "utf8",
    );
    server = await startConsoleServer({
      port: 0,
      orchestrator: fakeOrchestrator({
        running: 1,
        runningSessions: [
          {
            issueId: "i_1",
            identifier: "repo#1",
            state: "In Progress",
            sessionId: "sess-A-thread-1",
            attempt: null,
            startedAtMs: Date.now() - 30_000,
            lastEventAtMs: Date.now() - 5_000,
            turnCount: 2,
            lastEventKind: "agent_message",
            lastMessage: "looking at the codebase",
            tokens: { inputTokens: 80, outputTokens: 20, totalTokens: 100 },
            workspacePath: "/tmp/ws/repo_1",
          },
        ],
        retrying: [
          { issueId: "i_2", identifier: "repo#2", attempt: 2, dueAtMs: Date.now() + 20_000, error: "rate_limited" },
        ],
        codexTotals: { inputTokens: 80, outputTokens: 20, totalTokens: 100 },
      }),
      workflowPath: "/path/to/WORKFLOW.md",
      dataDir,
    });
    baseUrl = `http://${server.host}:${server.port}`;
  });

  afterEach(async () => {
    await server.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  it("GET / returns dense HTML with running + retrying + recent events", async () => {
    const res = await fetchString(baseUrl + "/");
    expect(res.status).toBe(200);
    expect(res.contentType).toMatch(/text\/html/);
    expect(res.body).toMatch(/<title>symphony · operator console<\/title>/);
    expect(res.body).toContain("running sessions");
    expect(res.body).toContain("repo#1");
    expect(res.body).toContain("repo#2");
    expect(res.body).toContain("turn_completed");
    expect(res.body).toContain("rate_limited");
    expect(res.body).toMatch(/meta http-equiv="refresh"/);
  });

  it("GET /api/v1/state returns full snapshot + recent events as JSON", async () => {
    const res = await fetch(baseUrl + "/api/v1/state");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.counts).toEqual({ running: 1, retrying: 1 });
    expect(body.running[0].identifier).toBe("repo#1");
    expect(body.retrying[0].identifier).toBe("repo#2");
    expect(body.codexTotals.totalTokens).toBe(100);
    expect(body.recentEvents).toHaveLength(3);
    expect(body.recentEvents[0].type).toBe("turn_completed");
  });

  it("GET /api/v1/issues/<id> returns timeline + live + retry", async () => {
    const res = await fetch(baseUrl + "/api/v1/issues/repo%231");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.identifier).toBe("repo#1");
    expect(body.live.sessionId).toBe("sess-A-thread-1");
    expect(body.events).toHaveLength(3);
  });

  it("GET /api/v1/issues/<unknown> returns 404 with structured error", async () => {
    const res = await fetch(baseUrl + "/api/v1/issues/never-seen");
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error.code).toBe("issue_not_found");
  });

  it("POST /api/v1/refresh returns 202 and queues a tick", async () => {
    const res = await fetch(baseUrl + "/api/v1/refresh", { method: "POST" });
    expect(res.status).toBe(202);
    const body = await res.json();
    expect(body.queued).toBe(true);
    expect(body.operations).toEqual(["poll", "reconcile"]);
  });

  it("rejects path traversal in turn file names", async () => {
    const res = await fetch(baseUrl + "/issues/repo%231/turns/..%2F..%2Fevents.jsonl");
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe("bad_path");
  });

  it("accepts owner/repo#N issue identifiers via /api/v1/issues/<id>", async () => {
    // Encoded: /api/v1/issues/repo%231 -> "repo#1"
    // Already covered by an earlier test. Belt-and-suspenders: also test the
    // fully-qualified owner/repo#N shape that real GitHub Projects emit.
    const res = await fetch(baseUrl + "/api/v1/issues/" + encodeURIComponent("ltk-global/symphony-todo-demo#4"));
    // We don't have that issue in the fake snapshot, so 404 is the success
    // condition — the important thing is "not 400 bad_path".
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error.code).toBe("issue_not_found");
  });

  it("accepts owner/repo#N issue identifiers via /issues/<id> HTML route", async () => {
    const res = await fetch(baseUrl + "/issues/" + encodeURIComponent("ltk-global/symphony-todo-demo#4"));
    // Identifier is unknown to the fake snapshot, but the renderer should still
    // produce the per-issue HTML shell (events: empty, turnFiles: empty). The
    // critical assertion is no bad_path 400.
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("ltk-global/symphony-todo-demo#4");
  });

  it("405 on unsupported method", async () => {
    const res = await fetch(baseUrl + "/", { method: "DELETE" });
    expect(res.status).toBe(405);
  });
});
