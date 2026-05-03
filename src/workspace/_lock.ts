import { open, unlink } from "node:fs/promises";

const RETRY_MS = 50;
const DEFAULT_TIMEOUT_MS = 900_000;

export interface LockOptions {
  errorPrefix: string;
  timeoutMs?: number;
}

export async function withLock<T>(
  lockPath: string,
  opts: LockOptions,
  fn: () => Promise<T>,
): Promise<T> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const start = Date.now();
  let handle: Awaited<ReturnType<typeof open>> | null = null;
  while (true) {
    try {
      handle = await open(lockPath, "wx");
      break;
    } catch (err) {
      if (!isErrnoException(err) || err.code !== "EEXIST") throw err;
      if (Date.now() - start > timeoutMs) {
        throw new Error(`${opts.errorPrefix}:${lockPath}`);
      }
      await sleep(RETRY_MS);
    }
  }
  try {
    return await fn();
  } finally {
    await handle.close().catch(() => {});
    await unlink(lockPath).catch(() => {});
  }
}

function isErrnoException(err: unknown): err is NodeJS.ErrnoException {
  return err instanceof Error && "code" in err;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
