import { describe, it, expect } from "vitest";
import { authorWorkflow } from "../scripts/lib/workflow-author.mjs";
import { EventEmitter } from "node:events";

const FIXED_LLM_OUTPUT = `---
tracker:
  kind: github_projects
  api_token: $GITHUB_TOKEN
  project_url: https://github.com/users/test/projects/1
  status_field: Status
  active_states: [Todo]
  terminal_states: [Done]
  needs_human_state: Needs Human

polling:
  interval_ms: 30000

workspace:
  root: ~/symphony_workspaces/test

hooks:
  after_create: |
    set -euo pipefail
    git clone "https://x-access-token:\${GITHUB_TOKEN}@github.com/\${ISSUE_REPO_FULL_NAME}.git" .
    git checkout -B "\${ISSUE_BRANCH_NAME:-symphony/\${ISSUE_WORKSPACE_KEY}}"

agent:
  kind: claude_code
  max_concurrent_agents: 3
  max_turns: 25

claude_code:
  command: claude
  permission_mode: acceptEdits
  allowed_tools: [Bash, Read, Edit, Write, Glob, Grep, WebFetch]
  append_system_prompt: |
    You are running unattended.

iris:
  enabled: false
---

# Workflow: Test
{{ issue.identifier }} {{ issue.title }} {{ issue.description }}
{{ issue.url }} {{ issue.state }} {{ issue.repo_full_name }}
{% if attempt %}continuation #{{ attempt }}{% else %}first run{% endif %}
`;

function fakeSpawn() {
  return (cmd, args) => {
    const child = new EventEmitter();
    child.stdin = { end: () => {} };
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => {};
    process.nextTick(() => {
      child.stdout.emit("data", Buffer.from(FIXED_LLM_OUTPUT));
      child.emit("exit", 0);
    });
    return child;
  };
}

describe("workflow-author post-llm-runner refactor", () => {
  it("produces byte-identical output to a golden snapshot when LLM stub returns fixed text", async () => {
    const context = {
      project: { title: "Test", url: "https://github.com/users/test/projects/1", owner: { login: "test" } },
      statusOptions: [{ id: "1", name: "Todo" }, { id: "2", name: "Done" }, { id: "3", name: "Needs Human" }],
      activeStates: ["Todo"],
      terminalStates: ["Done"],
      needsHumanState: "Needs Human",
      assignee: null,
      agentKind: "claude_code",
      enableIris: false,
      irisProfile: "claude-default-latest",
      verify: { mode: "agent_output", url: "" },
      verifyTransitions: null,
      enableConsole: false,
      port: 8787,
      workspaceRoot: "~/symphony_workspaces/test",
      slack: null,
    };
    const result = await authorWorkflow({ context, description: "", spawnImpl: fakeSpawn() });
    expect(result.source).toBe(FIXED_LLM_OUTPUT);
    expect(result.fallback).toBe(false);
  });
});
