// scripts/lib/llm-runner.mjs
// Generic LLM CLI runner. Picks claude or codex based on PATH + env override,
// hands off to a per-runner spawn shape, returns the model's stdout.

import { spawn as nodeSpawn } from "node:child_process";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export class LlmUnavailableError extends Error {
  constructor(reason) { super(reason); this.name = "LlmUnavailableError"; this.reason = reason; }
}

export async function runSkill({
  skill,
  message,
  readOnlyDir = null,
  runner = "auto",
  claudeCommand = "claude",
  codexCommand = "codex",
  spawnImpl,
  timeoutMs = 120_000,
} = {}) {
  const spawner = spawnImpl ?? nodeSpawn;
  const chosen = pickRunner(runner, { claudeCommand, codexCommand });
  if (!chosen) throw new LlmUnavailableError("no_llm_on_path");

  if (chosen === "claude") {
    return await runClaude({ skill, message, readOnlyDir, claudeCommand, spawner, timeoutMs });
  }
  return await runCodex({ skill, message, readOnlyDir, codexCommand, spawner, timeoutMs });
}

function pickRunner(runner, { claudeCommand, codexCommand }) {
  const override = process.env.SYMPHONY_LLM_RUNNER;
  const want = override || runner;
  if (want === "claude") return onPath(claudeCommand) ? "claude" : null;
  if (want === "codex") return onPath(codexCommand) ? "codex" : null;
  // auto: prefer claude (existing behavior), fall back to codex
  if (onPath(claudeCommand)) return "claude";
  if (onPath(codexCommand)) return "codex";
  return null;
}

function onPath(bin) {
  try { execFileSync("which", [bin], { stdio: "ignore" }); return true; }
  catch { return false; }
}

function runClaude({ skill, message, readOnlyDir, claudeCommand, spawner, timeoutMs }) {
  const args = ["--print", "--input-format", "text", "--append-system-prompt", skill];
  if (readOnlyDir) {
    args.push("--allowed-tools", "Read,Glob,Grep", "--add-dir", readOnlyDir);
  }
  return spawnAndCollect(spawner, claudeCommand, args, message, timeoutMs);
}

async function runCodex({ skill, message, readOnlyDir, codexCommand, spawner, timeoutMs }) {
  const dir = await mkdtemp(join(tmpdir(), "symphony-codex-"));
  await writeFile(join(dir, "AGENTS.md"), skill, { mode: 0o600 });
  try {
    const args = [
      "exec",
      "--sandbox", "read-only",
      "--ask-for-approval", "never",
      "--cd", readOnlyDir ?? dir,
      "--add-dir", dir,
      "--skip-git-repo-check",
      "--color", "never",
      "-c", "project_doc_max_bytes=262144",
      "-",
    ];
    return await spawnAndCollect(spawner, codexCommand, args, message, timeoutMs);
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

function spawnAndCollect(spawner, cmd, args, stdin, timeoutMs) {
  return new Promise((resolveOut, rejectOut) => {
    const child = spawner(cmd, args, { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    child.stdin.end(stdin);
    child.stdout.on("data", (b) => { stdout += b.toString(); });
    child.stderr.on("data", (b) => { stderr += b.toString(); });
    const timer = setTimeout(() => {
      try { child.kill("SIGKILL"); } catch {}
      rejectOut(new Error(`${cmd}_timeout_after_${timeoutMs}ms`));
    }, timeoutMs);
    timer.unref?.();
    child.once("error", (err) => { clearTimeout(timer); rejectOut(err); });
    child.once("exit", (code) => {
      clearTimeout(timer);
      if (code === 0) resolveOut(stdout);
      else rejectOut(new Error(`${cmd}_exit_${code}:${stderr.trim().slice(-300)}`));
    });
  });
}
