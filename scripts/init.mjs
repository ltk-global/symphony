#!/usr/bin/env node
// Interactive setup wizard. Walks an operator from a fresh clone to a
// running daemon in one session: detect agent CLI, validate GitHub auth,
// pick a Project, confirm Status field, write WORKFLOW.md, run preflight,
// optionally start the daemon. Read by humans first, code second — keep
// prompts short and unambiguous.

import { existsSync, writeFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { authorWorkflow } from "./lib/workflow-author.mjs";
import { runProjectChecks, formatChecks, checksFailed } from "./lib/project-checks.mjs";
import { resolve, dirname } from "node:path";
import { execFileSync, spawn } from "node:child_process";
import { createInterface } from "node:readline";

const C = {
  reset: "\x1b[0m", bold: "\x1b[1m", dim: "\x1b[2m",
  red: "\x1b[31m", green: "\x1b[32m", yellow: "\x1b[33m", blue: "\x1b[34m", cyan: "\x1b[36m",
};
const out = (s = "") => process.stdout.write(s + "\n");
const head = (s) => out(`\n${C.bold}${C.cyan}── ${s}${C.reset}`);
const ok = (s) => out(`  ${C.green}✓${C.reset} ${s}`);
const warn = (s) => out(`  ${C.yellow}!${C.reset} ${s}`);
const fail = (s) => out(`  ${C.red}✗${C.reset} ${s}`);
const info = (s) => out(`  ${C.dim}${s}${C.reset}`);

const repoRoot = resolve(dirname(new URL(import.meta.url).pathname), "..");

const rl = createInterface({ input: process.stdin, output: process.stdout });

function ask(question, { default: def, hidden = false, validate } = {}) {
  return new Promise((resolveInput) => {
    const prompt = def !== undefined ? `${question} ${C.dim}[${def}]${C.reset}: ` : `${question}: `;
    if (!hidden) {
      rl.question(prompt, (answer) => resolveInput(answer.trim() || def || ""));
      return;
    }
    process.stdout.write(prompt);
    const stdin = process.stdin;
    const wasRaw = stdin.isRaw ?? false;
    stdin.setRawMode?.(true);
    let buf = "";
    const onData = (chunk) => {
      const s = chunk.toString();
      for (const ch of s) {
        if (ch === "\n" || ch === "\r") {
          stdin.removeListener("data", onData);
          stdin.setRawMode?.(wasRaw);
          process.stdout.write("\n");
          resolveInput(buf);
          return;
        }
        if (ch === "") { process.exit(130); }
        if (ch === "") { buf = buf.slice(0, -1); continue; }
        buf += ch;
      }
    };
    stdin.on("data", onData);
  }).then(async (raw) => {
    if (validate) {
      const error = await validate(raw);
      if (error) {
        fail(error);
        return ask(question, { default: def, hidden, validate });
      }
    }
    return raw;
  });
}

async function askYesNo(question, def = true) {
  const hint = def ? "Y/n" : "y/N";
  const answer = (await ask(`${question} (${hint})`)).toLowerCase();
  if (!answer) return def;
  return answer.startsWith("y");
}

function onPath(bin) {
  try { execFileSync("which", [bin], { stdio: "ignore" }); return true; }
  catch { return false; }
}

function exit(code) { rl.close(); process.exit(code); }

async function main() {
  out(`${C.bold}${C.cyan}symphony init${C.reset} — interactive setup`);
  info("Walks you from a fresh clone to a running daemon. ~3 minutes.");
  info("Ctrl-C to abort. Nothing is written until the final step.");

  // ── 1. Host check ──────────────────────────────────────
  head("Host");
  const nodeMajor = parseInt(process.versions.node.split(".")[0], 10);
  if (nodeMajor < 22) { fail(`Node ${process.versions.node} is too old; need 22+.`); exit(1); }
  ok(`node ${process.versions.node}`);
  if (!onPath("git")) { fail("git is not on PATH — install it before continuing."); exit(1); }
  ok("git on PATH");
  if (!existsSync(resolve(repoRoot, "dist", "src", "cli.js"))) {
    fail("dist/ not built. Run ./scripts/setup.sh first.");
    exit(1);
  }
  ok("symphony built (dist/ present)");

  // ── 2. Pick agent ──────────────────────────────────────
  head("Coding agent");
  const hasClaude = onPath("claude");
  const hasCodex = onPath("codex");
  let agentKind;
  if (hasClaude && hasCodex) {
    info("Both 'claude' and 'codex' are on PATH.");
    const pick = await ask("Use which? [claude/codex]", { default: "claude", validate: (v) => (["claude", "codex"].includes(v) ? null : "Pick 'claude' or 'codex'.") });
    agentKind = pick === "codex" ? "codex" : "claude_code";
  } else if (hasClaude) {
    agentKind = "claude_code";
    ok("found claude on PATH");
  } else if (hasCodex) {
    agentKind = "codex";
    ok("found codex on PATH");
  } else {
    fail("Neither 'claude' nor 'codex' found on PATH.");
    info("Install one and re-run:");
    info("  claude:  npm install -g @anthropic-ai/claude-code");
    info("  codex:   npm install -g @openai/codex   OR   brew install --cask codex");
    exit(1);
  }

  // ── 3. GitHub auth ──────────────────────────────────────
  head("GitHub authentication");
  let token = process.env.GITHUB_TOKEN ?? "";
  if (token) {
    ok(`GITHUB_TOKEN already set (${token.length} chars)`);
  } else {
    info("GITHUB_TOKEN env var is not set. Paste one now to validate (input hidden).");
    info("Token needs scopes: repo, project. Generate at github.com/settings/tokens.");
    token = await ask("Token", { hidden: true, validate: (v) => (v.length < 20 ? "That looks too short for a PAT." : null) });
  }

  let viewerLogin;
  try {
    const viewer = await graphql(token, `query { viewer { login } }`);
    viewerLogin = viewer.viewer?.login;
    if (!viewerLogin) throw new Error("no viewer login in response");
    ok(`authenticated as ${C.bold}${viewerLogin}${C.reset}`);
  } catch (error) {
    fail(`token validation failed: ${error instanceof Error ? error.message : error}`);
    info("Common causes: scopes missing, token expired, fine-grained PAT lacks Projects access.");
    exit(1);
  }

  // ── 4. Pick a Project ──────────────────────────────────
  head("GitHub Project (v2)");
  let project = await pickProject(token, viewerLogin);
  if (!project) {
    info("No Project picked. Create one at github.com/orgs/<org>/projects/new and re-run init.");
    exit(1);
  }
  ok(`${project.title} · ${project.url}`);

  // ── 5. Confirm Status field ────────────────────────────
  head("Status field");
  let statusOptions;
  try {
    statusOptions = await fetchStatusOptions(token, project.id);
  } catch (error) {
    fail(`couldn't read Status field on this project: ${error instanceof Error ? error.message : error}`);
    info("Make sure the project has a single-select 'Status' field.");
    exit(1);
  }
  if (statusOptions.length === 0) {
    fail("Status field has no options.");
    info("Add at least Todo, In Progress, Done, Needs Human in the GitHub UI and re-run.");
    exit(1);
  }
  info(`Available Status values: ${statusOptions.map((o) => `'${o.name}'`).join(", ")}`);

  const hasNeedsHuman = statusOptions.some((o) => /needs human|blocked/i.test(o.name));
  if (!hasNeedsHuman) {
    statusOptions = await maybeAddNeedsHumanOption(token, project.id, statusOptions, "Needs Human");
  }

  const defaultActive = statusOptions.filter((o) => /todo|in progress|review feedback/i.test(o.name)).map((o) => o.name);
  const defaultTerminal = statusOptions.filter((o) => /done|cancelled|won't do/i.test(o.name)).map((o) => o.name);
  const needsHumanGuess = statusOptions.find((o) => /needs human|blocked/i.test(o.name))?.name ?? statusOptions[0].name;

  const activeStates = parseList(await ask(
    "Active states (comma-separated — Symphony dispatches items in these)",
    { default: defaultActive.join(", ") || "Todo, In Progress" },
  ));
  const terminalStates = parseList(await ask(
    "Terminal states (Symphony cleans up workspaces here)",
    { default: defaultTerminal.join(", ") || "Done, Cancelled" },
  ));
  const needsHumanState = (await ask(
    "Needs-human state (where IRIS-blocked items go)",
    { default: needsHumanGuess },
  )).trim();

  validateAgainstOptions("active_states", activeStates, statusOptions);
  validateAgainstOptions("terminal_states", terminalStates, statusOptions);
  validateAgainstOptions("needs_human_state", [needsHumanState], statusOptions);

  // ── 6. Filtering ──────────────────────────────────────
  head("Filters");
  info("Strongly recommended: only dispatch issues assigned to a bot user.");
  const assignee = (await ask(`Assignee filter (leave blank to dispatch all in active_states)`)).trim();
  if (assignee) ok(`only items assigned to ${assignee}`);
  else warn("no assignee filter — Symphony will pick up every item in active_states");

  // ── 6b. Project-state checks ──────────────────────────
  head("Project-state checks");
  info("Probing the project + linked repos so misconfigurations surface BEFORE the daemon starts.");
  const checks = await runProjectChecks({ token, project, assignee: assignee || null, activeStates });
  out(formatChecks(checks, { reset: C.reset, green: C.green, yellow: C.yellow, red: C.red, dim: C.dim }));
  if (checksFailed(checks)) {
    warn("Some checks failed. You can continue, but the daemon will likely hit these issues at runtime.");
    const proceed = await askYesNo("Continue anyway?", false);
    if (!proceed) { warn("Aborted — fix the failures and re-run init."); exit(1); }
  }

  // ── 7. IRIS + verify URL strategy ──────────────────────
  head("Browser verify (IRIS)");
  info("IRIS drives a real Chrome via Swarmy so the agent's change can be verified live.");
  info("Get a token at https://swarmy.firsttofly.com/settings → API Tokens (starts 'swm_').");
  info("Profiles dashboard:  https://swarmy.firsttofly.com/profiles");

  const enableIris = await askYesNo("Enable IRIS now?", false);
  let irisProfile = "claude-default-latest";
  let irisToken = process.env.IRIS_TOKEN ?? "";
  let verify = { mode: "agent_output", url: "" };  // default: dynamic
  let tunnelScript = null;

  if (enableIris) {
    if (irisToken) {
      ok(`IRIS_TOKEN already set (${irisToken.length} chars)`);
    } else {
      irisToken = await ask("IRIS token", { hidden: true, validate: (v) => {
        if (v.length < 10) return "That looks too short for a Swarmy token.";
        if (!v.startsWith("swm_")) return "Expected token to start with 'swm_' (Settings → API Tokens).";
        return null;
      } });
      ok(`token captured (${irisToken.length} chars)`);
    }
    irisProfile = (await ask("Default IRIS profile", { default: "claude-default-latest" })).trim();
    info("Per-user concurrent quota is 3 containers; rate is per-task, not per-minute.");

    head("Verify URL");
    info("IRIS needs a real URL its Chrome can reach. Pick a strategy:");
    info(`  ${C.bold}[d]${C.reset} dynamic — agent emits {"verify_url": "..."} JSON in its last message`);
    info(`  ${C.bold}[s]${C.reset} static  — fixed URL (deployed app, GitHub Pages, etc.)`);
    info(`  ${C.bold}[n]${C.reset} ngrok tunnel to localhost (uses your free *.ngrok-free.app static domain or a paid one)`);
    info(`  ${C.bold}[c]${C.reset} cloudflared tunnel to localhost (quick / random URL, or named / fixed)`);
    const strategy = (await ask("Strategy", { default: "d" })).trim().toLowerCase();

    if (strategy === "s" || strategy === "static") {
      const url = (await ask("Static URL (https://...)", { validate: (v) => /^https?:\/\/.+/.test(v) ? null : "Must be a full http(s) URL." })).trim();
      verify = { mode: "static", url };
    } else if (strategy === "n" || strategy === "ngrok") {
      const result = await setupNgrok(workflowSlug(project));
      if (result?.script) tunnelScript = result.script;
      if (result?.url) verify = { mode: "static", url: result.url };
      else verify = { mode: "agent_output", url: "" };  // random URL → defer to agent
    } else if (strategy === "c" || strategy === "cloudflared") {
      const result = await setupCloudflared(workflowSlug(project));
      if (result?.script) tunnelScript = result.script;
      if (result?.url) verify = { mode: "static", url: result.url };
      else verify = { mode: "agent_output", url: "" };  // quick tunnel random URL
    } else {
      verify = { mode: "agent_output", url: "" };
      ok("agent will emit verify_url in its final JSON line");
    }
  }

  // ── 7b. Verify transition targets (only when IRIS is on) ──
  let verifyTransitions = null;
  if (enableIris) {
    head("Verify transition targets");
    info("Symphony moves items to these Status values when verify completes. Each MUST exist on the Status field.");
    info(`Available: ${statusOptions.map((o) => `'${o.name}'`).join(", ")}`);
    const validateOption = (value) => {
      const trimmed = value.trim();
      if (!trimmed) return "required";
      if (statusOptions.some((o) => o.name.toLowerCase() === trimmed.toLowerCase())) return null;
      return `Not a Status option. Pick one of: ${statusOptions.map((o) => o.name).join(", ")}`;
    };
    const reviewGuess =
      statusOptions.find((o) => /review/i.test(o.name))?.name ??
      terminalStates[0] ??
      needsHumanState;
    const onPass = (await ask("On verify pass, transition to", { default: reviewGuess, validate: validateOption })).trim();
    const onFailFinal = (await ask("On verify fail (after retries), transition to", { default: needsHumanState, validate: validateOption })).trim();
    const onNoUrl = (await ask("On verify finding no URL, transition to", { default: needsHumanState, validate: validateOption })).trim();
    verifyTransitions = { onPass, onFailFinal, onNoUrl };
    ok(`pass→${onPass}  fail→${onFailFinal}  no-url→${onNoUrl}`);
  }

  // ── 8. Operator console ───────────────────────────────
  head("Operator console");
  const enableConsole = await askYesNo("Enable the dashboard at 127.0.0.1:8787?", true);
  let port = 8787;
  if (enableConsole) {
    const portStr = await ask("Port", { default: "8787", validate: (v) => (/^\d+$/.test(v) && +v > 0 && +v < 65536 ? null : "Must be a port number 1-65535.") });
    port = parseInt(portStr, 10);
  }

  // ── 9. Workspace ───────────────────────────────────────
  head("Workspace");
  const defaultWorkspaceRoot = `~/symphony_workspaces/${slug(project.title)}`;
  const workspaceRoot = (await ask("Workspace root (where issue repos get cloned)", { default: defaultWorkspaceRoot })).trim();

  // ── 9a. Slack notifications ────────────────────────────
  head("Notifications");
  info("Symphony can fire bash hooks on selected event types — Slack/PagerDuty/anything you can curl.");
  let slack = null;
  const enableSlack = await askYesNo("Send Slack messages on critical events?", false);
  if (enableSlack) {
    info("Get the webhook URL from your Slack app's Incoming Webhooks page. Starts with https://hooks.slack.com/.");
    const webhookUrl = await ask("Slack webhook URL", { hidden: true, validate: (v) => {
      if (!v.startsWith("https://hooks.slack.com/")) return "Expected https://hooks.slack.com/...";
      return null;
    } });
    info("Default events: dispatch_failed, iris_blocked_handed_off, verify_terminal_failed.");
    info("Type 'all' to fire on every event type, or comma-separated names.");
    const eventsRaw = (await ask("Events", { default: "dispatch_failed, iris_blocked_handed_off, verify_terminal_failed" })).trim();
    const events = eventsRaw.toLowerCase() === "all" ? ["*"] : parseList(eventsRaw);

    // Webhook URL goes to a per-workflow secret env file (chmod 600), NEVER to WORKFLOW.md.
    const slug = workflowSlug(project);
    const secretEnvFile = resolve(repoRoot, "scripts", `.${slug}-secrets.env`);
    writeFileSync(secretEnvFile, `# Auto-generated by scripts/init.mjs — do not commit.\nexport SLACK_WEBHOOK_URL=${JSON.stringify(webhookUrl)}\n`, { mode: 0o600 });
    ok(`secret webhook URL written to ${secretEnvFile} (mode 600)`);
    slack = { events, secretEnvFile };
  }

  // ── 9b. Customization brief (LLM-driven body) ──────────
  head("Workflow style");
  info("Symphony hands the LLM (claude --print) a structured config + your brief, gets back");
  info("a tailored WORKFLOW.md. Keep blank for the default status-driven workflow.");
  info("Examples:");
  info(`  · ${C.dim}'Comment on the issue at start and PR-open instead of changing Status.'${C.reset}`);
  info(`  · ${C.dim}'Use pnpm test and pnpm lint; deploy to Vercel preview before verify.'${C.reset}`);
  info(`  · ${C.dim}'When IRIS blocks, also assign a human reviewer (gh issue edit --add-assignee).'${C.reset}`);
  const brief = (await ask("Brief (blank = default status-driven)")).trim();

  // ── 10. Write WORKFLOW.md ─────────────────────────────
  head("Writing WORKFLOW.md");
  const workflowPath = resolve((await ask("Path for the workflow file", { default: "./WORKFLOW.md" })).trim());
  if (existsSync(workflowPath)) {
    const overwrite = await askYesNo(`${workflowPath} exists. Overwrite?`, false);
    if (!overwrite) { warn("Aborted."); exit(0); }
  }

  const authorContext = {
    project: { title: project.title, url: project.url, owner: project.owner ?? null },
    statusOptions: statusOptions.map((o) => ({ id: o.id, name: o.name })),
    activeStates,
    terminalStates,
    needsHumanState,
    assignee: assignee || null,
    agentKind,
    enableIris,
    irisProfile,
    verify,
    verifyTransitions,
    enableConsole,
    port,
    workspaceRoot,
    slack,
  };

  let workflowSource;
  info("invoking claude with the symphony-workflow-author skill...");
  const result = await authorWorkflow({ context: authorContext, description: brief });
  if (result.source) {
    ok(`workflow authored by claude (${result.attempts} attempt${result.attempts === 1 ? "" : "s"})`);
    workflowSource = result.source;
  } else {
    warn(`falling back to canned template — ${result.reason}`);
    info("To use the LLM-driven path, install claude: npm install -g @anthropic-ai/claude-code");
    workflowSource = renderWorkflow({
      project,
      activeStates,
      terminalStates,
      needsHumanState,
      assignee: assignee || null,
      agentKind,
      enableIris,
      irisProfile,
      enableConsole,
      port,
      workspaceRoot,
      verify,
      verifyTransitions,
    });
  }
  await writeFile(workflowPath, workflowSource, "utf8");
  ok(`wrote ${workflowPath}`);

  // ── 11. Preflight ─────────────────────────────────────
  head("Preflight");
  if (!process.env.GITHUB_TOKEN) {
    info("GITHUB_TOKEN was pasted in this session — exporting it for the preflight subprocess.");
  }
  if (enableIris && !process.env.IRIS_TOKEN && irisToken) {
    info("IRIS_TOKEN captured this session — exported for the preflight subprocess.");
  }
  const preflightEnv = { ...process.env, GITHUB_TOKEN: token };
  if (enableIris && irisToken) preflightEnv.IRIS_TOKEN = irisToken;
  const preflightExit = await runStreamed(
    "node",
    [resolve(repoRoot, "scripts", "preflight.mjs"), workflowPath],
    { env: preflightEnv, cwd: repoRoot },
  );
  if (preflightExit !== 0) {
    fail("preflight reported issues — fix them and re-run init or call ./scripts/preflight.sh directly.");
    exit(1);
  }

  // ── 12. Wrap up ───────────────────────────────────────
  head("All set");
  ok("Configuration written and validated.");

  if (tunnelScript) {
    out(`\n  ${C.bold}${C.yellow}Tunnel:${C.reset} run this in a separate terminal BEFORE starting the daemon`);
    out(`    ${C.bold}bash ${tunnelScript.path}${C.reset}`);
    if (tunnelScript.url) out(`    Public URL: ${C.cyan}${tunnelScript.url}${C.reset}`);
    else out(`    Public URL: random — copy from the tunnel terminal once it prints`);
  }

  if (!process.env.GITHUB_TOKEN || (enableIris && !process.env.IRIS_TOKEN && irisToken)) {
    out(`\n  ${C.yellow}Before running the daemon, export your tokens:${C.reset}`);
    if (!process.env.GITHUB_TOKEN) out(`    ${C.bold}export GITHUB_TOKEN=${C.dim}<your github token>${C.reset}`);
    if (enableIris && !process.env.IRIS_TOKEN && irisToken) out(`    ${C.bold}export IRIS_TOKEN=${C.dim}<your IRIS token>${C.reset}`);
  }
  out(`\n  ${C.bold}Run the daemon:${C.reset}`);
  out(`    node dist/src/cli.js --workflow ${C.dim}${workflowPath}${C.reset}${enableConsole ? ` --port ${port}` : ""}`);
  if (enableConsole) out(`  Then visit  ${C.cyan}http://127.0.0.1:${port}/${C.reset}`);

  const startNow = await askYesNo("Start the daemon now?", true);
  if (!startNow) exit(0);
  rl.close();
  const args = [resolve(repoRoot, "dist", "src", "cli.js"), "--workflow", workflowPath];
  if (enableConsole) args.push("--port", String(port));
  const child = spawn("node", args, { env: preflightEnv, stdio: "inherit" });
  child.on("exit", (code) => process.exit(code ?? 0));
}

// ── helpers ──────────────────────────────────────────────

async function pickProject(token, viewerLogin) {
  while (true) {
    const resp = await graphql(token, `
      query {
        viewer {
          id
          projectsV2(first: 50) {
            nodes { id, number, title, url, owner {
              __typename
              ... on User { login }
              ... on Organization { login }
            } }
          }
        }
      }
    `);
    const projects = resp.viewer?.projectsV2?.nodes ?? [];
    const viewerId = resp.viewer?.id;

    if (projects.length === 0) {
      warn(`No Projects (v2) found for ${viewerLogin}.`);
      info("Options:");
      info(`  ${C.bold}[c]${C.reset} create a new Project under ${viewerLogin}`);
      info(`  ${C.bold}[u]${C.reset} paste a project URL (e.g. an org-owned project)`);
      info(`  ${C.bold}[q]${C.reset} quit`);
      const choice = (await ask("Pick", { default: "c" })).trim().toLowerCase();
      if (choice === "q") return null;
      if (choice === "u") {
        const url = (await ask("Project URL")).trim();
        const project = await resolveProjectByUrl(token, url);
        if (project) return project;
        warn("Could not resolve that URL — try again.");
        continue;
      }
      if (choice === "c" || choice === "") {
        const created = await createProject(token, viewerId, viewerLogin);
        if (created) return created;
        continue;
      }
      warn("That wasn't an option.");
      continue;
    }

    out("");
    projects.forEach((p, i) => {
      const owner = p.owner?.login ?? "?";
      info(`  ${C.bold}[${i + 1}]${C.reset} ${owner}/${p.number}  ${p.title}`);
    });
    info(`  ${C.bold}[c]${C.reset} create a new Project under ${viewerLogin}`);
    info(`  ${C.bold}[u]${C.reset} paste a project URL`);
    info(`  ${C.bold}[q]${C.reset} quit`);
    const choice = (await ask("Pick", { default: "1" })).trim().toLowerCase();
    if (choice === "q") return null;
    if (choice === "c") {
      const created = await createProject(token, viewerId, viewerLogin);
      if (created) return created;
      continue;
    }
    if (choice === "u") {
      const url = (await ask("Project URL")).trim();
      const project = await resolveProjectByUrl(token, url);
      if (project) return project;
      warn("Could not resolve that URL — try again.");
      continue;
    }
    const idx = parseInt(choice, 10) - 1;
    if (Number.isInteger(idx) && projects[idx]) return projects[idx];
    warn("That wasn't an option.");
  }
}

async function createProject(token, ownerId, ownerLogin) {
  if (!ownerId) {
    warn("Couldn't resolve your user ID. Create a project in the GitHub UI and re-run.");
    return null;
  }
  const title = (await ask("Project title", { default: "Symphony Bot Queue" })).trim();
  if (!title) return null;
  try {
    const data = await graphql(token, `
      mutation($ownerId: ID!, $title: String!) {
        createProjectV2(input: { ownerId: $ownerId, title: $title }) {
          projectV2 { id, number, title, url, owner {
            __typename
            ... on User { login }
            ... on Organization { login }
          } }
        }
      }
    `, { ownerId, title });
    const project = data.createProjectV2?.projectV2;
    if (!project) throw new Error("no project in response");
    ok(`created ${project.title} at ${project.url}`);
    info(`Owner: ${project.owner?.login ?? ownerLogin} · Number: #${project.number}`);
    return project;
  } catch (error) {
    fail(`couldn't create project: ${error instanceof Error ? error.message : error}`);
    info("Likely cause: token missing 'project' scope, or the owner is an org you can't admin.");
    return null;
  }
}

async function setupNgrok(slug) {
  if (!onPath("ngrok")) {
    warn("ngrok not on PATH.");
    info("Install: https://ngrok.com/download (or `brew install ngrok`).");
    info("Then: `ngrok config add-authtoken <token>` once.");
    return null;
  }
  ok("found ngrok on PATH");
  const port = (await ask("Local port to tunnel", { default: "3000", validate: (v) => /^\d+$/.test(v) ? null : "Must be a port number." })).trim();
  info("Free ngrok accounts get one fixed *.ngrok-free.app domain — claim at dashboard.ngrok.com.");
  const domain = (await ask("Fixed domain (e.g. ken-luong.ngrok-free.app), or blank for random per-session URL")).trim();
  const command = domain ? `ngrok http --domain=${domain} ${port}` : `ngrok http ${port}`;
  const url = domain ? `https://${domain}` : null;
  const script = generateTunnelScript({
    slug,
    kind: "ngrok",
    port,
    command,
    url,
    notes: domain
      ? null
      : "Random URL — copy the https://*.ngrok-free.app printed below into WORKFLOW.md or use 'agent_output' mode.",
  });
  if (url) ok(`tunnel URL will be ${url}`);
  return { script, url };
}

async function setupCloudflared(slug) {
  if (!onPath("cloudflared")) {
    warn("cloudflared not on PATH.");
    info("Install: `brew install cloudflared` (macOS), or see https://github.com/cloudflare/cloudflared.");
    return null;
  }
  ok("found cloudflared on PATH");
  info("Quick tunnels: random *.trycloudflare.com URL, no auth, no SSE on the tunneled app.");
  info("Named tunnels:  stable URL with your own domain, requires `cloudflared tunnel login` once.");
  const kind = (await ask("Tunnel type [q]uick or [n]amed", { default: "q" })).trim().toLowerCase();
  const port = (await ask("Local port to tunnel", { default: "3000", validate: (v) => /^\d+$/.test(v) ? null : "Must be a port number." })).trim();

  if (kind === "n" || kind === "named") {
    const tunnelName = (await ask("Tunnel name (must already be created via `cloudflared tunnel create <name>`)", { default: "symphony-verify" })).trim();
    const hostname = (await ask("Hostname routed to this tunnel (e.g. verify.example.com)", { validate: (v) => /^[A-Za-z0-9.-]+$/.test(v) ? null : "Looks malformed." })).trim();
    if (!hostname) return null;
    const command = `cloudflared tunnel run ${tunnelName}`;
    const url = `https://${hostname}`;
    const script = generateTunnelScript({ slug, kind: "cloudflared-named", port, command, url, notes: null });
    ok(`tunnel URL will be ${url}`);
    return { script, url };
  }

  const command = `cloudflared tunnel --url http://localhost:${port}`;
  const script = generateTunnelScript({
    slug,
    kind: "cloudflared-quick",
    port,
    command,
    url: null,
    notes: "Quick tunnel URL is random — printed in the tunnel terminal. Use 'agent_output' verify mode and have the agent emit it.",
  });
  return { script, url: null };
}

function generateTunnelScript({ slug, kind, port, command, url, notes }) {
  const path = resolve(repoRoot, "scripts", `tunnel-${slug}.sh`);
  const lines = [
    "#!/usr/bin/env bash",
    `# Tunnel helper for Symphony · workflow slug: ${slug}`,
    "# Auto-generated by scripts/init.mjs.",
    "#",
    "# Run this in a separate terminal BEFORE starting the symphony daemon.",
    "# IRIS will navigate to the URL this tunnel exposes for browser verification.",
    "",
    "set -euo pipefail",
    "",
    `# Provider: ${kind}`,
    `# Local port: ${port}`,
    url ? `# Public URL: ${url}` : "# Public URL: random — printed below when tunnel comes up",
    notes ? `# Note: ${notes}` : "",
    "",
    `exec ${command}`,
    "",
  ].filter((line) => line !== "" || true);
  writeFileSync(path, lines.join("\n"), { mode: 0o755 });
  ok(`wrote tunnel helper: ${path}`);
  return { path, kind, port, command, url };
}

function workflowSlug(project) {
  return slug(project?.title ?? "default");
}

async function maybeAddNeedsHumanOption(token, projectId, options, desiredName) {
  const lc = desiredName.toLowerCase();
  if (options.some((o) => o.name.toLowerCase() === lc)) return options;

  warn(`'${desiredName}' is not a current Status option on this project.`);
  info(`If you don't add it, IRIS-blocked items will not have a clear destination.`);
  const confirm = await askYesNo(`Add '${desiredName}' to the Status field now?`, true);
  if (!confirm) {
    info("OK — add it manually in the GitHub UI under Project → Settings → Status field.");
    return options;
  }

  try {
    const fieldData = await graphql(token, `
      query($id: ID!) {
        node(id: $id) {
          ... on ProjectV2 {
            field(name: "Status") {
              ... on ProjectV2SingleSelectField { id, options { id, name, color, description } }
            }
          }
        }
      }
    `, { id: projectId });
    const fieldId = fieldData.node?.field?.id;
    const existing = fieldData.node?.field?.options ?? [];
    if (!fieldId) throw new Error("Status field not found");

    const merged = [
      ...existing.map((o) => ({ name: o.name, color: o.color ?? "GRAY", description: o.description ?? "" })),
      { name: desiredName, color: "ORANGE", description: "Symphony parks IRIS-blocked items here for human resolution." },
    ];

    const updated = await graphql(token, `
      mutation($fieldId: ID!, $options: [ProjectV2SingleSelectFieldOptionInput!]!) {
        updateProjectV2Field(input: { fieldId: $fieldId, singleSelectOptions: $options }) {
          projectV2Field {
            ... on ProjectV2SingleSelectField { options { id, name } }
          }
        }
      }
    `, { fieldId, options: merged });
    const newOptions = updated.updateProjectV2Field?.projectV2Field?.options ?? [];
    ok(`added '${desiredName}' — current options: ${newOptions.map((o) => o.name).join(", ")}`);
    return newOptions;
  } catch (error) {
    fail(`couldn't update field: ${error instanceof Error ? error.message : error}`);
    info("You can add the option manually in Project → Settings → Status field.");
    return options;
  }
}

async function resolveProjectByUrl(token, url) {
  const match = url.match(/github\.com\/(orgs|users)\/([^/]+)\/projects\/(\d+)/);
  if (!match) return null;
  const [, scope, owner, numStr] = match;
  const number = parseInt(numStr, 10);
  const isOrg = scope === "orgs";
  const data = await graphql(token, `
    query($owner: String!, $number: Int!) {
      ${isOrg ? "organization" : "user"}(login: $owner) {
        projectV2(number: $number) { id, number, title, url, owner {
          __typename
          ... on User { login }
          ... on Organization { login }
        } }
      }
    }
  `, { owner, number });
  return data[isOrg ? "organization" : "user"]?.projectV2 ?? null;
}

async function fetchStatusOptions(token, projectId) {
  const data = await graphql(token, `
    query($id: ID!) {
      node(id: $id) {
        ... on ProjectV2 {
          field(name: "Status") {
            ... on ProjectV2SingleSelectField { id, name, options { id, name } }
          }
        }
      }
    }
  `, { id: projectId });
  return data.node?.field?.options ?? [];
}

async function graphql(token, query, variables) {
  const response = await fetch("https://api.github.com/graphql", {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      "user-agent": "symphony-init/0.1",
    },
    body: JSON.stringify({ query, variables: variables ?? null }),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${(await response.text()).slice(0, 200)}`);
  const body = await response.json();
  if (body.errors?.length) throw new Error(body.errors.map((e) => e.message).join("; "));
  return body.data;
}

function parseList(value) {
  return value.split(",").map((s) => s.trim()).filter(Boolean);
}

function validateAgainstOptions(label, values, options) {
  const optionNames = new Set(options.map((o) => o.name.toLowerCase()));
  const missing = values.filter((v) => !optionNames.has(v.toLowerCase()));
  if (missing.length) warn(`${label}: ${missing.join(", ")} not on this Project's Status field — fix in the GitHub UI before running.`);
}

function slug(value) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 32) || "default";
}

function runStreamed(command, args, options) {
  return new Promise((resolveExit) => {
    const child = spawn(command, args, { stdio: "inherit", ...options });
    child.on("exit", (code) => resolveExit(code ?? 0));
    child.on("error", (error) => {
      fail(error instanceof Error ? error.message : String(error));
      resolveExit(1);
    });
  });
}

function renderWorkflow(opts) {
  const yaml = (value) => {
    if (typeof value !== "string") return JSON.stringify(value);
    if (/[:#&*?{}\[\],|>!%@`'"]/.test(value) || /^\s|\s$/.test(value) || value === "") return JSON.stringify(value);
    return value;
  };
  const list = (values) => `[${values.map((v) => yaml(v)).join(", ")}]`;

  const lines = [];
  lines.push("---");
  lines.push("tracker:");
  lines.push("  kind: github_projects");
  lines.push("  api_token: $GITHUB_TOKEN");
  lines.push(`  project_url: ${yaml(opts.project.url)}`);
  lines.push("  status_field: Status");
  lines.push(`  active_states: ${list(opts.activeStates)}`);
  lines.push(`  terminal_states: ${list(opts.terminalStates)}`);
  lines.push(`  needs_human_state: ${yaml(opts.needsHumanState)}`);
  if (opts.assignee) {
    lines.push("  filters:");
    lines.push(`    assignee: ${yaml(opts.assignee)}`);
    lines.push("    label_required: []");
    lines.push("    label_excluded: [wip, do-not-touch]");
  }
  lines.push("");
  lines.push("polling:");
  lines.push("  interval_ms: 30000");
  lines.push("");
  lines.push("workspace:");
  lines.push(`  root: ${yaml(opts.workspaceRoot)}`);
  lines.push("");
  lines.push("hooks:");
  lines.push("  after_create: |");
  lines.push("    set -euo pipefail");
  lines.push("    if [ -z \"${ISSUE_REPO_FULL_NAME:-}\" ]; then exit 0; fi");
  lines.push("    if [ -n \"${SYMPHONY_REPO_REF:-}\" ] && [ -d \"$SYMPHONY_REPO_REF\" ]; then");
  lines.push("      git clone --reference \"$SYMPHONY_REPO_REF\" \\");
  lines.push("        \"https://x-access-token:${GITHUB_TOKEN}@github.com/${ISSUE_REPO_FULL_NAME}.git\" . \\");
  lines.push("        || git clone \"https://x-access-token:${GITHUB_TOKEN}@github.com/${ISSUE_REPO_FULL_NAME}.git\" .");
  lines.push("    else");
  lines.push("      git clone \"https://x-access-token:${GITHUB_TOKEN}@github.com/${ISSUE_REPO_FULL_NAME}.git\" .");
  lines.push("    fi");
  lines.push("    git checkout -B \"${ISSUE_BRANCH_NAME:-symphony/${ISSUE_WORKSPACE_KEY}}\"");
  lines.push("");
  lines.push("agent:");
  lines.push(`  kind: ${opts.agentKind}`);
  lines.push("  max_concurrent_agents: 3");
  lines.push("  max_turns: 25");
  lines.push("");
  if (opts.agentKind === "claude_code") {
    lines.push("claude_code:");
    lines.push("  command: claude");
    lines.push("  permission_mode: acceptEdits");
    lines.push("  allowed_tools: [Bash, Read, Edit, Write, Glob, Grep, WebFetch]");
    lines.push("  append_system_prompt: |");
    lines.push("    You are running unattended inside Symphony. Update the GitHub Project");
    lines.push("    item's Status via gh CLI when you start working (Todo -> In Progress)");
    lines.push("    and again when you've shipped a PR.");
    lines.push("    When you're done and need browser verification, print the marker line");
    lines.push("    VERIFY_REQUESTED followed by JSON {\"verify_url\": \"<preview-url>\"}.");
    lines.push("");
  }
  lines.push("iris:");
  lines.push(`  enabled: ${opts.enableIris}`);
  if (opts.enableIris) {
    lines.push("  base_url: https://swarmy.firsttofly.com");
    lines.push("  token_env: IRIS_TOKEN");
    lines.push(`  default_profile: ${yaml(opts.irisProfile)}`);
    lines.push("  max_concurrent: 3");
    lines.push("  on_blocked: needs_human");
    lines.push("");
    lines.push("verify:");
    lines.push("  enabled: true");
    lines.push("  trigger: after_agent_signal");
    lines.push("  signal_marker: VERIFY_REQUESTED");
    const verifyMode = opts.verify?.mode ?? "agent_output";
    const verifyUrl = opts.verify?.url ?? "";
    if (verifyMode === "static" && verifyUrl) {
      // Try agent first (lets the agent override per turn), fall back to the static tunnel/deploy URL.
      lines.push("  url_source: [agent_output, static]");
      lines.push("  agent_output_key: verify_url");
      lines.push(`  url_static: ${yaml(verifyUrl)}`);
    } else {
      lines.push("  url_source: agent_output");
      lines.push("  agent_output_key: verify_url");
    }
    const t = opts.verifyTransitions ?? { onPass: "In Review", onFailFinal: "Needs Human", onNoUrl: "Needs Human" };
    lines.push("  on_pass:");
    lines.push(`    transition_to: ${yaml(t.onPass)}`);
    lines.push("    comment_template: 'Verified by IRIS. {{ result.summary }}'");
    lines.push("  on_fail:");
    lines.push("    max_attempts: 2");
    lines.push("    feedback_template: 'IRIS verification failed: {{ result.summary }}'");
    lines.push(`    final_transition_to: ${yaml(t.onFailFinal)}`);
    lines.push("    final_comment_template: 'Verification failed {{ verify.attempts }} times.'");
    lines.push("  on_no_url:");
    lines.push(`    transition_to: ${yaml(t.onNoUrl)}`);
    lines.push("    comment_template: 'Verify stage could not resolve a URL.'");
  }
  lines.push("");
  if (opts.enableConsole) {
    lines.push("server:");
    lines.push(`  port: ${opts.port}`);
    lines.push("");
  }
  lines.push("---");
  lines.push("");
  lines.push(`# Workflow: ${opts.project.title}`);
  lines.push("");
  lines.push("You are picking up GitHub Project items end-to-end — read the issue, write the change,");
  lines.push("open a PR, get it deployed, request browser verification, hand off for human review.");
  lines.push("");
  lines.push("## Context for this turn");
  lines.push("");
  lines.push("- **Item:** {{ issue.identifier }} — {{ issue.title }}");
  lines.push("- **Status:** {{ issue.state }}");
  lines.push("- **URL:** {{ issue.url }}");
  lines.push("- **Repo:** {{ issue.repo_full_name }}");
  lines.push("- **Attempt:** {% if attempt %}continuation #{{ attempt }}{% else %}first run{% endif %}");
  lines.push("");
  lines.push("## What you should do");
  lines.push("");
  lines.push("1. Move the item to `In Progress` via gh exactly once.");
  lines.push("2. Read the description below; identify the smallest change that solves the problem.");
  lines.push("");
  lines.push("   ---");
  lines.push("   {{ issue.description }}");
  lines.push("   ---");
  lines.push("");
  lines.push("3. Make the change on a branch named `symphony/{{ issue.identifier | replace: \"/\", \"-\" | replace: \"#\", \"-\" }}`.");
  lines.push("4. Run the project's tests + linter. Iterate until both pass locally.");
  lines.push("5. Open a PR with `gh pr create`. Body includes a summary + `Fixes {{ issue.identifier }}`.");
  if (opts.enableIris) {
    lines.push("6. Wait for the preview deploy (`gh pr checks --watch`), extract the preview URL.");
    lines.push("7. Print `VERIFY_REQUESTED` on its own line, then a JSON object as the LAST line:");
    lines.push("   `{\"verify_url\": \"<preview-url>\", \"verify_ready\": true}`.");
    lines.push("8. If verify fails, fix and emit `VERIFY_REQUESTED` again with the updated URL.");
  } else {
    lines.push("6. After the PR is open and merged-or-ready, transition the item to a state your team uses for review.");
  }
  lines.push("");
  lines.push("If you genuinely cannot make progress, move the item to `Needs Human` with a clear comment and stop.");
  lines.push("");

  return lines.join("\n");
}

main().catch((error) => {
  fail(error instanceof Error ? error.message : String(error));
  exit(1);
});
