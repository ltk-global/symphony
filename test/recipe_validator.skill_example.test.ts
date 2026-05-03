import { describe, it, expect } from "vitest";
import { validateRecipe } from "../src/workspace/recipe_validator.js";

describe("validator accepts the documented skill example", () => {
  it("the body in skills/symphony-workspace-bootstrap/SKILL.md example passes validation", () => {
    const body = `if [ -f pnpm-lock.yaml ]; then\n  corepack enable >/dev/null 2>&1 || true\n  pnpm install --frozen-lockfile --prefer-offline\nelif [ -f package-lock.json ]; then\n  npm ci --prefer-offline\nelif [ -f yarn.lock ]; then\n  yarn install --frozen-lockfile --prefer-offline\nfi\nif [ -f .gitmodules ]; then\n  git submodule update --init --recursive\nfi`;
    const manifest = {
      schema: "symphony.recipe.v1",
      repoId: "X", repoFullName: "x/x", generatedBy: "claude-code",
      generatedAt: "2026-05-03T00:00:00Z",
      inputHash: "sha256:0",
      inputFiles: ["package.json", "pnpm-lock.yaml", ".gitmodules"],
      discoveryFiles: ["yarn.lock", "package-lock.json"],
      cacheKeys: [{ name: "node_modules", hashFiles: ["pnpm-lock.yaml"], path: "node_modules" }],
      lfs: false, submodules: true, notes: "pnpm + 1 submodule",
      approvedBy: null, approvedAt: null,
    };
    const r = validateRecipe(body, manifest);
    expect(r.ok).toBe(true);
    expect(r.errors).toEqual([]);
  });
});
