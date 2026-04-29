#!/usr/bin/env node
import { Command } from "commander";
import { log } from "./log.js";
import { loadAggregatorConfig } from "./aggregator/config.js";
import { startAggregator, type AggregatorServer } from "./aggregator/index.js";

const program = new Command();

program
  .name("symphony-aggregator")
  .description("Cross-daemon dashboard. Polls each daemon's /api/v1/state, serves a unified view.")
  .requiredOption("-c, --config <path>", "path to aggregator config YAML")
  .option("--port <port>", "override port from config", parseInt)
  .action(async (opts: { config: string; port?: number }) => {
    const config = await loadAggregatorConfig(opts.config);
    if (opts.port !== undefined) config.port = opts.port;
    const server: AggregatorServer = await startAggregator(config);

    const shutdown = async (signal: string) => {
      log.info({ signal }, "aggregator shutting down");
      try {
        await server.close();
      } catch (error) {
        log.warn({ error }, "aggregator close failed");
      }
      process.exit(0);
    };
    process.on("SIGINT", () => void shutdown("SIGINT"));
    process.on("SIGTERM", () => void shutdown("SIGTERM"));
  });

await program.parseAsync();
