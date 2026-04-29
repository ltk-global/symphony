import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { log } from "../log.js";
import type { AggregatorConfig } from "./config.js";
import { DaemonPoller } from "./poller.js";
import { aggregateTotals, mergedRecentEvents, renderAggregator } from "./render.js";

export interface AggregatorServer {
  readonly port: number;
  readonly host: string;
  close(): Promise<void>;
}

export async function startAggregator(config: AggregatorConfig, opts: { fetchImpl?: typeof fetch } = {}): Promise<AggregatorServer> {
  const poller = new DaemonPoller({
    daemons: config.daemons,
    intervalMs: config.pollIntervalMs,
    timeoutMs: config.pollTimeoutMs,
    fetchImpl: opts.fetchImpl,
  });
  poller.start();

  const server = createServer((req, res) => {
    handle(req, res, config, poller).catch((error) => {
      log.error({ error, url: req.url }, "aggregator request failed");
      sendJson(res, 500, { error: { code: "internal", message: error instanceof Error ? error.message : String(error) } });
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(config.port, config.host, () => resolve());
  });
  const address = server.address();
  const boundPort = typeof address === "object" && address ? address.port : config.port;
  log.info({ host: config.host, port: boundPort, daemons: config.daemons.length }, "aggregator listening");

  return {
    host: config.host,
    port: boundPort,
    close: async () => {
      poller.stop();
      await closeServer(server);
    },
  };
}

async function handle(req: IncomingMessage, res: ServerResponse, config: AggregatorConfig, poller: DaemonPoller): Promise<void> {
  const url = new URL(req.url ?? "/", "http://localhost");
  const pathname = url.pathname;

  if (pathname === "/" && req.method === "GET") {
    const html = renderAggregator({
      daemons: poller.snapshot(),
      now: new Date(),
      refreshIntervalSec: config.refreshIntervalSec,
      recentEventsLimit: config.recentEventsLimit,
    });
    sendHtml(res, 200, html);
    return;
  }

  if (pathname === "/api/v1/state" && req.method === "GET") {
    const daemons = poller.snapshot();
    const totals = aggregateTotals(daemons);
    const recentEvents = mergedRecentEvents(daemons, config.recentEventsLimit);
    sendJson(res, 200, {
      generatedAt: new Date().toISOString(),
      counts: { running: totals.running, retrying: totals.retrying, daemons: daemons.length, reachable: daemons.filter((d) => d.reachable).length },
      tokens: totals.tokens,
      daemons,
      recentEvents,
    });
    return;
  }

  if (pathname === "/api/v1/refresh" && req.method === "POST") {
    void poller.pollOnce();
    sendJson(res, 202, { queued: true, requestedAt: new Date().toISOString(), operations: ["poll_all"] });
    return;
  }

  if (req.method === "GET" || req.method === "POST" || req.method === "HEAD") {
    sendJson(res, 404, { error: { code: "not_found", message: `no route for ${req.method} ${pathname}` } });
    return;
  }
  res.setHeader("allow", "GET, POST, HEAD");
  sendJson(res, 405, { error: { code: "method_not_allowed", message: "unsupported method" } });
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
