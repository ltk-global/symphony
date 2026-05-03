import { describe, it, expect } from "vitest";
import { validateRecipe } from "../src/workspace/recipe_validator.js";
import { makeManifest } from "./helpers/recipe_fixtures.js";

const baseManifest = makeManifest();

const SECRETS: [string, string][] = [
  ["echo ghp_abcdefghijklmnopqrstuvwxyz0123456789AB", "github classic PAT"],
  ["TOKEN=github_pat_12345_abcdefghijklmnopqrstuvwxyz", "github fine-grained PAT"],
  ["URL=https://hooks.slack.com/services/T0/B0/AAAA", "slack webhook"],
  ["API=swm_abcdefghijklmnopqrstuvwxyz123456", "iris token"],
  ["XOXAB=xoxb-1234-5678-abcd-efgh", "slack bot token"],
];

describe("validateRecipe — secret scan", () => {
  it.each(SECRETS)("body %j → rejected (%s)", (body, _label) => {
    const r = validateRecipe(body, baseManifest);
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => /secret|token/i.test(e))).toBe(true);
  });

  it("does not flag a normal git SHA (40 hex)", () => {
    const r = validateRecipe("git checkout abcdef0123456789abcdef0123456789abcdef01", baseManifest);
    expect(r.ok).toBe(true);
  });
});
