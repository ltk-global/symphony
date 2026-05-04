import { execFile } from "node:child_process";
import { mkdir, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { withLock } from "./_lock.js";

const execFileAsync = promisify(execFile);

export interface RefsOptions {
  cacheRoot?: string;
  // Optional GitHub token (raw, not pre-formatted). When set, sent via
  // `git -c http.extraHeader='Authorization: Basic …'` per-invocation so
  // the token never lands in remote.origin.url or in fetch error messages.
  // The header is the Basic form (`base64(x-access-token:<token>)`) — which
  // matches what URL-injection (`https://x-access-token:TOKEN@…`) produces
  // internally. The Bearer form is rejected by GitHub for `gho_*` user-OAuth
  // tokens, so we use Basic for compatibility across all token shapes.
  authToken?: string;
}

function redactAuth(text: string): string {
  return text.replace(/Authorization: (Bearer|Basic) [^\s'"]+/g, "Authorization: $1 ***REDACTED***");
}

function gitErrorMessage(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  return redactAuth(raw);
}

function refsRoot(opts: RefsOptions = {}): string {
  if (opts.cacheRoot && opts.cacheRoot.length > 0) return resolve(opts.cacheRoot);
  return join(homedir(), ".symphony-refs");
}

function sanitize(repoId: string): string {
  return repoId.replace(/[^A-Za-z0-9._-]/g, "_");
}

function gitArgs(authToken: string | undefined, ...args: string[]): string[] {
  if (!authToken) return args;
  const basic = Buffer.from(`x-access-token:${authToken}`).toString("base64");
  return ["-c", `http.extraHeader=Authorization: Basic ${basic}`, ...args];
}

export function getReferencePath(repoId: string, opts: RefsOptions = {}): string {
  return join(refsRoot(opts), `${sanitize(repoId)}.git`);
}

export async function ensureBareClone(
  repoId: string,
  cloneUrl: string,
  opts: RefsOptions = {},
): Promise<string> {
  const root = refsRoot(opts);
  await mkdir(root, { recursive: true });
  const sanitized = sanitize(repoId);
  const bareClonePath = join(root, `${sanitized}.git`);
  const lockPath = join(root, `${sanitized}.git.lock`);

  return withLock(lockPath, { errorPrefix: "bare_clone_lock_timeout" }, async () => {
    if (!existsSync(bareClonePath)) {
      await tryClone(cloneUrl, bareClonePath, opts.authToken);
      return bareClonePath;
    }
    if (!existsSync(join(bareClonePath, "objects")) || !existsSync(join(bareClonePath, "HEAD"))) {
      // Corrupted bare clone — delete and re-clone.
      await rm(bareClonePath, { recursive: true, force: true });
      await tryClone(cloneUrl, bareClonePath, opts.authToken);
      return bareClonePath;
    }
    try {
      await execFileAsync(
        "git",
        gitArgs(opts.authToken, "-C", bareClonePath, "fetch", "--all", "--prune", "--quiet"),
        { timeout: 120_000 },
      );
      return bareClonePath;
    } catch {
      // Transient network/auth failure — keep the existing cache so workspaces
      // that borrow objects via --reference still work; next prepare() will retry.
      // (Actual corruption is detected before this branch via existsSync checks.)
      return bareClonePath;
    }
  });
}

async function tryClone(cloneUrl: string, destPath: string, authToken: string | undefined): Promise<void> {
  try {
    await execFileAsync(
      "git",
      gitArgs(authToken, "clone", "--bare", "--quiet", cloneUrl, destPath),
      { timeout: 600_000 },
    );
    // git clone --bare doesn't set up a fetch refspec; configure one so
    // subsequent `git fetch --all` keeps refs/heads/* in sync.
    await execFileAsync(
      "git",
      ["-C", destPath, "config", "remote.origin.fetch", "+refs/heads/*:refs/heads/*"],
      { timeout: 30_000 },
    );
  } catch (err) {
    throw new Error(`bare_clone_failed:${gitErrorMessage(err)}`);
  }
}

