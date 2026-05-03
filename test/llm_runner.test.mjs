import { describe, it, expect, vi } from "vitest";
import { EventEmitter } from "node:events";
import { runSkill, LlmUnavailableError } from "../scripts/lib/llm-runner.mjs";

function fakeChild({ stdoutChunks = [], exitCode = 0 } = {}) {
  const child = new EventEmitter();
  child.stdin = { end: vi.fn() };
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = vi.fn();
  process.nextTick(() => {
    for (const c of stdoutChunks) child.stdout.emit("data", Buffer.from(c));
    child.emit("exit", exitCode);
  });
  return child;
}

describe("runSkill — claude path", () => {
  it("spawns claude with --print + --append-system-prompt and pipes the message via stdin", async () => {
    const calls = [];
    const spawnImpl = vi.fn((cmd, args) => {
      calls.push({ cmd, args });
      return fakeChild({ stdoutChunks: ["the result"] });
    });
    const out = await runSkill({
      skill: "SKILL CONTENT",
      message: "hello",
      runner: "claude",
      claudeCommand: "claude",
      spawnImpl,
      timeoutMs: 5000,
    });
    expect(out).toBe("the result");
    expect(calls).toHaveLength(1);
    expect(calls[0].cmd).toBe("claude");
    expect(calls[0].args).toContain("--print");
    expect(calls[0].args).toContain("--input-format");
    expect(calls[0].args).toContain("text");
    expect(calls[0].args).toContain("--append-system-prompt");
    const idx = calls[0].args.indexOf("--append-system-prompt");
    expect(calls[0].args[idx + 1]).toBe("SKILL CONTENT");
  });
});

import { existsSync } from "node:fs";

describe("runSkill — codex path", () => {
  it("writes the skill to AGENTS.md in a tmp dir, spawns codex exec with the right flags, cleans up", async () => {
    const calls = [];
    let agentsMdPathSeen = null;
    const spawnImpl = vi.fn((cmd, args) => {
      calls.push({ cmd, args });
      const cdIdx = args.indexOf("--cd");
      const dir = args[cdIdx + 1];
      agentsMdPathSeen = `${dir}/AGENTS.md`;
      if (!existsSync(agentsMdPathSeen)) throw new Error(`AGENTS.md missing at ${agentsMdPathSeen}`);
      return fakeChild({ stdoutChunks: ["codex result"] });
    });
    const out = await runSkill({
      skill: "S",
      message: "m",
      runner: "codex",
      codexCommand: "codex",
      spawnImpl,
      timeoutMs: 5000,
    });
    expect(out).toBe("codex result");
    expect(calls[0].cmd).toBe("codex");
    expect(calls[0].args).toEqual(expect.arrayContaining([
      "exec", "--sandbox", "read-only",
      "--ask-for-approval", "never",
      "--skip-git-repo-check",
      "--color", "never",
      "-c", "project_doc_max_bytes=262144",
      "-",
    ]));
    expect(existsSync(agentsMdPathSeen)).toBe(false);
  });
});

describe("runSkill — selection", () => {
  it("throws LlmUnavailableError when neither runner is on PATH", async () => {
    await expect(runSkill({
      skill: "x", message: "y",
      runner: "auto",
      claudeCommand: "definitely-not-a-binary-xyz",
      codexCommand: "also-not-real-zyx",
      spawnImpl: () => { throw new Error("should not spawn"); },
    })).rejects.toThrow(LlmUnavailableError);
  });

  it("honors SYMPHONY_LLM_RUNNER=codex even when claude is on PATH", async () => {
    const prev = process.env.SYMPHONY_LLM_RUNNER;
    process.env.SYMPHONY_LLM_RUNNER = "codex";
    try {
      const calls = [];
      const spawnImpl = vi.fn((cmd, args) => {
        calls.push({ cmd, args });
        return fakeChild({ stdoutChunks: ["ok"] });
      });
      await runSkill({ skill: "s", message: "m", runner: "auto",
        claudeCommand: "sh", codexCommand: "sh",
        spawnImpl, timeoutMs: 1000 });
      expect(calls[0].cmd).toBe("sh");
      expect(calls[0].args).toContain("exec");
    } finally {
      if (prev === undefined) delete process.env.SYMPHONY_LLM_RUNNER;
      else process.env.SYMPHONY_LLM_RUNNER = prev;
    }
  });
});
