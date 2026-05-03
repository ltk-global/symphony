import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execSync } from "node:child_process";

/**
 * Creates a tiny realistic git repo on disk and returns its absolute path.
 * The integration tests pass this absolute path as `issue.repoFullName`,
 * which exercises the WorkspaceManager's "absolute path -> use directly"
 * branch in `computeCacheEnv` (skipping the GitHub URL construction).
 */
export function makeTinyRepo(prefix = "symphony-fixture-"): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  execSync("git init --quiet", { cwd: dir });
  execSync("git config user.email 'fixture@test'", { cwd: dir });
  execSync("git config user.name 'fixture'", { cwd: dir });
  execSync(
    `printf '%s\\n' '{ "name": "tiny", "version": "0.0.1", "private": true }' > package.json`,
    { cwd: dir, shell: "/bin/bash" },
  );
  execSync(`printf "%s\\n" "lockfileVersion: '6.0'" > pnpm-lock.yaml`, {
    cwd: dir,
    shell: "/bin/bash",
  });
  execSync("git add . && git commit -m 'fixture' --quiet", { cwd: dir, shell: "/bin/bash" });
  return dir;
}
