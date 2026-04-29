import { appendFile, mkdir } from "node:fs/promises";
import { createReadStream, existsSync } from "node:fs";
import { createInterface } from "node:readline";
import { dirname } from "node:path";
import { log } from "../log.js";

export interface SymphonyEvent {
  ts: string;
  type: string;
  issueId?: string;
  issueIdentifier?: string;
  sessionId?: string;
  turnSeq?: number;
  payload?: Record<string, unknown>;
}

export type EventInput = Omit<SymphonyEvent, "ts">;

export interface EventLog {
  emit(event: EventInput): Promise<void>;
  drain(): Promise<void>;
  read(filter?: EventReadFilter): AsyncIterable<SymphonyEvent>;
}

export interface EventReadFilter {
  issueId?: string;
  issueIdentifier?: string;
  type?: string | string[];
  sessionId?: string;
}

export class FileEventLog implements EventLog {
  private writes: Promise<void> = Promise.resolve();
  private dirEnsured = false;

  constructor(private readonly path: string) {}

  async emit(event: EventInput): Promise<void> {
    const line = JSON.stringify({ ts: new Date().toISOString(), ...event }) + "\n";
    this.writes = this.writes
      .then(async () => {
        if (!this.dirEnsured) {
          await mkdir(dirname(this.path), { recursive: true });
          this.dirEnsured = true;
        }
        await appendFile(this.path, line);
      })
      .catch((error) => {
        log.error({ error, path: this.path }, "event_log write failed");
      });
    await this.writes;
  }

  async drain(): Promise<void> {
    await this.writes;
  }

  async *read(filter?: EventReadFilter): AsyncIterable<SymphonyEvent> {
    if (!existsSync(this.path)) return;
    const stream = createReadStream(this.path, { encoding: "utf8" });
    const rl = createInterface({ input: stream, crlfDelay: Infinity });
    const types = filter?.type ? new Set(Array.isArray(filter.type) ? filter.type : [filter.type]) : null;
    for await (const line of rl) {
      if (!line) continue;
      let event: SymphonyEvent;
      try {
        event = JSON.parse(line) as SymphonyEvent;
      } catch {
        continue;
      }
      if (filter?.issueId && event.issueId !== filter.issueId) continue;
      if (filter?.issueIdentifier && event.issueIdentifier !== filter.issueIdentifier) continue;
      if (filter?.sessionId && event.sessionId !== filter.sessionId) continue;
      if (types && !types.has(event.type)) continue;
      yield event;
    }
  }
}

export class MemoryEventLog implements EventLog {
  private readonly events: SymphonyEvent[] = [];

  async emit(event: EventInput): Promise<void> {
    this.events.push({ ts: new Date().toISOString(), ...event });
  }

  async drain(): Promise<void> {}

  async *read(filter?: EventReadFilter): AsyncIterable<SymphonyEvent> {
    const types = filter?.type ? new Set(Array.isArray(filter.type) ? filter.type : [filter.type]) : null;
    for (const event of this.events) {
      if (filter?.issueId && event.issueId !== filter.issueId) continue;
      if (filter?.issueIdentifier && event.issueIdentifier !== filter.issueIdentifier) continue;
      if (filter?.sessionId && event.sessionId !== filter.sessionId) continue;
      if (types && !types.has(event.type)) continue;
      yield event;
    }
  }

  snapshot(): SymphonyEvent[] {
    return this.events.slice();
  }
}
