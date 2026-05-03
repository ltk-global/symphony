// Layer 5 e2e — runs the workspace-bootstrap skill against a real LLM CLI
// (claude or codex). Gated by `SYMPHONY_E2E_LLM=1` so CI / local-dev runs of
// `npm test` don't spawn billable LLM calls. The fixture is the trivially-
// shaped octocat/Hello-World on disk (a single-file repo with README.md);
// the manifest the LLM emits should at least include README.md as a
// discovery file or note the absence of a lockfile.
import { describe, it, expect, beforeAll } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
// @ts-expect-error - .mjs import in TS test
import { authorRecipe } from "../../scripts/lib/workspace-bootstrap.mjs";
import { validateRecipe } from "../../src/workspace/recipe_validator.js";

const GATE = process.env.SYMPHONY_E2E_LLM === "1";

const describeIfGated = GATE ? describe : describe.skip;

describeIfGated("real LLM bootstrap (Layer 5, SYMPHONY_E2E_LLM=1)", () => {
  let repo: string;

  beforeAll(() => {
    repo = mkdtempSync(join(tmpdir(), "sym-e2e-llm-"));
    // Tiny repo shape that the skill should be able to inspect quickly.
    writeFileSync(join(repo, "README.md"), "# Hello-World\n\nA tiny test repo.\n");
    writeFileSync(join(repo, "package.json"), JSON.stringify({
      name: "hello-world",
      version: "0.0.1",
      private: true,
    }, null, 2));
    writeFileSync(join(repo, "package-lock.json"), JSON.stringify({
      name: "hello-world",
      lockfileVersion: 3,
      requires: true,
      packages: { "": { name: "hello-world", version: "0.0.1" } },
    }, null, 2));
    // Initialize git so the skill's repo-shape questions don't fail.
    execFileSync("git", ["init", "--quiet"], { cwd: repo });
    execFileSync("git", ["config", "user.email", "e2e@test"], { cwd: repo });
    execFileSync("git", ["config", "user.name", "e2e"], { cwd: repo });
    execFileSync("git", ["add", "."], { cwd: repo });
    execFileSync("git", ["commit", "-m", "init", "--quiet"], { cwd: repo });
  }, 60_000);

  it("authors a valid recipe via the LLM CLI on PATH", async () => {
    const result = await authorRecipe({
      context: { repoId: "octocat_Hello-World", repoFullName: "octocat/Hello-World" },
      repoCheckoutDir: repo,
      timeoutMs: 180_000,
    });
    if (result.fallback) {
      // Capture the failure reason for the verification doc but don't pass —
      // the assertion communicates that the LLM round-trip itself failed.
      throw new Error(`LLM authoring failed (fallback): ${result.reason}`);
    }
    expect(result.source).toBe("llm");
    expect(typeof result.recipe).toBe("string");
    expect(result.recipe.length).toBeGreaterThan(0);
    // Validator must accept it — same gate the daemon runs.
    const v = validateRecipe(result.recipe, {
      ...result.manifest,
      repoId: "octocat_Hello-World",
      repoFullName: "octocat/Hello-World",
    });
    if (!v.ok) {
      throw new Error(`recipe validation failed: ${v.errors.join("; ")}`);
    }
    // The manifest should declare at least one input file from the repo.
    expect(result.manifest.inputFiles.length + result.manifest.discoveryFiles.length).toBeGreaterThan(0);
    // Cleanup deferred to afterAll-implicit by mkdtemp.
    rmSync(repo, { recursive: true, force: true });
  }, 240_000);
});
