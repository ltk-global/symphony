import { readFile } from "node:fs/promises";
import YAML from "yaml";

export interface AggregatorConfig {
  port: number;
  host: string;
  pollIntervalMs: number;
  pollTimeoutMs: number;
  recentEventsLimit: number;
  refreshIntervalSec: number;
  daemons: Array<{ name: string; url: string }>;
}

export async function loadAggregatorConfig(path: string): Promise<AggregatorConfig> {
  const source = await readFile(path, "utf8");
  return parseAggregatorConfig(source);
}

export function parseAggregatorConfig(source: string): AggregatorConfig {
  const raw = source.trim() ? YAML.parse(source) : {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("invalid_aggregator_config");
  const r = raw as Record<string, unknown>;

  const daemonsRaw = r.daemons;
  if (!Array.isArray(daemonsRaw) || daemonsRaw.length === 0) throw new Error("aggregator_config_missing_daemons");
  const seen = new Set<string>();
  const daemons = daemonsRaw.map((entry, index) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new Error(`invalid_aggregator_daemon[${index}]`);
    const e = entry as Record<string, unknown>;
    const name = typeof e.name === "string" && e.name.length > 0 ? e.name : `daemon_${index + 1}`;
    if (seen.has(name)) throw new Error(`duplicate_aggregator_daemon_name:${name}`);
    seen.add(name);
    const url = typeof e.url === "string" ? e.url.trim() : "";
    if (!url) throw new Error(`invalid_aggregator_daemon_url[${index}]`);
    try {
      const parsed = new URL(url);
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error("non_http_url");
    } catch {
      throw new Error(`invalid_aggregator_daemon_url[${index}]:${url}`);
    }
    return { name, url: url.replace(/\/$/, "") };
  });

  return {
    port: positiveInt(r.port, 9000, "invalid_aggregator_port"),
    host: typeof r.host === "string" && r.host.length > 0 ? r.host : "127.0.0.1",
    pollIntervalMs: positiveInt(r.poll_interval_ms, 5_000, "invalid_aggregator_poll_interval_ms"),
    pollTimeoutMs: positiveInt(r.poll_timeout_ms, 3_000, "invalid_aggregator_poll_timeout_ms"),
    recentEventsLimit: positiveInt(r.recent_events_limit, 50, "invalid_aggregator_recent_events_limit"),
    refreshIntervalSec: positiveInt(r.refresh_interval_sec, 5, "invalid_aggregator_refresh_interval_sec"),
    daemons,
  };
}

function positiveInt(value: unknown, fallback: number, errorCode: string): number {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0 || !Number.isInteger(value)) throw new Error(errorCode);
  return value;
}
