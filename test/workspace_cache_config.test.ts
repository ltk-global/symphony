import { describe, expect, it } from "vitest";
import { buildConfig } from "../src/config/index.js";

const baseRaw = {
  tracker: {
    kind: "github_projects",
    project_url: "https://github.com/orgs/example/projects/1",
    api_token: "$TOKEN",
  },
  agent: { kind: "claude_code" },
};

const env = { TOKEN: "test-token" } as NodeJS.ProcessEnv;

describe("workspace.cache config", () => {
  it("uses defaults when cache is absent", () => {
    const cfg = buildConfig(baseRaw, env);
    expect(cfg.workspace.cache.strategy).toBe("llm");
    expect(cfg.workspace.cache.reviewRequired).toBe(false);
    expect(cfg.workspace.cache.recipeTtlHours).toBe(168);
  });

  it("rejects unknown strategy values", () => {
    expect(() =>
      buildConfig({ ...baseRaw, workspace: { cache: { strategy: "nonsense" } } }, env),
    ).toThrow(/strategy/);
  });

  it("accepts strategy=llm", () => {
    const cfg = buildConfig({ ...baseRaw, workspace: { cache: { strategy: "llm" } } }, env);
    expect(cfg.workspace.cache.strategy).toBe("llm");
  });

  it("accepts strategy=reference_only", () => {
    const cfg = buildConfig(
      { ...baseRaw, workspace: { cache: { strategy: "reference_only" } } },
      env,
    );
    expect(cfg.workspace.cache.strategy).toBe("reference_only");
  });

  it("accepts strategy=none", () => {
    const cfg = buildConfig({ ...baseRaw, workspace: { cache: { strategy: "none" } } }, env);
    expect(cfg.workspace.cache.strategy).toBe("none");
  });

  it("parses snake_case review_required and recipe_ttl_hours", () => {
    const cfg = buildConfig(
      {
        ...baseRaw,
        workspace: {
          cache: { strategy: "llm", review_required: true, recipe_ttl_hours: 24 },
        },
      },
      env,
    );
    expect(cfg.workspace.cache.reviewRequired).toBe(true);
    expect(cfg.workspace.cache.recipeTtlHours).toBe(24);
  });
});
