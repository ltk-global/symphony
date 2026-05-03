import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { computeInputHash as computeInputHashTs } from "../src/workspace/recipes.js";
import { computeInputHash as computeInputHashMjs } from "../scripts/lib/workspace-bootstrap.mjs";

// Both copies of computeInputHash MUST produce the same hash for the same
// input set on the same fixture — otherwise every cached recipe silently
// invalidates because the .mjs caller (authorRecipe) and the .ts caller
// (LlmRecipeProvider.tryLoadCached) would compute different inputHashes.
describe("computeInputHash parity (mjs ↔ ts)", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "sym-hash-parity-"));
    writeFileSync(join(dir, "a.txt"), "alpha");
    writeFileSync(join(dir, "b.lock"), '{"v":1}');
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("agrees on present files (sorted order, same content)", async () => {
    const files = ["b.lock", "a.txt"]; // intentionally unsorted at input
    const ts = await computeInputHashTs(dir, files);
    const mjs = await computeInputHashMjs(dir, files);
    expect(ts).toBe(mjs);
    expect(ts).toMatch(/^sha256:[a-f0-9]{64}$/);
  });

  it("agrees on missing files (sentinel applied identically)", async () => {
    const files = ["does-not-exist.lock", "also-missing.json"];
    const ts = await computeInputHashTs(dir, files);
    const mjs = await computeInputHashMjs(dir, files);
    expect(ts).toBe(mjs);
  });

  it("agrees on a mix of present + missing", async () => {
    const files = ["a.txt", "missing.txt", "b.lock"];
    const ts = await computeInputHashTs(dir, files);
    const mjs = await computeInputHashMjs(dir, files);
    expect(ts).toBe(mjs);
  });

  it("is deterministic (same inputs → same hash twice in a row)", async () => {
    const files = ["a.txt", "b.lock"];
    const a = await computeInputHashTs(dir, files);
    const b = await computeInputHashTs(dir, files);
    expect(a).toBe(b);
  });

  it("changes when content changes", async () => {
    const files = ["a.txt"];
    const before = await computeInputHashTs(dir, files);
    writeFileSync(join(dir, "a.txt"), "beta");
    const after = await computeInputHashTs(dir, files);
    expect(before).not.toBe(after);
  });

  it("invalidates when a discovery file appears (presence-only change)", async () => {
    const files: string[] = [];
    const discovery = ["yarn.lock"];
    const before = await computeInputHashTs(dir, files, discovery);
    writeFileSync(join(dir, "yarn.lock"), "v1");
    const after = await computeInputHashTs(dir, files, discovery);
    expect(before).not.toBe(after);
    // ts and mjs agree on the new hash too
    const afterMjs = await computeInputHashMjs(dir, files, discovery);
    expect(after).toBe(afterMjs);
  });

  it("discoveryFile content changes do NOT invalidate (presence-only check)", async () => {
    writeFileSync(join(dir, "yarn.lock"), "v1");
    const files: string[] = [];
    const discovery = ["yarn.lock"];
    const before = await computeInputHashTs(dir, files, discovery);
    writeFileSync(join(dir, "yarn.lock"), "v2-changed-but-still-present");
    const after = await computeInputHashTs(dir, files, discovery);
    expect(before).toBe(after);
  });

  it("treats symlink-out-of-checkout inputs as missing (no host file read)", async () => {
    // Create an outside-checkout file the symlink will point at.
    const outsideDir = mkdtempSync(join(tmpdir(), "sym-hash-outside-"));
    try {
      const secret = join(outsideDir, "secret.txt");
      writeFileSync(secret, "TOP-SECRET");
      symlinkSync(secret, join(dir, "package-lock.json"));
      const files = ["package-lock.json"];
      // Both ts + mjs treat the symlink target as missing because realpath
      // resolves outside rootDir.
      const ts = await computeInputHashTs(dir, files);
      const mjs = await computeInputHashMjs(dir, files);
      expect(ts).toBe(mjs);
      // Same hash as if package-lock.json simply didn't exist.
      const baseline = await computeInputHashTs(dir, ["package-lock.json"]);
      expect(ts).toBe(baseline);
    } finally {
      rmSync(outsideDir, { recursive: true, force: true });
    }
  });
});
