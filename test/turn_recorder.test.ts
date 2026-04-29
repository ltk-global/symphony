import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TurnRecorder, turnFilePath } from "../src/observability/turn_recorder.js";

describe("TurnRecorder", () => {
  let dataDir: string;

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "symphony-turns-"));
  });

  afterEach(async () => {
    await rm(dataDir, { recursive: true, force: true });
  });

  it("opens distinct files per turn under turns/<issueId>/", async () => {
    const recorder = new TurnRecorder({ dataDir, issueId: "owner/repo#42" });
    const a = await recorder.open();
    a.write('{"raw":"line1"}');
    a.write('{"raw":"line2"}');
    await a.close();

    const b = await recorder.open();
    b.write('{"raw":"turn2"}');
    await b.close();

    const dir = join(dataDir, "turns", "owner_repo_42");
    const files = (await readdir(dir)).sort();
    expect(files).toHaveLength(2);
    const aContent = await readFile(join(dir, files[0]!), "utf8");
    const bContent = await readFile(join(dir, files[1]!), "utf8");
    expect(aContent.split("\n").filter(Boolean)).toHaveLength(2);
    expect(bContent.split("\n").filter(Boolean)).toHaveLength(1);
    expect(aContent).toContain('"line1"');
    expect(bContent).toContain('"turn2"');
  });

  it("appends only one trailing newline if the line already has one", async () => {
    const recorder = new TurnRecorder({ dataDir, issueId: "x" });
    const sink = await recorder.open();
    sink.write("first");
    sink.write("second\n");
    await sink.close();
    const content = await readFile(sink.path, "utf8");
    expect(content).toBe("first\nsecond\n");
  });

  it("close is idempotent", async () => {
    const recorder = new TurnRecorder({ dataDir, issueId: "x" });
    const sink = await recorder.open();
    sink.write("hello");
    await sink.close();
    await sink.close();
    expect(await readFile(sink.path, "utf8")).toBe("hello\n");
  });

  it("turnFilePath sanitizes issueId and includes turnSeq", () => {
    const path = turnFilePath("/tmp/data", "owner/repo#42", 3);
    expect(path).toMatch(/\/tmp\/data\/turns\/owner_repo_42\/.*-t3\.jsonl$/);
  });
});
