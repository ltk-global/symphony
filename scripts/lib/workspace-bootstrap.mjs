// scripts/lib/workspace-bootstrap.mjs
//
// LLM-authored workspace recipe bootstrap. The orchestrator calls
// `authorRecipe()` once per (repoId, inputs) cache miss; this module
// loads the symphony-workspace-bootstrap skill, hands it to the LLM
// runner together with the read-only repo checkout, parses the model's
// JSON, and reshapes it into a full RecipeManifest by filling in the
// persistence-level fields the validator requires (schema/repoId/
// repoFullName/generatedBy/generatedAt/inputHash) from server-side
// context. Returns either { source: "llm", fallback: false, recipe,
// manifest } or { source: null, fallback: true, reason } so the caller
// can fall back to a canned template without throwing.
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { runSkill, LlmUnavailableError } from "./llm-runner.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const SKILL_PATH = resolve(HERE, "..", "..", "skills", "symphony-workspace-bootstrap", "SKILL.md");

export async function authorRecipe({
  context,
  repoCheckoutDir,
  runSkillImpl,
  timeoutMs = 120_000,
} = {}) {
  let skillSource;
  try {
    skillSource = await readFile(SKILL_PATH, "utf8");
  } catch {
    return { source: null, fallback: true, reason: "skill_missing" };
  }

  const message = buildMessage(context, repoCheckoutDir);
  let stdout;
  try {
    stdout = await (runSkillImpl ?? runSkill)({
      skill: skillSource,
      message,
      readOnlyDir: repoCheckoutDir,
      runner: "auto",
      timeoutMs,
    });
  } catch (error) {
    if (error instanceof LlmUnavailableError) {
      return { source: null, fallback: true, reason: "no_llm" };
    }
    return {
      source: null,
      fallback: true,
      reason: `llm_failed:${error?.message ?? error}`,
    };
  }

  let parsed;
  try {
    parsed = JSON.parse(extractJson(stdout));
  } catch {
    return { source: null, fallback: true, reason: "parse_failed" };
  }

  const inputFiles = Array.isArray(parsed?.manifest?.inputFiles)
    ? parsed.manifest.inputFiles
    : [];
  const inputHash = await computeInputHash(repoCheckoutDir, inputFiles);

  const manifest = {
    schema: "symphony.recipe.v1",
    repoId: context.repoId,
    repoFullName: context.repoFullName,
    generatedBy: process.env.SYMPHONY_LLM_RUNNER || "claude-code",
    generatedAt: new Date().toISOString(),
    inputHash,
    inputFiles,
    discoveryFiles: parsed?.manifest?.discoveryFiles ?? [],
    cacheKeys: parsed?.manifest?.cacheKeys ?? [],
    lfs: !!parsed?.manifest?.lfs,
    submodules: !!parsed?.manifest?.submodules,
    notes: String(parsed?.manifest?.notes ?? ""),
    approvedBy: null,
    approvedAt: null,
  };

  return {
    source: "llm",
    fallback: false,
    recipe: String(parsed?.body ?? ""),
    manifest,
  };
}

function buildMessage(context, repoDir) {
  return [
    "Inspect the repo at this path and emit one JSON object per the SKILL.md contract.",
    "",
    "## Context",
    "```json",
    JSON.stringify(
      {
        repoFullName: context.repoFullName,
        repoId: context.repoId,
        repoCheckoutDir: repoDir,
      },
      null,
      2,
    ),
    "```",
    "",
    "Output the JSON directly — no surrounding prose, no code fences.",
  ].join("\n");
}

function extractJson(text) {
  const t = text.trim();
  const fenced = t.match(/^```(?:json)?\n([\s\S]*?)\n```\s*$/);
  if (fenced) return fenced[1];
  return t;
}

export async function computeInputHash(rootDir, files) {
  const h = createHash("sha256");
  for (const rel of [...files].sort()) {
    const p = join(rootDir, rel);
    if (existsSync(p)) {
      const buf = await readFile(p);
      h.update(rel + "\0");
      h.update(buf);
      h.update("\0");
    } else {
      h.update(rel + "\0__missing__\0");
    }
  }
  return `sha256:${h.digest("hex")}`;
}
