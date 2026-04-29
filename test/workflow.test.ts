import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadWorkflowFromString, renderPrompt } from "../src/workflow/loader.js";
import { buildConfig } from "../src/config/index.js";

describe("workflow loader and config", () => {
  it("parses front matter and renders the prompt with strict variables", async () => {
    const workflow = loadWorkflowFromString(`---
tracker:
  kind: github_projects
  project_url: https://github.com/orgs/ltk-global/projects/7
agent:
  kind: claude_code
---
Work on {{ issue.identifier }} with IRIS={{ tools.iris_run }}.`);

    expect((workflow.config.tracker as any)?.kind).toBe("github_projects");
    await expect(
      renderPrompt(workflow.promptTemplate, {
        issue: { identifier: "ltk-global/symphony#1" },
        attempt: null,
        tools: { iris_run: true, github: false },
      }),
    ).resolves.toContain("ltk-global/symphony#1");

    await expect(renderPrompt("{{ missing.value }}", {})).rejects.toThrow();
  });

  it("applies defaults and resolves environment variables", () => {
    const cfg = buildConfig(
      {
        tracker: {
          kind: "github_projects",
          api_token: "$TEST_GITHUB_TOKEN",
          project_owner: "ltk-global",
          project_number: 7,
          active_states: ["Todo"],
          terminal_states: ["Done"],
        },
        agent: { kind: "codex" },
        iris: { enabled: true, token_env: "TEST_IRIS_TOKEN" },
      },
      { TEST_GITHUB_TOKEN: "ghp_test", TEST_IRIS_TOKEN: "swm_test" },
    );

    expect(cfg.polling.intervalMs).toBe(30_000);
    expect(cfg.workspace.root).toContain("symphony_workspaces");
    expect(cfg.tracker.apiToken).toBe("ghp_test");
    expect(cfg.agent.maxConcurrentAgents).toBe(10);
    expect(cfg.iris.token).toBe("swm_test");
  });

  it("normalizes per-state concurrency keys", () => {
    const cfg = buildConfig(
      {
        tracker: {
          kind: "github_projects",
          api_token: "$TEST_GITHUB_TOKEN",
          project_owner: "ltk-global",
          project_number: 7,
        },
        agent: {
          max_concurrent_agents_by_state: {
            "In Progress": 1,
          },
        },
      },
      { TEST_GITHUB_TOKEN: "ghp_test" },
    );

    expect(cfg.agent.maxConcurrentAgentsByState).toEqual({ "in progress": 1 });
  });

  it("rejects unsupported agent kind values", () => {
    expect(() =>
      buildConfig(
        {
          tracker: {
            kind: "github_projects",
            api_token: "$TEST_GITHUB_TOKEN",
            project_owner: "ltk-global",
            project_number: 7,
          },
          agent: { kind: "codexx" },
        },
        { TEST_GITHUB_TOKEN: "ghp_test" },
      ),
    ).toThrow("unsupported_agent_kind");
  });

  it("resolves workspace roots relative to the workflow directory and environment", () => {
    const cfg = buildConfig(
      {
        tracker: {
          kind: "github_projects",
          api_token: "$TEST_GITHUB_TOKEN",
          project_owner: "ltk-global",
          project_number: 7,
        },
        workspace: { root: "$WORKSPACE_DIR" },
      },
      { TEST_GITHUB_TOKEN: "ghp_test", WORKSPACE_DIR: "relative-workspaces" },
      { baseDir: "/repo/config" },
    );

    expect(cfg.workspace.root).toBe(join("/repo/config", "relative-workspaces"));
  });

  it("rejects invalid dispatch configuration", () => {
    expect(() =>
      buildConfig({
        tracker: { kind: "github_projects", api_token: "$MISSING" },
        agent: { kind: "claude_code" },
      }),
    ).toThrow(/missing_github_token|missing_project_identification/);
  });
});
