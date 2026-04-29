#!/usr/bin/env node
// Preflight a Symphony workflow: validate config, env, deps, and confirm
// GitHub Projects access by listing candidate items WITHOUT dispatching.
//
// Invoked by scripts/preflight.sh. Imports compiled dist/, so run setup first.

import { existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { execFileSync } from "node:child_process";
import { loadWorkflow } from "../dist/src/workflow/loader.js";
import { buildConfig } from "../dist/src/config/index.js";
import { GitHubProjectsTracker } from "../dist/src/tracker/github_projects.js";

const ANSI = { red: "\x1b[31m", green: "\x1b[32m", yellow: "\x1b[33m", bold: "\x1b[1m", reset: "\x1b[0m" };
const ok = (msg) => console.log(`${ANSI.green}✓${ANSI.reset} ${msg}`);
const warn = (msg) => console.log(`${ANSI.yellow}!${ANSI.reset} ${msg}`);
const fail = (msg) => console.error(`${ANSI.red}✗${ANSI.reset} ${msg}`);
const head = (msg) => console.log(`\n${ANSI.bold}== ${msg} ==${ANSI.reset}`);

let failures = 0;
let warnings = 0;
const recordFail = (msg) => { fail(msg); failures += 1; };
const recordWarn = (msg) => { warn(msg); warnings += 1; };

function onPath(bin) {
  try {
    execFileSync("which", [bin], { stdio: "ignore" });
    return true;
  } catch { return false; }
}

const workflowPath = resolve(process.argv[2]);
if (!existsSync(workflowPath)) {
  fail(`workflow not found: ${workflowPath}`);
  process.exit(1);
}

const ERROR_HINTS = {
  missing_github_token: "set GITHUB_TOKEN, or change tracker.api_token to a different env var",
  missing_iris_token: "set the env var named in iris.token_env (default IRIS_TOKEN), or set iris.enabled: false",
  missing_project_identification: "set tracker.project_url, OR both tracker.project_owner + tracker.project_number",
  unsupported_tracker_kind: "this fork only supports tracker.kind: github_projects",
  unsupported_agent_kind: "agent.kind must be 'claude_code' or 'codex'",
  workflow_parse_error: "front matter must start with '---' on its own line and end with '---'",
  workflow_front_matter_not_a_map: "front matter must be a YAML map (top-level key/value pairs)",
};

head("Workflow + config");
let config;
try {
  const workflow = await loadWorkflow(workflowPath);
  config = buildConfig(workflow.config, process.env, { baseDir: dirname(workflowPath) });
  ok(`parsed ${workflowPath}`);
  ok(`tracker.kind = ${config.tracker.kind}`);
  ok(`agent.kind   = ${config.agent.kind}`);
  ok(`iris.enabled = ${config.iris.enabled}`);
  ok(`workspace.root = ${config.workspace.root}`);
} catch (error) {
  const code = error instanceof Error ? error.message : String(error);
  recordFail(`config build failed: ${code}`);
  if (ERROR_HINTS[code]) console.error(`  hint: ${ERROR_HINTS[code]}`);
  console.error(`\n${ANSI.red}aborting — fix config errors and retry${ANSI.reset}`);
  process.exit(1);
}

head("Environment");
if (!process.env.GITHUB_TOKEN && !config.tracker.apiToken) {
  recordFail("GITHUB_TOKEN not set (tracker.api_token resolves from $GITHUB_TOKEN by default)");
} else {
  ok(`GITHUB_TOKEN present (${config.tracker.apiToken.length} chars)`);
}
if (config.iris.enabled) {
  if (!config.iris.token) recordFail(`iris.enabled is true but ${config.iris.tokenEnv} is not set`);
  else ok(`${config.iris.tokenEnv} present (${config.iris.token.length} chars)`);
} else {
  ok("iris disabled — no IRIS token required");
}

head("Tools on PATH");
const requiredAgent = config.agent.kind === "claude_code" ? config.claudeCode.command : (config.codex.command ?? "codex");
if (!onPath(requiredAgent)) recordFail(`agent CLI '${requiredAgent}' not found on PATH`);
else ok(`${requiredAgent} on PATH`);
if (!onPath("git")) recordFail("git not on PATH (workspace hooks need it)");
else ok("git on PATH");
if (!onPath("gh")) recordWarn("gh not on PATH — most workflows have the agent use it for PR/Status updates");
else ok("gh on PATH");

head("GitHub Projects round-trip");
try {
  const tracker = new GitHubProjectsTracker({
    endpoint: config.tracker.endpoint,
    apiToken: config.tracker.apiToken,
    projectUrl: config.tracker.projectUrl,
    projectOwner: config.tracker.projectOwner,
    projectNumber: config.tracker.projectNumber,
    statusField: config.tracker.statusField,
    priorityField: config.tracker.priorityField,
    activeStates: config.tracker.activeStates,
    terminalStates: config.tracker.terminalStates,
    filters: config.tracker.filters,
  });
  const candidates = await tracker.fetchCandidateIssues();
  ok(`project reachable; ${candidates.length} candidate(s) in ${JSON.stringify(config.tracker.activeStates)}`);
  for (const issue of candidates.slice(0, 5)) {
    console.log(`    - ${issue.identifier} [${issue.state}] ${issue.title}`);
  }
  if (candidates.length > 5) console.log(`    … and ${candidates.length - 5} more`);
} catch (error) {
  recordFail(`tracker fetch failed: ${error instanceof Error ? error.message : String(error)}`);
}

head("Result");
if (failures > 0) {
  fail(`${failures} blocking issue${failures === 1 ? "" : "s"}, ${warnings} warning${warnings === 1 ? "" : "s"}`);
  process.exit(1);
}
if (warnings > 0) warn(`0 blocking, ${warnings} warning${warnings === 1 ? "" : "s"} — review above`);
ok("preflight passed — daemon should be safe to start");
