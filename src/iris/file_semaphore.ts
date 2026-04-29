import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export class FileSemaphore {
  private readonly root: string;

  constructor(
    private readonly key: string,
    private readonly max: number,
    root = join(tmpdir(), "symphony_iris_locks"),
  ) {
    if (max <= 0) throw new Error("semaphore_max_must_be_positive");
    this.root = join(root, sanitizeKey(key));
  }

  async acquire(signal?: AbortSignal): Promise<() => void> {
    if (signal?.aborted) throw new Error("aborted");
    await mkdir(this.root, { recursive: true });
    for (;;) {
      for (let index = 0; index < this.max; index += 1) {
        const slotPath = join(this.root, `slot-${index}`);
        try {
          await mkdir(slotPath);
          return releaseOnce(slotPath);
        } catch (error: any) {
          if (error?.code !== "EEXIST") throw error;
        }
      }
      await delay(25, signal);
    }
  }
}

function releaseOnce(slotPath: string): () => void {
  let released = false;
  return () => {
    if (released) return;
    released = true;
    void rm(slotPath, { recursive: true, force: true });
  };
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(new Error("aborted"));
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(resolve, ms);
    const onAbort = () => {
      clearTimeout(timeout);
      reject(new Error("aborted"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function sanitizeKey(key: string): string {
  return key.replace(/[^a-zA-Z0-9_.-]+/g, "_").slice(0, 120) || "default";
}
