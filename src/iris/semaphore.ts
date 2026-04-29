export class Semaphore {
  private active = 0;
  private readonly queue: Array<{
    resolve: (release: () => void) => void;
    reject: (error: Error) => void;
    signal?: AbortSignal;
    onAbort?: () => void;
  }> = [];

  constructor(private readonly max: number) {
    if (max <= 0) throw new Error("semaphore_max_must_be_positive");
  }

  get snapshot(): { active: number; queued: number; max: number } {
    return { active: this.active, queued: this.queue.length, max: this.max };
  }

  acquire(signal?: AbortSignal): Promise<() => void> {
    if (signal?.aborted) return Promise.reject(new Error("aborted"));
    if (this.active < this.max && this.queue.length === 0) {
      this.active += 1;
      return Promise.resolve(this.releaseOnce());
    }
    return new Promise((resolve, reject) => {
      const entry = { resolve, reject, signal, onAbort: undefined as (() => void) | undefined };
      entry.onAbort = () => {
        const index = this.queue.indexOf(entry);
        if (index !== -1) this.queue.splice(index, 1);
        reject(new Error("aborted"));
      };
      signal?.addEventListener("abort", entry.onAbort, { once: true });
      this.queue.push(entry);
    });
  }

  private releaseOnce(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active -= 1;
      this.drain();
    };
  }

  private drain(): void {
    while (this.active < this.max && this.queue.length > 0) {
      const entry = this.queue.shift()!;
      if (entry.onAbort) entry.signal?.removeEventListener("abort", entry.onAbort);
      if (entry.signal?.aborted) {
        entry.reject(new Error("aborted"));
        continue;
      }
      this.active += 1;
      entry.resolve(this.releaseOnce());
    }
  }
}
