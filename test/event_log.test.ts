import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileEventLog, MemoryEventLog, type SymphonyEvent } from "../src/observability/event_log.js";
import { defaultDataDir, eventLogPath, turnLogPath } from "../src/observability/data_dir.js";

async function collect(iter: AsyncIterable<SymphonyEvent>): Promise<SymphonyEvent[]> {
  const out: SymphonyEvent[] = [];
  for await (const item of iter) out.push(item);
  return out;
}

describe("FileEventLog", () => {
  let dir: string;
  let logPath: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "symphony-eventlog-"));
    logPath = join(dir, "events.jsonl");
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("appends one JSON line per event with ISO ts", async () => {
    const log = new FileEventLog(logPath);
    await log.emit({ type: "issue_dispatched", issueIdentifier: "repo#1" });
    await log.emit({ type: "turn_completed", issueIdentifier: "repo#1", payload: { tokens: 42 } });
    await log.drain();
    const raw = await readFile(logPath, "utf8");
    const lines = raw.trim().split("\n");
    expect(lines).toHaveLength(2);
    const first = JSON.parse(lines[0]);
    expect(first.type).toBe("issue_dispatched");
    expect(first.issueIdentifier).toBe("repo#1");
    expect(first.ts).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });

  it("filters reads by issueIdentifier and type", async () => {
    const log = new FileEventLog(logPath);
    await log.emit({ type: "issue_dispatched", issueIdentifier: "repo#1" });
    await log.emit({ type: "issue_dispatched", issueIdentifier: "repo#2" });
    await log.emit({ type: "turn_completed", issueIdentifier: "repo#1" });
    await log.drain();

    expect(await collect(log.read({ issueIdentifier: "repo#1" }))).toHaveLength(2);
    expect(await collect(log.read({ type: "issue_dispatched" }))).toHaveLength(2);
    expect(await collect(log.read({ type: ["turn_completed", "issue_dispatched"], issueIdentifier: "repo#1" }))).toHaveLength(2);
  });

  it("returns nothing if file does not exist", async () => {
    const log = new FileEventLog(join(dir, "missing.jsonl"));
    expect(await collect(log.read())).toEqual([]);
  });

  it("creates parent directories on first write", async () => {
    const nestedPath = join(dir, "nested", "dir", "events.jsonl");
    const log = new FileEventLog(nestedPath);
    await log.emit({ type: "x" });
    await log.drain();
    const raw = await readFile(nestedPath, "utf8");
    expect(raw.trim().split("\n")).toHaveLength(1);
  });

  it("serializes concurrent writes (one append per emit, no interleaving)", async () => {
    const log = new FileEventLog(logPath);
    await Promise.all(
      Array.from({ length: 50 }, (_, i) => log.emit({ type: "x", payload: { i } })),
    );
    await log.drain();
    const raw = await readFile(logPath, "utf8");
    const lines = raw.trim().split("\n");
    expect(lines).toHaveLength(50);
    for (const line of lines) JSON.parse(line);
  });
});

describe("MemoryEventLog", () => {
  it("stores events without writing to disk", async () => {
    const log = new MemoryEventLog();
    await log.emit({ type: "a", issueIdentifier: "x" });
    await log.emit({ type: "b", issueIdentifier: "y" });
    expect(log.snapshot()).toHaveLength(2);
    expect((await collect(log.read({ type: "a" }))).map((event) => event.issueIdentifier)).toEqual(["x"]);
  });
});

describe("data_dir helpers", () => {
  it("defaultDataDir is deterministic per workflow path", () => {
    const a = defaultDataDir("/abs/path/WORKFLOW.md");
    const b = defaultDataDir("/abs/path/WORKFLOW.md");
    expect(a).toBe(b);
    expect(a).toMatch(/\.symphony\/[0-9a-f]{12}$/);
  });

  it("defaultDataDir differs across workflow paths", () => {
    expect(defaultDataDir("/a/WORKFLOW.md")).not.toBe(defaultDataDir("/b/WORKFLOW.md"));
  });

  it("eventLogPath and turnLogPath sanitize identifiers", () => {
    expect(eventLogPath("/data")).toBe("/data/events.jsonl");
    expect(turnLogPath("/data", "owner/repo#42", "thread/turn")).toBe("/data/turns/owner_repo_42/thread_turn.jsonl");
  });
});

