import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ensureBareClone, getReferencePath } from "../src/workspace/refs.js";

let cacheRoot: string;
let upstream: string;

function git(cwd: string, ...args: string[]): string {
  return execSync(["git", ...args].join(" "), { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

function makeUpstream(): string {
  const dir = mkdtempSync(join(tmpdir(), "symphony-upstream-"));
  git(dir, "init", "--quiet");
  git(dir, "config", "user.email", "test@example.com");
  git(dir, "config", "user.name", "test");
  execSync("echo hello > README.md", { cwd: dir, shell: "/bin/bash" });
  git(dir, "add", ".");
  git(dir, "commit", "-m", '"initial"', "--quiet");
  return dir;
}

beforeEach(() => {
  cacheRoot = mkdtempSync(join(tmpdir(), "symphony-refs-"));
  upstream = makeUpstream();
});

afterEach(() => {
  if (cacheRoot) rmSync(cacheRoot, { recursive: true, force: true });
  if (upstream) rmSync(upstream, { recursive: true, force: true });
});

describe("workspace refs", () => {
  it("returns the configured cache path under cacheRoot", () => {
    const p = getReferencePath("REPO_ID_123", { cacheRoot });
    expect(p).toBe(join(cacheRoot, "REPO_ID_123.git"));
  });

  it("first call clones a bare repo", async () => {
    const path = await ensureBareClone("REPO_ID_123", upstream, { cacheRoot });
    expect(path).toBe(getReferencePath("REPO_ID_123", { cacheRoot }));
    expect(existsSync(join(path, "objects"))).toBe(true);
    expect(existsSync(join(path, "HEAD"))).toBe(true);
  });

  it("second call fetches new commits", async () => {
    await ensureBareClone("REPO_ID_123", upstream, { cacheRoot });
    execSync("echo more > more.txt", { cwd: upstream, shell: "/bin/bash" });
    git(upstream, "add", ".");
    git(upstream, "commit", "-m", '"second"', "--quiet");

    const path = await ensureBareClone("REPO_ID_123", upstream, { cacheRoot });
    const log = git(path, "log", "--oneline").trim().split("\n");
    expect(log.length).toBeGreaterThanOrEqual(2);
  });

  it("recovers from a corrupted bare clone", async () => {
    const path = await ensureBareClone("REPO_ID_123", upstream, { cacheRoot });
    rmSync(join(path, "objects"), { recursive: true, force: true });
    const path2 = await ensureBareClone("REPO_ID_123", upstream, { cacheRoot });
    expect(path2).toBe(path);
    expect(existsSync(join(path2, "objects"))).toBe(true);
    expect(existsSync(join(path2, "HEAD"))).toBe(true);
  });

  it("serializes concurrent calls for the same repoId", async () => {
    const results = await Promise.all(
      [0, 1, 2, 3, 4].map(() => ensureBareClone("REPO_ID_123", upstream, { cacheRoot })),
    );
    const expected = getReferencePath("REPO_ID_123", { cacheRoot });
    for (const r of results) {
      expect(r).toBe(expected);
    }
    expect(existsSync(join(expected, "objects"))).toBe(true);
  });
});
