import { describe, it, expect, afterEach } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventHookRunner, type EventHookRule } from "../src/hooks/event_hooks.js";
import type { SymphonyEvent } from "../src/observability/event_log.js";

const dirs: string[] = [];

afterEach(async () => {
  while (dirs.length) await rm(dirs.pop()!, { recursive: true, force: true });
});

async function newScratchDir(): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), "symphony-hooks-"));
  dirs.push(d);
  return d;
}

function rule(partial: Partial<EventHookRule> & { script: string }): EventHookRule {
  return {
    name: partial.name ?? "test",
    types: partial.types ?? ["*"],
    script: partial.script,
    timeoutMs: partial.timeoutMs ?? 5_000,
  };
}

function event(partial: Partial<SymphonyEvent> = {}): SymphonyEvent {
  return {
    ts: partial.ts ?? new Date().toISOString(),
    type: partial.type ?? "turn_completed",
    issueId: partial.issueId ?? "i_1",
    issueIdentifier: partial.issueIdentifier ?? "repo#42",
    sessionId: partial.sessionId,
    turnSeq: partial.turnSeq,
    payload: partial.payload ?? { foo: "bar" },
  };
}

describe("EventHookRunner", () => {
  it("runs the script with SYMPHONY_* env vars and a JSON payload", async () => {
    const dir = await newScratchDir();
    const out = join(dir, "out.txt");
    const runner = new EventHookRunner({
      rules: [rule({ types: ["turn_completed"], script: `printf '%s|%s|%s|%s' "$SYMPHONY_EVENT_TYPE" "$SYMPHONY_ISSUE_IDENTIFIER" "$SYMPHONY_SESSION_ID" "$SYMPHONY_EVENT_PAYLOAD" > ${JSON.stringify(out)}` })],
    });
    runner.fire(event({ type: "turn_completed", sessionId: "thread-1", payload: { tokens: 42 } }));
    await runner.drain();
    const written = await readFile(out, "utf8");
    const [type, identifier, sessionId, payload] = written.split("|");
    expect(type).toBe("turn_completed");
    expect(identifier).toBe("repo#42");
    expect(sessionId).toBe("thread-1");
    expect(JSON.parse(payload!)).toEqual({ tokens: 42 });
  });

  it("only fires rules whose types match (or '*')", async () => {
    const dir = await newScratchDir();
    const a = join(dir, "a.txt");
    const b = join(dir, "b.txt");
    const c = join(dir, "c.txt");
    const runner = new EventHookRunner({
      rules: [
        rule({ name: "a", types: ["turn_completed"], script: `: > ${a}` }),
        rule({ name: "b", types: ["turn_failed"], script: `: > ${b}` }),
        rule({ name: "c", types: ["*"], script: `: > ${c}` }),
      ],
    });
    runner.fire(event({ type: "turn_completed" }));
    await runner.drain();
    expect(existsSync(a)).toBe(true);
    expect(existsSync(b)).toBe(false);
    expect(existsSync(c)).toBe(true);
  });

  it("isolates failures — a failing hook does not prevent others or throw", async () => {
    const dir = await newScratchDir();
    const ok = join(dir, "ok.txt");
    const runner = new EventHookRunner({
      rules: [
        rule({ name: "fails", script: "exit 7" }),
        rule({ name: "ok", script: `: > ${ok}` }),
      ],
    });
    expect(() => runner.fire(event())).not.toThrow();
    await runner.drain();
    expect(existsSync(ok)).toBe(true);
  });

  it("kills runaway scripts after the timeout", async () => {
    const dir = await newScratchDir();
    const marker = join(dir, "marker.txt");
    const runner = new EventHookRunner({
      rules: [rule({ name: "slow", script: `: > ${marker}; sleep 30`, timeoutMs: 100 })],
    });
    const startedAt = Date.now();
    runner.fire(event());
    await runner.drain();
    expect(Date.now() - startedAt).toBeLessThan(2_000);
    expect(existsSync(marker)).toBe(true);
  });

  it("ruleCount = 0 → fire() is a no-op (fast path)", () => {
    const runner = new EventHookRunner({ rules: [] });
    expect(runner.ruleCount).toBe(0);
    expect(() => runner.fire(event())).not.toThrow();
  });
});
