import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import { runSkill, LlmUnavailableError } from "../scripts/lib/llm-runner.mjs";

// runSkill reads SYMPHONY_LLM_RUNNER + SYMPHONY_CLAUDE_BIN +
// SYMPHONY_CODEX_BIN on every call; clear them for each test so a
// developer/CI shell setting can't pollute assertions.
const ENV_KEYS = ["SYMPHONY_LLM_RUNNER", "SYMPHONY_CLAUDE_BIN", "SYMPHONY_CODEX_BIN"];
let savedEnv;
beforeEach(() => {
  savedEnv = {};
  for (const k of ENV_KEYS) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
});
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

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
      claudeCommand: "sh",
      spawnImpl,
      timeoutMs: 5000,
    });
    expect(out).toBe("the result");
    expect(calls).toHaveLength(1);
    expect(calls[0].cmd).toBe("sh");
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
      codexCommand: "sh",
      spawnImpl,
      timeoutMs: 5000,
    });
    expect(out).toBe("codex result");
    expect(calls[0].cmd).toBe("sh");
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
    process.env.SYMPHONY_LLM_RUNNER = "codex";
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
  });
});

describe("runSkill — command resolution", () => {
  it("default claudeCommand is `npx --yes @anthropic-ai/claude-code@latest`", async () => {
    // No claudeCommand passed; no env override. Should fall back to the
    // npx default. Use spawnImpl to assert the argv shape without actually
    // spawning npx.
    const calls = [];
    const spawnImpl = vi.fn((cmd, args) => {
      calls.push({ cmd, args });
      return fakeChild({ stdoutChunks: ["ok"] });
    });
    await runSkill({ skill: "s", message: "m", runner: "claude", spawnImpl, timeoutMs: 1000 });
    expect(calls[0].cmd).toBe("npx");
    expect(calls[0].args.slice(0, 3)).toEqual(["--yes", "@anthropic-ai/claude-code@latest", "--print"]);
  });

  it("default codexCommand is `npx --yes @openai/codex@latest`", async () => {
    const calls = [];
    const spawnImpl = vi.fn((cmd, args) => {
      calls.push({ cmd, args });
      return fakeChild({ stdoutChunks: ["ok"] });
    });
    await runSkill({ skill: "s", message: "m", runner: "codex", spawnImpl, timeoutMs: 1000 });
    expect(calls[0].cmd).toBe("npx");
    expect(calls[0].args.slice(0, 3)).toEqual(["--yes", "@openai/codex@latest", "--ask-for-approval"]);
  });

  it("SYMPHONY_CLAUDE_BIN env override is whitespace-split into argv", async () => {
    process.env.SYMPHONY_CLAUDE_BIN = "npx --yes @anthropic-ai/claude-code@1.2.3";
    const calls = [];
    const spawnImpl = vi.fn((cmd, args) => {
      calls.push({ cmd, args });
      return fakeChild({ stdoutChunks: ["ok"] });
    });
    await runSkill({ skill: "s", message: "m", runner: "claude", spawnImpl, timeoutMs: 1000 });
    expect(calls[0].cmd).toBe("npx");
    expect(calls[0].args.slice(0, 2)).toEqual(["--yes", "@anthropic-ai/claude-code@1.2.3"]);
  });

  it("SYMPHONY_CODEX_BIN env override accepts a bare absolute path", async () => {
    // Use /bin/sh as a stand-in absolute path (always present so onPath
    // resolves; spawnImpl intercepts before we'd actually exec).
    process.env.SYMPHONY_CODEX_BIN = "/bin/sh";
    const calls = [];
    const spawnImpl = vi.fn((cmd, args) => {
      calls.push({ cmd, args });
      return fakeChild({ stdoutChunks: ["ok"] });
    });
    await runSkill({ skill: "s", message: "m", runner: "codex", spawnImpl, timeoutMs: 1000 });
    expect(calls[0].cmd).toBe("/bin/sh");
    // No leading args from a bare-path override.
    expect(calls[0].args[0]).toBe("--ask-for-approval");
  });

  it("explicit caller-supplied command beats env override", async () => {
    process.env.SYMPHONY_CLAUDE_BIN = "npx --yes @anthropic-ai/claude-code@latest";
    const calls = [];
    const spawnImpl = vi.fn((cmd, args) => {
      calls.push({ cmd, args });
      return fakeChild({ stdoutChunks: ["ok"] });
    });
    await runSkill({
      skill: "s", message: "m", runner: "claude",
      claudeCommand: "sh", // explicit wins
      spawnImpl, timeoutMs: 1000,
    });
    expect(calls[0].cmd).toBe("sh");
  });

  it("array-form claudeCommand prepends leading args", async () => {
    const calls = [];
    const spawnImpl = vi.fn((cmd, args) => {
      calls.push({ cmd, args });
      return fakeChild({ stdoutChunks: ["ok"] });
    });
    await runSkill({
      skill: "s", message: "m", runner: "claude",
      claudeCommand: ["sh", "-c", "echo wrapper"],
      spawnImpl, timeoutMs: 1000,
    });
    expect(calls[0].cmd).toBe("sh");
    expect(calls[0].args.slice(0, 2)).toEqual(["-c", "echo wrapper"]);
    // runner-specific args follow the leading args.
    expect(calls[0].args).toContain("--print");
  });
});
