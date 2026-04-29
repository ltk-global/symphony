import { log } from "../log.js";
import type { SnapshotShape } from "../server/render.js";
import type { SymphonyEvent } from "../observability/event_log.js";

export interface RemoteState extends SnapshotShape {
  workflowPath?: string;
  dataDir?: string;
  recentEvents?: SymphonyEvent[];
}

export interface DaemonStatus {
  name: string;
  url: string;
  reachable: boolean;
  lastSeenAt: string | null;
  lastFailureAt: string | null;
  lastError: string | null;
  state: RemoteState | null;
}

export interface DaemonPollerOptions {
  daemons: Array<{ name: string; url: string }>;
  intervalMs: number;
  timeoutMs: number;
  fetchImpl?: typeof fetch;
}

export class DaemonPoller {
  private readonly fetchImpl: typeof fetch;
  private readonly statuses = new Map<string, DaemonStatus>();
  private readonly inflight = new Set<string>();
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly options: DaemonPollerOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    for (const daemon of options.daemons) {
      this.statuses.set(daemon.name, {
        name: daemon.name,
        url: daemon.url,
        reachable: false,
        lastSeenAt: null,
        lastFailureAt: null,
        lastError: null,
        state: null,
      });
    }
  }

  start(): void {
    if (this.timer) return;
    void this.pollAll();
    this.timer = setInterval(() => void this.pollAll(), this.options.intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  snapshot(): DaemonStatus[] {
    return [...this.statuses.values()];
  }

  async pollOnce(): Promise<DaemonStatus[]> {
    await this.pollAll();
    return this.snapshot();
  }

  private async pollAll(): Promise<void> {
    await Promise.all(this.options.daemons.map((daemon) => this.pollOne(daemon)));
  }

  private async pollOne(daemon: { name: string; url: string }): Promise<void> {
    if (this.inflight.has(daemon.name)) return;
    this.inflight.add(daemon.name);
    const status = this.statuses.get(daemon.name)!;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.options.timeoutMs);
    try {
      const response = await this.fetchImpl(`${daemon.url}/api/v1/state`, { signal: controller.signal });
      if (!response.ok) throw new Error(`http_${response.status}`);
      const body = (await response.json()) as RemoteState;
      status.reachable = true;
      status.lastSeenAt = new Date().toISOString();
      status.lastError = null;
      status.state = body;
    } catch (error) {
      status.reachable = false;
      status.lastFailureAt = new Date().toISOString();
      status.lastError = error instanceof Error ? error.message : String(error);
      log.warn({ daemon: daemon.name, url: daemon.url, error: status.lastError }, "aggregator poll failed");
    } finally {
      clearTimeout(timer);
      this.inflight.delete(daemon.name);
    }
  }
}
