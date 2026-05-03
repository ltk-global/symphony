import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

// Tests shell out to `dist/src/cli.js`. The repo is built; if not, vitest's
// TS sources can't be invoked because cli.ts uses Commander's top-level await.
// `npm run build` is run in beforeAll if the dist artifact is missing.
const REPO = resolve(__dirname, "..");
const CLI = join(REPO, "dist", "src", "cli.js");

// SYMPHONY_CACHE_DIR is the seam — every recipe-subcommand path is rooted
// under it so tests don't touch ~/.symphony-cache.
let cacheDir: string;

beforeAll(() => {
  if (!existsSync(CLI)) {
    execFileSync("npm", ["run", "build"], { cwd: REPO, stdio: "inherit" });
  }
});

beforeEach(() => {
  cacheDir = mkdtempSync(join(tmpdir(), "symphony-cli-cache-"));
});

afterEach(() => {
  rmSync(cacheDir, { recursive: true, force: true });
});

function run(args: string[]): { stdout: string; stderr: string; status: number } {
  try {
    const stdout = execFileSync("node", [CLI, ...args], {
      env: { ...process.env, SYMPHONY_CACHE_DIR: cacheDir },
      stdio: ["ignore", "pipe", "pipe"],
      encoding: "utf8",
    });
    return { stdout, stderr: "", status: 0 };
  } catch (err: unknown) {
    const e = err as { stdout?: Buffer; stderr?: Buffer; status?: number };
    return {
      stdout: e.stdout?.toString() ?? "",
      stderr: e.stderr?.toString() ?? "",
      status: e.status ?? 1,
    };
  }
}

function seedRecipe(name: string, manifest: Record<string, unknown>, body = "echo hello"): { sh: string; json: string } {
  const dir = join(cacheDir, "recipes");
  mkdirSync(dir, { recursive: true });
  const sh = join(dir, `${name}.sh`);
  const json = join(dir, `${name}.json`);
  writeFileSync(sh, body);
  writeFileSync(json, JSON.stringify(manifest, null, 2));
  return { sh, json };
}

