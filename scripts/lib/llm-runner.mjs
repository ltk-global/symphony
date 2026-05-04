// scripts/lib/llm-runner.mjs
// Generic LLM CLI runner. Picks claude or codex based on PATH + env override,
// hands off to a per-runner spawn shape, returns the model's stdout.
//
// Command resolution (per https://github.com/ltk-global/symphony):
//   1. Caller-supplied `claudeCommand` / `codexCommand` (string or argv array).
//   2. SYMPHONY_CLAUDE_BIN / SYMPHONY_CODEX_BIN env override (whitespace-split
//      into argv; supports `npx --yes @scope/pkg@1.2.3` for pinned versions).
//   3. Default: `npx --yes @scope/pkg@latest` — works on any machine with Node
//      and network. Avoids the homebrew-vs-npm-vs-PATH version-skew trap.
// Power users on offline boxes or with pinned native installs use the env
// override (or the workflow's `claude_code.command` / `codex.command` keys
// when wired through buildConfig).

import { spawn as nodeSpawn } from "node:child_process";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export class LlmUnavailableError extends Error {
  constructor(reason) { super(reason); this.name = "LlmUnavailableError"; this.reason = reason; }
}

// Default: npx-resolve the latest published package. Cost: ~200ms warm cache,
// ~5-10s cold. Bootstrap is already a 30-90s LLM round-trip so the overhead
// is negligible. Users who want a pinned/native binary set
// SYMPHONY_CLAUDE_BIN / SYMPHONY_CODEX_BIN.
const DEFAULT_CLAUDE_ARGV = Object.freeze(["npx", "--yes", "@anthropic-ai/claude-code@latest"]);
const DEFAULT_CODEX_ARGV = Object.freeze(["npx", "--yes", "@openai/codex@latest"]);

export async function runSkill({
  skill,
  message,
  readOnlyDir = null,
  runner = "auto",
  claudeCommand,
  codexCommand,
  spawnImpl,
  timeoutMs = 120_000,
} = {}) {
  const spawner = spawnImpl ?? nodeSpawn;
  const claudeArgv = resolveCommand("claude", claudeCommand);
  const codexArgv = resolveCommand("codex", codexCommand);
  const chosen = pickRunner(runner, { claudeArgv, codexArgv });
  if (!chosen) throw new LlmUnavailableError("no_llm_on_path");

  if (chosen === "claude") {
    return await runClaude({ skill, message, readOnlyDir, claudeArgv, spawner, timeoutMs });
  }
  return await runCodex({ skill, message, codexArgv, spawner, timeoutMs });
}

/**
 * Pick the runner that runSkill would invoke for the same arguments,
 * without spawning. Useful for callers that need to record the actual
 * runner in a manifest without re-implementing the auto-selection rules.
 * Returns "claude" | "codex" | null (when neither is available).
 */
export function whichLlm({ runner = "auto", claudeCommand, codexCommand } = {}) {
  const claudeArgv = resolveCommand("claude", claudeCommand);
  const codexArgv = resolveCommand("codex", codexCommand);
  return pickRunner(runner, { claudeArgv, codexArgv });
}

/**
 * Resolve `claudeCommand` / `codexCommand` to a normalized argv array.
 * Order of precedence:
 *   - explicit caller value (string → single-elem; array → as-is).
 *   - SYMPHONY_CLAUDE_BIN / SYMPHONY_CODEX_BIN env (whitespace-split).
 *   - default npx invocation.
 */
function resolveCommand(kind, explicit) {
  if (Array.isArray(explicit)) return explicit;
  if (typeof explicit === "string") return [explicit];
  const envVar = kind === "claude" ? "SYMPHONY_CLAUDE_BIN" : "SYMPHONY_CODEX_BIN";
  const envValue = process.env[envVar];
  if (envValue && envValue.trim()) {
    return envValue.trim().split(/\s+/);
  }
  return kind === "claude" ? [...DEFAULT_CLAUDE_ARGV] : [...DEFAULT_CODEX_ARGV];
}

function pickRunner(runner, { claudeArgv, codexArgv }) {
  const override = process.env.SYMPHONY_LLM_RUNNER;
  const want = override || runner;
  if (want === "claude") return onPath(claudeArgv[0]) ? "claude" : null;
  if (want === "codex") return onPath(codexArgv[0]) ? "codex" : null;
  // auto: prefer claude (existing behavior), fall back to codex.
  if (onPath(claudeArgv[0])) return "claude";
  if (onPath(codexArgv[0])) return "codex";
  return null;
}

const onPathCache = new Map();
function onPath(bin) {
  if (onPathCache.has(bin)) return onPathCache.get(bin);
  let ok;
  try { execFileSync("which", [bin], { stdio: "ignore" }); ok = true; }
  catch { ok = false; }
  onPathCache.set(bin, ok);
  return ok;
}

function runClaude({ skill, message, readOnlyDir, claudeArgv, spawner, timeoutMs }) {
  const [bin, ...leadingArgs] = claudeArgv;
  const args = [...leadingArgs, "--print", "--input-format", "text", "--append-system-prompt", skill];
  if (readOnlyDir) {
    args.push("--allowed-tools", "Read,Glob,Grep", "--add-dir", readOnlyDir);
  }
  return spawnAndCollect(spawner, bin, args, message, timeoutMs);
}

async function runCodex({ skill, message, codexArgv, spawner, timeoutMs }) {
  const dir = await mkdtemp(join(tmpdir(), "symphony-codex-"));
  try {
    await writeFile(join(dir, "AGENTS.md"), skill, { mode: 0o600 });
    // --ask-for-approval is a top-level codex flag (not exec-level); --add-dir
    // doesn't exist in codex exec — sandbox read-only already grants broad read.
    // The prompt body (message) carries the path of any repo we want inspected.
    const [bin, ...leadingArgs] = codexArgv;
    const args = [
      ...leadingArgs,
      "--ask-for-approval", "never",
      "exec",
      "--sandbox", "read-only",
      "--cd", dir,
      "--skip-git-repo-check",
      "--color", "never",
      "-c", "project_doc_max_bytes=262144",
      "-",
    ];
    return await spawnAndCollect(spawner, bin, args, message, timeoutMs);
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

function spawnAndCollect(spawner, cmd, args, stdin, timeoutMs) {
  return new Promise((resolveOut, rejectOut) => {
    const child = spawner(cmd, args, { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    child.stdin.on?.("error", () => {});
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
