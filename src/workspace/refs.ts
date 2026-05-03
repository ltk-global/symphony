import { exec } from "node:child_process";
import { mkdir, open, rm, unlink } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

const execAsync = promisify(exec);

export interface RefsOptions {
  cacheRoot?: string;
}

const LOCK_RETRY_MS = 50;
const LOCK_TIMEOUT_MS = 30_000;

function refsRoot(opts: RefsOptions = {}): string {
  if (opts.cacheRoot && opts.cacheRoot.length > 0) return resolve(opts.cacheRoot);
  return join(homedir(), ".symphony-refs");
}

function sanitize(repoId: string): string {
  return repoId.replace(/[^A-Za-z0-9._-]/g, "_");
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

  return withLock(lockPath, async () => {
    if (!existsSync(bareClonePath)) {
      await tryClone(cloneUrl, bareClonePath);
      return bareClonePath;
    }
    if (!existsSync(join(bareClonePath, "objects")) || !existsSync(join(bareClonePath, "HEAD"))) {
      // Corrupted bare clone — delete and re-clone.
      await rm(bareClonePath, { recursive: true, force: true });
      await tryClone(cloneUrl, bareClonePath);
      return bareClonePath;
    }
    try {
      await execAsync(`git -C ${shellQuote(bareClonePath)} fetch --all --prune --quiet`, {
        timeout: 120_000,
      });
      return bareClonePath;
    } catch {
      await rm(bareClonePath, { recursive: true, force: true });
      try {
        await tryClone(cloneUrl, bareClonePath);
        return bareClonePath;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        throw new Error(`bare_clone_failed:${msg}`);
      }
    }
  });
}

async function tryClone(cloneUrl: string, destPath: string): Promise<void> {
  try {
    await execAsync(`git clone --bare --quiet ${shellQuote(cloneUrl)} ${shellQuote(destPath)}`, {
      timeout: 600_000,
    });
    // git clone --bare doesn't set up a fetch refspec; configure one so
    // subsequent `git fetch --all` keeps refs/heads/* in sync.
    await execAsync(
      `git -C ${shellQuote(destPath)} config remote.origin.fetch '+refs/heads/*:refs/heads/*'`,
      { timeout: 30_000 },
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`bare_clone_failed:${msg}`);
  }
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

async function withLock<T>(lockPath: string, fn: () => Promise<T>): Promise<T> {
  const start = Date.now();
  let handle: Awaited<ReturnType<typeof open>> | null = null;
  while (true) {
    try {
      handle = await open(lockPath, "wx");
      break;
    } catch (err) {
      if (!isErrnoException(err) || err.code !== "EEXIST") throw err;
      if (Date.now() - start > LOCK_TIMEOUT_MS) {
        throw new Error(`bare_clone_lock_timeout:${lockPath}`);
      }
      await sleep(LOCK_RETRY_MS);
    }
  }
  try {
    return await fn();
  } finally {
    try {
      await handle.close();
    } catch {
      // ignore
    }
    try {
      await unlink(lockPath);
    } catch {
      // ignore
    }
  }
}

function isErrnoException(err: unknown): err is NodeJS.ErrnoException {
  return err instanceof Error && "code" in err;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
