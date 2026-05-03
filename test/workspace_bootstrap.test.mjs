import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { authorRecipe } from "../scripts/lib/workspace-bootstrap.mjs";
import { LlmUnavailableError } from "../scripts/lib/llm-runner.mjs";

function fakeRunner(jsonOutput) {
  return async () => JSON.stringify(jsonOutput);
}

describe("authorRecipe", () => {
  let repo;
  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), "sym-bs-repo-"));
    writeFileSync(join(repo, "package-lock.json"), "{}");
  });
  afterEach(() => rmSync(repo, { recursive: true, force: true }));

  it("returns a validated { recipe, manifest } when the LLM stub gives valid output", async () => {
    const out = await authorRecipe({
      context: { repoFullName: "acme/foo", repoId: "X" },
      repoCheckoutDir: repo,
      runSkillImpl: fakeRunner({
        schema: "symphony.recipe.v1",
        body: "npm ci --prefer-offline",
        manifest: {
          inputFiles: ["package-lock.json"],
          discoveryFiles: [],
          cacheKeys: [],
          lfs: false,
          submodules: false,
          notes: "npm",
        },
      }),
    });
    expect(out.fallback).toBeFalsy();
    expect(out.recipe).toContain("npm ci");
    expect(out.manifest.repoId).toBe("X");
    expect(out.manifest.repoFullName).toBe("acme/foo");
    expect(out.manifest.inputHash).toMatch(/^sha256:/);
    expect(out.manifest.schema).toBe("symphony.recipe.v1");
    expect(out.manifest.inputFiles).toEqual(["package-lock.json"]);
    expect(typeof out.manifest.generatedAt).toBe("string");
    expect(typeof out.manifest.generatedBy).toBe("string");
  });

  it("strips ```json``` code fences from LLM stdout before parsing", async () => {
    const fenced = "```json\n" + JSON.stringify({
      schema: "symphony.recipe.v1",
      body: "npm ci",
      manifest: {
        inputFiles: ["package-lock.json"],
        discoveryFiles: [],
        cacheKeys: [],
        lfs: false,
        submodules: false,
        notes: "",
      },
    }) + "\n```";
    const out = await authorRecipe({
      context: { repoFullName: "x/x", repoId: "X" },
      repoCheckoutDir: repo,
      runSkillImpl: async () => fenced,
    });
    expect(out.fallback).toBeFalsy();
    expect(out.recipe).toContain("npm ci");
  });
});

describe("authorRecipe — fallback paths", () => {
  let repo;
  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), "sym-bs-repo-"));
    writeFileSync(join(repo, "package-lock.json"), "{}");
  });
  afterEach(() => rmSync(repo, { recursive: true, force: true }));

  it("returns fallback when LLM is unavailable", async () => {
    const out = await authorRecipe({
      context: { repoFullName: "x/x", repoId: "X" },
      repoCheckoutDir: repo,
      runSkillImpl: async () => {
        throw new LlmUnavailableError("no_llm_on_path");
      },
    });
    expect(out.fallback).toBe(true);
    expect(out.reason).toBe("no_llm");
  });

  it("returns fallback when LLM returns junk", async () => {
    const out = await authorRecipe({
      context: { repoFullName: "x/x", repoId: "X" },
      repoCheckoutDir: repo,
      runSkillImpl: async () => "not json at all",
    });
    expect(out.fallback).toBe(true);
    expect(out.reason).toBe("parse_failed");
  });

  it("returns fallback with llm_failed:<msg> when LLM impl throws non-LlmUnavailableError", async () => {
    const out = await authorRecipe({
      context: { repoFullName: "x/x", repoId: "X" },
      repoCheckoutDir: repo,
      runSkillImpl: async () => {
        throw new Error("boom");
      },
    });
    expect(out.fallback).toBe(true);
    expect(out.reason).toMatch(/^llm_failed:/);
  });

  it("rejects parsed JSON whose body is not a string", async () => {
    const out = await authorRecipe({
      context: { repoFullName: "x/x", repoId: "X" },
      repoCheckoutDir: repo,
      runSkillImpl: async () =>
        JSON.stringify({
          schema: "symphony.recipe.v1",
          body: { not: "a string" },
          manifest: { inputFiles: [], discoveryFiles: [], cacheKeys: [], lfs: false, submodules: false, notes: "" },
        }),
    });
    expect(out.fallback).toBe(true);
    expect(out.reason).toBe("parse_failed");
  });

  it("rejects manifest paths that escape the checkout (no fs read)", async () => {
    const out = await authorRecipe({
      context: { repoFullName: "x/x", repoId: "X" },
      repoCheckoutDir: repo,
      runSkillImpl: async () =>
        JSON.stringify({
          schema: "symphony.recipe.v1",
          body: "npm ci",
          manifest: { inputFiles: ["../.env"], discoveryFiles: [], cacheKeys: [], lfs: false, submodules: false, notes: "" },
        }),
    });
    expect(out.fallback).toBe(true);
    expect(out.reason).toBe("unsafe_manifest_path");
  });

  it("rejects absolute manifest paths in discoveryFiles", async () => {
    const out = await authorRecipe({
      context: { repoFullName: "x/x", repoId: "X" },
      repoCheckoutDir: repo,
      runSkillImpl: async () =>
        JSON.stringify({
          schema: "symphony.recipe.v1",
          body: "npm ci",
          manifest: { inputFiles: [], discoveryFiles: ["/etc/passwd"], cacheKeys: [], lfs: false, submodules: false, notes: "" },
        }),
    });
    expect(out.fallback).toBe(true);
    expect(out.reason).toBe("unsafe_manifest_path");
  });

  it("rejects manifest missing inputFiles entirely", async () => {
    const out = await authorRecipe({
      context: { repoFullName: "x/x", repoId: "X" },
      repoCheckoutDir: repo,
      runSkillImpl: async () =>
        JSON.stringify({
          schema: "symphony.recipe.v1",
          body: "npm ci",
          manifest: { discoveryFiles: [], cacheKeys: [], lfs: false, submodules: false, notes: "" },
        }),
    });
    expect(out.fallback).toBe(true);
    expect(out.reason).toBe("parse_failed");
  });

  it("rejects manifest with non-array discoveryFiles", async () => {
    const out = await authorRecipe({
      context: { repoFullName: "x/x", repoId: "X" },
      repoCheckoutDir: repo,
      runSkillImpl: async () =>
        JSON.stringify({
          schema: "symphony.recipe.v1",
          body: "npm ci",
          manifest: { inputFiles: [], discoveryFiles: "yarn.lock", cacheKeys: [], lfs: false, submodules: false, notes: "" },
        }),
    });
    expect(out.fallback).toBe(true);
    expect(out.reason).toBe("parse_failed");
  });
});
