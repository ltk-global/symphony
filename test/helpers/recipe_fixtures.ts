import type { RecipeManifest } from "../../src/workspace/recipe_validator.js";

const BASE: RecipeManifest = {
  schema: "symphony.recipe.v1",
  repoId: "X",
  repoFullName: "x/x",
  generatedBy: "claude-code",
  generatedAt: "2026-05-03T00:00:00Z",
  inputHash: "sha256:0",
  inputFiles: [],
  discoveryFiles: [],
  cacheKeys: [],
  lfs: false,
  submodules: false,
  notes: "",
  approvedBy: null,
  approvedAt: null,
};

export function makeManifest(overrides: Partial<RecipeManifest> = {}): RecipeManifest {
  return { ...BASE, ...overrides };
}
