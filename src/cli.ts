#!/usr/bin/env node
import { Command } from "commander";
import { log } from "./log.js";
import { SymphonyRuntime } from "./runtime.js";
import { startConsoleServer, type ConsoleServer } from "./server/index.js";
import { buildRecipeCommand } from "./workspace/recipes_cli.js";

const program = new Command();
program.name("symphony");

// `symphony recipe …` — operator inspection of the workspace-cache recipes.
program.addCommand(buildRecipeCommand());

program
  .command("daemon", { isDefault: true })
  .description("Run the Symphony daemon (default).")
  .option("-w, --workflow <path>", "path to WORKFLOW.md", "WORKFLOW.md")
  .option("--once", "run one polling tick and exit")
  .option("--port <port>", "enable the operator console HTTP server on this port (overrides server.port in workflow)", parseInt)
  .action(async (opts: { workflow: string; once?: boolean; port?: number }) => {
    const runtime = new SymphonyRuntime(opts.workflow);
    await runtime.initialize();

    let server: ConsoleServer | null = null;
    if (!opts.once) {
      const config = runtime.serviceConfig();
      const port = opts.port ?? config?.server.port ?? null;
      if (port !== null && config) {
        server = await startConsoleServer({
          port,
          host: config.server.host,
          refreshIntervalSec: config.server.refreshIntervalSec,
          recentEventsLimit: config.server.recentEventsLimit,
          workflowPath: opts.workflow,
          dataDir: config.dataDir,
          orchestrator: runtime.orchestratorRef()!,
        });
      }
    }

    if (opts.once) {
      await runtime.tick();
      log.info({ snapshot: runtime.snapshot() }, "tick complete");
      return;
    }

    await runtime.tick().catch((error) => log.error({ error }, "initial poll tick failed; daemon continuing"));
    const schedule = () => {
      setTimeout(() => {
        runtime
          .tick()
          .catch((error) => log.error({ error }, "poll tick failed"))
          .finally(schedule);
      }, runtime.pollIntervalMs());
    };
    schedule();

    const shutdown = async (signal: string) => {
      log.info({ signal }, "shutting down");
      try {
        await server?.close();
      } catch (error) {
        log.warn({ error }, "console_server close failed");
      }
      process.exit(0);
    };
    process.on("SIGINT", () => void shutdown("SIGINT"));
    process.on("SIGTERM", () => void shutdown("SIGTERM"));
  });

await program.parseAsync();
