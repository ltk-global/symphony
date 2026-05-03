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
import { readFile, stat, realpath } from "node:fs/promises";
import { resolve, dirname, join, sep } from "node:path";
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

  if (typeof parsed?.body !== "string") {
    return { source: null, fallback: true, reason: "parse_failed" };
  }

  // inputFiles + discoveryFiles are REQUIRED arrays per the skill contract.
  // Treat missing/wrong-type as parse_failed rather than silently defaulting
  // to [] (which would persist a degenerate inputHash that never invalidates
  // on lockfile changes).
  const m = parsed?.manifest ?? {};
  if (!Array.isArray(m.inputFiles) || !Array.isArray(m.discoveryFiles)) {
    return { source: null, fallback: true, reason: "parse_failed" };
  }
  const inputFiles = m.inputFiles;
  const discoveryFiles = m.discoveryFiles;
  // Reject unsafe paths up front: hashing reads from the supplied checkout,
  // so an LLM-emitted `../../../etc/passwd` would otherwise reach files
  // outside it before validateRecipe runs. Mirrors the validator's
  // isSafeRelativePath rule.
  if (!inputFiles.every(isSafeRelativePath) || !discoveryFiles.every(isSafeRelativePath)) {
    return { source: null, fallback: true, reason: "unsafe_manifest_path" };
  }
  const inputHash = await computeInputHash(repoCheckoutDir, inputFiles, discoveryFiles);

  const manifest = {
    schema: "symphony.recipe.v1",
    repoId: context.repoId,
    repoFullName: context.repoFullName,
    generatedBy: process.env.SYMPHONY_LLM_RUNNER || "claude-code",
    generatedAt: new Date().toISOString(),
    inputHash,
    inputFiles,
    discoveryFiles,
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
    recipe: parsed.body,
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

function isSafeRelativePath(p) {
  if (typeof p !== "string" || p.length === 0) return false;
  if (p.startsWith("/")) return false;
  return !p.split("/").some((seg) => seg === "..");
}

function extractJson(text) {
  const t = text.trim();
  const fenced = t.match(/^```(?:json)?\n([\s\S]*?)\n```\s*$/);
  if (fenced) return fenced[1];
  return t;
}

// LLM-declared inputs are inherently untrusted; cap to bound memory.
// Lockfiles are typically <100KB; 1MB per file × 64 files is generous.
const MAX_INPUT_BYTES = 1 * 1024 * 1024;
const MAX_INPUT_FILES = 64;

// MUST stay byte-identical to `src/workspace/recipes.ts:computeInputHash`.
// Drift between them silently invalidates every cached recipe. Parity is
// asserted by `test/recipe_input_hash_parity.test.ts`.
//
// inputFiles affect the recipe via content (read + hashed in sorted order).
// discoveryFiles affect it via presence only (presence/absence sentinel).
//
// Both arrays are gated by realpath()-confined-to-rootDir so a symlinked
// `package-lock.json -> /etc/passwd` can't escape the checkout. Files
// larger than MAX_INPUT_BYTES are hashed by size+mtime metadata instead of
// content, so an LLM emitting `inputFiles: ["huge.bin"]` can't DoS bootstrap.
export async function computeInputHash(rootDir, inputFiles, discoveryFiles = []) {
  const sortedInputs = [...inputFiles].sort().slice(0, MAX_INPUT_FILES);
  const sortedDiscovery = [...discoveryFiles].sort().slice(0, MAX_INPUT_FILES);
  const rootReal = await realpath(rootDir).catch(() => null);
  const insideRoot = async (rel) => {
    if (rootReal === null) return null;
    try {
      const p = await realpath(join(rootDir, rel));
      if (p === rootReal || p.startsWith(rootReal + sep)) return p;
    } catch {}
    return null;
  };
  const reads = await Promise.all(
    sortedInputs.map(async (rel) => {
      const safe = await insideRoot(rel);
      if (safe === null) return { rel, kind: "missing" };
      try {
        const st = await stat(safe);
        if (st.size > MAX_INPUT_BYTES) {
          // Don't load oversized files into memory; hash by metadata so
          // size/mtime changes still invalidate the cache.
          return { rel, kind: "meta", meta: `${st.size}\0${st.mtimeMs}` };
        }
        return { rel, kind: "buf", buf: await readFile(safe) };
      } catch {
        return { rel, kind: "missing" };
      }
    }),
  );
  const h = createHash("sha256");
  for (const item of reads) {
    if (item.kind === "buf") {
      h.update(item.rel + "\0");
      h.update(item.buf);
      h.update("\0");
    } else if (item.kind === "meta") {
      h.update(item.rel + "\0__meta__\0");
      h.update(item.meta);
      h.update("\0");
    } else {
      h.update(item.rel + "\0__missing__\0");
    }
  }
  // Discovery section — separate marker so the two streams don't blend if
  // the same path appears in both lists.
  h.update("\0discovery\0");
  for (const rel of sortedDiscovery) {
    const safe = await insideRoot(rel);
    if (safe === null) {
      h.update(rel + "\0__missing__\0");
      continue;
    }
    try {
      await stat(safe);
      h.update(rel + "\0__present__\0");
    } catch {
      h.update(rel + "\0__missing__\0");
    }
  }
  return `sha256:${h.digest("hex")}`;
}