describe("symphony recipe CLI", () => {
  it("`recipe list` reports empty cache cleanly", () => {
    const r = run(["recipe", "list"]);
    expect(r.status).toBe(0);
    expect(r.stdout.toLowerCase()).toMatch(/no recipes|0 recipes|empty/);
  });

  it("`recipe list` shows seeded recipes with status + repoId + age", () => {
    seedRecipe("foo_bar.deadbeef", {
      schema: "symphony.recipe.v1",
      repoId: "foo/bar",
      repoFullName: "foo/bar",
      generatedBy: "claude-code",
      generatedAt: new Date(Date.now() - 3600_000).toISOString(),
      inputHash: "sha256:x",
      inputFiles: [],
      discoveryFiles: [],
      cacheKeys: [],
      lfs: false,
      submodules: false,
      notes: "",
      approvedBy: null,
      approvedAt: null,
    });
    const r = run(["recipe", "list"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("foo/bar");
    expect(r.stdout).toMatch(/final|ok|active/i);
  });

  it("`recipe show <repo>` prints the .sh + manifest", () => {
    seedRecipe("foo_bar.deadbeef", {
      schema: "symphony.recipe.v1",
      repoId: "foo/bar",
      repoFullName: "foo/bar",
      generatedBy: "claude-code",
      generatedAt: new Date().toISOString(),
      inputHash: "sha256:x",
      inputFiles: [],
      discoveryFiles: [],
      cacheKeys: [],
      lfs: false,
      submodules: false,
      notes: "",
      approvedBy: null,
      approvedAt: null,
    }, "echo HELLO_FROM_TEST");
    const r = run(["recipe", "show", "foo/bar"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("echo HELLO_FROM_TEST");
    expect(r.stdout).toContain("symphony.recipe.v1");
  });

  it("`recipe approve <repo>` renames .pending → final", () => {
    const dir = join(cacheDir, "recipes");
    mkdirSync(dir, { recursive: true });
    const stem = "foo_bar.deadbeef";
    writeFileSync(join(dir, `${stem}.sh.pending`), "echo pending");
    writeFileSync(join(dir, `${stem}.json.pending`), JSON.stringify({
      schema: "symphony.recipe.v1",
      repoId: "foo/bar",
      repoFullName: "foo/bar",
      generatedBy: "x",
      generatedAt: new Date().toISOString(),
      inputHash: "sha256:x",
      inputFiles: [],
      discoveryFiles: [],
      cacheKeys: [],
      lfs: false,
      submodules: false,
      notes: "",
      approvedBy: null,
      approvedAt: null,
    }));
    const r = run(["recipe", "approve", "foo/bar"]);
    expect(r.status).toBe(0);
    expect(existsSync(join(dir, `${stem}.sh`))).toBe(true);
    expect(existsSync(join(dir, `${stem}.sh.pending`))).toBe(false);
  });

  it("`recipe reject <repo>` removes .pending pair", () => {
    const dir = join(cacheDir, "recipes");
    mkdirSync(dir, { recursive: true });
    const stem = "foo_bar.deadbeef";
    writeFileSync(join(dir, `${stem}.sh.pending`), "echo pending");
    writeFileSync(join(dir, `${stem}.json.pending`), JSON.stringify({
      schema: "symphony.recipe.v1",
      repoId: "foo/bar",
      repoFullName: "foo/bar",
      generatedBy: "x",
      generatedAt: new Date().toISOString(),
      inputHash: "sha256:x",
      inputFiles: [],
      discoveryFiles: [],
      cacheKeys: [],
      lfs: false,
      submodules: false,
      notes: "",
      approvedBy: null,
      approvedAt: null,
    }));
    const r = run(["recipe", "reject", "foo/bar"]);
    expect(r.status).toBe(0);
    expect(existsSync(join(dir, `${stem}.sh.pending`))).toBe(false);
    expect(existsSync(join(dir, `${stem}.json.pending`))).toBe(false);
  });

  it("`recipe regen <repo>` removes both final and pending", () => {
    const dir = join(cacheDir, "recipes");
    mkdirSync(dir, { recursive: true });
    const stem = "foo_bar.deadbeef";
    writeFileSync(join(dir, `${stem}.sh`), "echo final");
    writeFileSync(join(dir, `${stem}.json`), "{}");
    writeFileSync(join(dir, `${stem}.sh.pending`), "echo pending");
    writeFileSync(join(dir, `${stem}.json.pending`), "{}");
    const r = run(["recipe", "regen", "foo/bar"]);
    expect(r.status).toBe(0);
    expect(existsSync(join(dir, `${stem}.sh`))).toBe(false);
    expect(existsSync(join(dir, `${stem}.sh.pending`))).toBe(false);
  });

  it("`recipe quarantine <repo>` writes a marker file", () => {
    const dir = join(cacheDir, "recipes");
    mkdirSync(dir, { recursive: true });
    const stem = "foo_bar.deadbeef";
    writeFileSync(join(dir, `${stem}.sh`), "echo final");
    writeFileSync(join(dir, `${stem}.json`), "{}");
    const r = run(["recipe", "quarantine", "foo/bar"]);
    expect(r.status).toBe(0);
    // Either an explicit .quarantined marker, or the .sh renamed — accept any
    // pattern that prevents the recipe from being picked up.
    expect(existsSync(join(dir, `${stem}.quarantined`))
      || !existsSync(join(dir, `${stem}.sh`))).toBe(true);
  });

  it("`recipe prune` removes all recipes", () => {
    seedRecipe("a_b.aaaaaaaa", { schema: "symphony.recipe.v1", repoFullName: "a/b" });
    seedRecipe("c_d.bbbbbbbb", { schema: "symphony.recipe.v1", repoFullName: "c/d" });
    const r = run(["recipe", "prune", "--force"]);
    expect(r.status).toBe(0);
    const dir = join(cacheDir, "recipes");
    expect(existsSync(join(dir, "a_b.aaaaaaaa.sh"))).toBe(false);
    expect(existsSync(join(dir, "c_d.bbbbbbbb.sh"))).toBe(false);
  });
});
