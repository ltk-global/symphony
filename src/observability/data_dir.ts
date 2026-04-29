import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

export function defaultDataDir(workflowPath: string): string {
  if (!workflowPath) return join(homedir(), ".symphony", "default");
  const hash = createHash("sha256").update(resolve(workflowPath)).digest("hex").slice(0, 12);
  return join(homedir(), ".symphony", hash);
}

export function eventLogPath(dataDir: string): string {
  return join(dataDir, "events.jsonl");
}

export function turnLogPath(dataDir: string, issueId: string, sessionId: string): string {
  const safeIssue = issueId.replace(/[^A-Za-z0-9._-]/g, "_");
  const safeSession = sessionId.replace(/[^A-Za-z0-9._-]/g, "_");
  return join(dataDir, "turns", safeIssue, `${safeSession}.jsonl`);
}
