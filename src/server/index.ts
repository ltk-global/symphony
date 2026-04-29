import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { existsSync, statSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { log } from "../log.js";
import { eventLogPath } from "../observability/data_dir.js";
import { FileEventLog, type SymphonyEvent } from "../observability/event_log.js";
import { renderIndex, renderIssue, renderTurn } from "./render.js";
import type { Orchestrator } from "../orchestrator/index.js";

export interface ConsoleServerOptions {
  port: number;
  host?: string;
  refreshIntervalSec?: number;
  recentEventsLimit?: number;
  workflowPath: string;
  dataDir: string;
  orchestrator: Pick<Orchestrator, "snapshot" | "tick">;
}

export interface ConsoleServer {
  readonly port: number;
  readonly host: string;
  close(): Promise<void>;
}

export async function startConsoleServer(options: ConsoleServerOptions): Promise<ConsoleServer> {
  const host = options.host ?? "127.0.0.1";
  const refresh = options.refreshIntervalSec ?? 5;
  const recentLimit = options.recentEventsLimit ?? 50;
  const eventLog = new FileEventLog(eventLogPath(options.dataDir));

  const server = createServer((req, res) => {
    handleRequest(req, res, {
      orchestrator: options.orchestrator,
      eventLog,
      refresh,
      recentLimit,
      workflowPath: options.workflowPath,
      dataDir: options.dataDir,
    }).catch((error) => {
      log.error({ error, url: req.url }, "console_server request failed");
      sendJson(res, 500, { error: { code: "internal", message: error instanceof Error ? error.message : String(error) } });
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, host, () => resolve());
  });
  const address = server.address();
  const boundPort = typeof address === "object" && address ? address.port : options.port;
  log.info({ host, port: boundPort, dataDir: options.dataDir }, "console_server listening");

  return {
    host,
    port: boundPort,
    close: () => closeServer(server),
  };
}

interface RequestContext {
  orchestrator: Pick<Orchestrator, "snapshot" | "tick">;
  eventLog: FileEventLog;
  refresh: number;
  recentLimit: number;
  workflowPath: string;
  dataDir: string;
}

async function handleRequest(req: IncomingMessage, res: ServerResponse, ctx: RequestContext): Promise<void> {
  const url = new URL(req.url ?? "/", "http://localhost");
  const pathname = url.pathname;

  if (pathname === "/" && req.method === "GET") return renderIndexResponse(res, ctx);
  if (pathname === "/api/v1/state" && req.method === "GET") return apiState(res, ctx);
  if (pathname === "/api/v1/refresh" && req.method === "POST") return apiRefresh(res, ctx);

  const issueMatch = pathname.match(/^\/issues\/([^/]+)$/);
  if (issueMatch) {
    if (req.method !== "GET" && req.method !== "HEAD") return methodNotAllowed(res);
    const identifier = decodeSegment(issueMatch[1]!);
    if (identifier === null) return badPath(res);
    return renderIssueResponse(res, ctx, identifier);
  }

  const apiIssueMatch = pathname.match(/^\/api\/v1\/issues\/([^/]+)$/);
  if (apiIssueMatch) {
    if (req.method !== "GET" && req.method !== "HEAD") return methodNotAllowed(res);
    const identifier = decodeSegment(apiIssueMatch[1]!);
    if (identifier === null) return badPath(res);
    return apiIssue(res, ctx, identifier);
  }

  const turnMatch = pathname.match(/^\/issues\/([^/]+)\/turns\/([^/]+)$/);
  if (turnMatch) {
    if (req.method !== "GET" && req.method !== "HEAD") return methodNotAllowed(res);
    const identifier = decodeSegment(turnMatch[1]!);
    const fileName = decodeSegment(turnMatch[2]!);
    if (identifier === null || fileName === null) return badPath(res);
    return renderTurnResponse(res, ctx, identifier, fileName);
  }

  if (req.method === "POST" || req.method === "GET" || req.method === "HEAD") {
    return sendJson(res, 404, { error: { code: "not_found", message: `no route for ${req.method} ${pathname}` } });
  }
  return methodNotAllowed(res);
}

function decodeSegment(segment: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(segment);
  } catch {
    return null;
  }
  if (decoded.length === 0) return null;
  if (decoded.includes("/") || decoded.includes("\\") || decoded.includes("..")) return null;
  if (decoded.includes("\0")) return null;
  return decoded;
}

function badPath(res: ServerResponse): void {
  sendJson(res, 400, { error: { code: "bad_path", message: "segment contained traversal or path separator" } });
}

function methodNotAllowed(res: ServerResponse): void {
  res.setHeader("allow", "GET, POST, HEAD");
  sendJson(res, 405, { error: { code: "method_not_allowed", message: "unsupported method" } });
}

async function renderIndexResponse(res: ServerResponse, ctx: RequestContext): Promise<void> {
  const snapshot = ctx.orchestrator.snapshot();
  const recentEvents = await readTailEvents(ctx, ctx.recentLimit);
  const html = renderIndex({
    snapshot,
    recentEvents,
    workflowPath: ctx.workflowPath,
    dataDir: ctx.dataDir,
    now: new Date(),
    refreshIntervalSec: ctx.refresh,
  });
  sendHtml(res, 200, html);
}

async function renderIssueResponse(res: ServerResponse, ctx: RequestContext, identifier: string): Promise<void> {
  const snapshot = ctx.orchestrator.snapshot();
  const liveSession = snapshot.runningSessions.find((row) => row.identifier === identifier) ?? null;
  const retryEntry = snapshot.retrying.find((row) => row.identifier === identifier) ?? null;
  const events = await readEventsForIdentifier(ctx, identifier);
  const turnFiles = liveSession
    ? await listTurnFiles(ctx.dataDir, liveSession.issueId)
    : await listTurnFilesByIdentifierFromEvents(ctx.dataDir, events);
  const html = renderIssue({
    identifier,
    events,
    liveSession,
    retryEntry: retryEntry ? { attempt: retryEntry.attempt, dueAtMs: retryEntry.dueAtMs, error: retryEntry.error } : null,
    turnFiles,
    workflowPath: ctx.workflowPath,
    dataDir: ctx.dataDir,
    now: new Date(),
    refreshIntervalSec: ctx.refresh,
  });
  sendHtml(res, 200, html);
}

async function renderTurnResponse(res: ServerResponse, ctx: RequestContext, identifier: string, fileName: string): Promise<void> {
  const snapshot = ctx.orchestrator.snapshot();
  const liveSession = snapshot.runningSessions.find((row) => row.identifier === identifier) ?? null;
  const events = liveSession ? [] : await readEventsForIdentifier(ctx, identifier);
  const issueId = liveSession?.issueId ?? identifierToIssueIdFromEvents(events);
  if (!issueId) return sendJson(res, 404, { error: { code: "issue_not_found", message: `no issue events for ${identifier}` } });
  const safeIssue = issueId.replace(/[^A-Za-z0-9._-]/g, "_");
  const filePath = join(ctx.dataDir, "turns", safeIssue, fileName);
  if (!existsSync(filePath)) {
    return sendJson(res, 404, { error: { code: "turn_not_found", message: `no turn file at ${filePath}` } });
  }
  const content = await readFile(filePath, "utf8");
  sendHtml(
    res,
    200,
    renderTurn({ identifier, fileName, content, byteLength: Buffer.byteLength(content, "utf8") }),
  );
}

async function apiState(res: ServerResponse, ctx: RequestContext): Promise<void> {
  const snapshot = ctx.orchestrator.snapshot();
  const recentEvents = await readTailEvents(ctx, ctx.recentLimit);
  sendJson(res, 200, {
    generatedAt: new Date().toISOString(),
    workflowPath: ctx.workflowPath,
    dataDir: ctx.dataDir,
    counts: { running: snapshot.running, retrying: snapshot.retrying.length },
    running: snapshot.runningSessions,
    retrying: snapshot.retrying,
    codexTotals: snapshot.codexTotals,
    recentEvents,
  });
}

async function apiIssue(res: ServerResponse, ctx: RequestContext, identifier: string): Promise<void> {
  const snapshot = ctx.orchestrator.snapshot();
  const liveSession = snapshot.runningSessions.find((row) => row.identifier === identifier) ?? null;
  const retryEntry = snapshot.retrying.find((row) => row.identifier === identifier) ?? null;
  const events = await readEventsForIdentifier(ctx, identifier);
  const issueId = liveSession?.issueId ?? identifierToIssueIdFromEvents(events);
  const turnFiles = issueId ? await listTurnFiles(ctx.dataDir, issueId) : [];
  if (!liveSession && !retryEntry && events.length === 0) {
    return sendJson(res, 404, { error: { code: "issue_not_found", message: `no live, retry, or historical record for ${identifier}` } });
  }
  sendJson(res, 200, {
    identifier,
    issueId,
    live: liveSession,
    retry: retryEntry,
    events,
    turnFiles,
  });
}

async function apiRefresh(res: ServerResponse, ctx: RequestContext): Promise<void> {
  void ctx.orchestrator.tick().catch((error) => log.error({ error }, "manual refresh tick failed"));
  sendJson(res, 202, {
    queued: true,
    requestedAt: new Date().toISOString(),
    operations: ["poll", "reconcile"],
  });
}

async function readTailEvents(ctx: RequestContext, limit: number): Promise<SymphonyEvent[]> {
  const buffer: SymphonyEvent[] = [];
  for await (const event of ctx.eventLog.read()) {
    buffer.push(event);
    if (buffer.length > limit * 4) buffer.splice(0, buffer.length - limit);
  }
  return buffer.slice(-limit).reverse();
}

async function readEventsForIdentifier(ctx: RequestContext, identifier: string): Promise<SymphonyEvent[]> {
  const events: SymphonyEvent[] = [];
  for await (const event of ctx.eventLog.read({ issueIdentifier: identifier })) {
    events.push(event);
  }
  return events;
}

async function listTurnFiles(dataDir: string, issueId: string): Promise<Array<{ name: string; relPath: string; sizeBytes: number; mtimeMs: number }>> {
  const safeIssue = issueId.replace(/[^A-Za-z0-9._-]/g, "_");
  const dir = join(dataDir, "turns", safeIssue);
  if (!existsSync(dir)) return [];
  const entries = await readdir(dir, { withFileTypes: true });
  const files = entries.filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl"));
  return files
    .map((entry) => {
      const path = join(dir, entry.name);
      const stat = statSync(path);
      return { name: entry.name, relPath: join("turns", safeIssue, entry.name), sizeBytes: stat.size, mtimeMs: stat.mtimeMs };
    })
    .sort((a, b) => b.mtimeMs - a.mtimeMs);
}

async function listTurnFilesByIdentifierFromEvents(dataDir: string, events: SymphonyEvent[]): Promise<Array<{ name: string; relPath: string; sizeBytes: number; mtimeMs: number }>> {
  const issueId = identifierToIssueIdFromEvents(events);
  if (!issueId) return [];
  return listTurnFiles(dataDir, issueId);
}

function identifierToIssueIdFromEvents(events: SymphonyEvent[]): string | null {
  for (const event of events) if (event.issueId) return event.issueId;
  return null;
}

function sendHtml(res: ServerResponse, status: number, body: string): void {
  res.statusCode = status;
  res.setHeader("content-type", "text/html; charset=utf-8");
  res.setHeader("cache-control", "no-store");
  res.end(body);
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.setHeader("cache-control", "no-store");
  res.end(JSON.stringify(body, null, 2));
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}
