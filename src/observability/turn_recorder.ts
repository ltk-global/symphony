import { createWriteStream, type WriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";

export interface TurnSink {
  readonly path: string;
  write(line: string): void;
  close(): Promise<void>;
}

export class TurnRecorder {
  private turnSeq = 0;

  constructor(private readonly options: { dataDir: string; issueId: string }) {}

  async open(): Promise<TurnSink> {
    this.turnSeq += 1;
    const path = turnFilePath(this.options.dataDir, this.options.issueId, this.turnSeq);
    await mkdir(dirname(path), { recursive: true });
    let stream: WriteStream | null = createWriteStream(path, { flags: "a", encoding: "utf8" });
    let closed = false;
    return {
      path,
      write(line: string) {
        if (!stream || closed) return;
        const payload = line.endsWith("\n") ? line : `${line}\n`;
        stream.write(payload);
      },
      async close() {
        if (closed || !stream) return;
        closed = true;
        await new Promise<void>((resolve) => {
          stream!.end(() => resolve());
        });
        stream = null;
      },
    };
  }
}

export function turnFilePath(dataDir: string, issueId: string, turnSeq: number): string {
  const safeIssue = issueId.replace(/[^A-Za-z0-9._-]/g, "_");
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  return join(dataDir, "turns", safeIssue, `${ts}-t${turnSeq}.jsonl`);
}
