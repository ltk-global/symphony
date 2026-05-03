// Spawns `claude --print` with the symphony-workflow-author skill as the system
// prompt addendum, hands it structured project context plus an optional brief,
// and returns the rendered WORKFLOW.md content. Validates the output through
// the same loadWorkflow + buildConfig pipeline the daemon uses; retries once
// with the validation error fed back if the first response is invalid.
//
// If claude isn't on PATH or the LLM round-trip fails twice, returns
// { source: null, fallback: true, reason } so the caller can fall back to the
// canned renderWorkflow() template.

import { readFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { runSkill, LlmUnavailableError } from "./llm-runner.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..", "..");
const SKILL_PATH = resolve(REPO_ROOT, "skills", "symphony-workflow-author", "SKILL.md");

export async function authorWorkflow({
  context,
  description = "",
  claudeCommand = "claude",
  spawnImpl,
  timeoutMs = 120_000,
} = {}) {
  const skill = await readFile(SKILL_PATH, "utf8");
  const baseMessage = buildUserMessage(context, description);

  let lastError = null;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const message = lastError ? appendValidationError(baseMessage, lastError) : baseMessage;
    let stdout;
    try {
      stdout = await runSkill({
        skill, message,
        runner: "auto",
        claudeCommand,
        spawnImpl,
        timeoutMs,
      });
    } catch (error) {
      if (error instanceof LlmUnavailableError) {
        return { source: null, fallback: true, reason: "claude_not_on_path" };
      }
      return { source: null, fallback: true, reason: `claude_invocation_failed:${error instanceof Error ? error.message : String(error)}` };
    }
    const cleaned = extractWorkflow(stdout);

    try {
      await validateWorkflow(cleaned, context);
      return { source: cleaned, fallback: false, attempts: attempt + 1 };
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
  }

  return { source: null, fallback: true, reason: `validation_failed_twice:${lastError}` };
}

function buildUserMessage(context, description) {
  const lines = [
    "Generate a single WORKFLOW.md for this Symphony project.",
    "",
    "Structured context:",
    "```json",
    JSON.stringify(context, null, 2),
    "```",
    "",
  ];
  if (description && description.trim()) {
    lines.push("## Brief");
    lines.push("");
    lines.push(description.trim());
    lines.push("");
  }
  lines.push("Output the WORKFLOW.md content directly — no surrounding prose or code fences.");
  return lines.join("\n");
}

function appendValidationError(baseMessage, error) {
  return `${baseMessage}\n\nNote: previousValidationError = ${JSON.stringify(error)}\nFix exactly that and regenerate.`;
}

function extractWorkflow(stdout) {
  const text = stdout.replace(/\r\n/g, "\n").trim();
  if (!text) return "";

  // Defensive: if the model wrapped the whole file in a code fence, peel it.
  const fenced = text.match(/^```(?:yaml|markdown|md)?\n([\s\S]*?)\n```\s*$/);
  if (fenced) {
    const inner = fenced[1]?.trim() ?? "";
    return inner.endsWith("\n") ? inner : `${inner}\n`;
  }

  // Defensive: if there's prose before the first '---', drop it.
  const fenceIdx = text.indexOf("---");
  const cleaned = fenceIdx > 0 ? text.slice(fenceIdx) : text;
  return cleaned.endsWith("\n") ? cleaned : `${cleaned}\n`;
}

async function validateWorkflow(source, context) {
  if (!source.startsWith("---")) {
    throw new Error("output did not start with YAML front matter fence '---'");
  }

  // Import from compiled dist — same parser the daemon will use.
  const { loadWorkflowFromString } = await import(`file://${resolve(REPO_ROOT, "dist/src/workflow/loader.js")}`);
  const { buildConfig } = await import(`file://${resolve(REPO_ROOT, "dist/src/config/index.js")}`);

  const wf = loadWorkflowFromString(source);
  const cfg = buildConfig(wf.config, {
    GITHUB_TOKEN: "_validation_only_",
    IRIS_TOKEN: "_validation_only_",
    HOME: "/tmp",
  });

  // Cross-check: every verify transition target must be in the project's actual statusOptions.
  if (cfg.verify && (cfg.verify.enabled === true || cfg.verify.enabled === undefined && Object.keys(cfg.verify).length > 1)) {
    const optionNames = new Set((context.statusOptions ?? []).map((o) => String(o.name).toLowerCase()));
    const targets = [
      ["on_pass.transition_to", cfg.verify.on_pass?.transition_to ?? cfg.verify.onPass?.transitionTo],
      ["on_fail.final_transition_to", cfg.verify.on_fail?.final_transition_to ?? cfg.verify.onFail?.finalTransitionTo],
      ["on_no_url.transition_to", cfg.verify.on_no_url?.transition_to ?? cfg.verify.onNoUrl?.transitionTo],
    ];
    for (const [path, value] of targets) {
      if (!value) continue;
      if (!optionNames.has(String(value).toLowerCase())) {
        throw new Error(`verify.${path} = "${value}" is not a Status option (have: ${[...optionNames].join(", ")})`);
      }
    }
  }

  return cfg;
}
