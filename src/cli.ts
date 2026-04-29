#!/usr/bin/env node
import { Command } from "commander";
import { log } from "./log.js";
import { SymphonyRuntime } from "./runtime.js";

const program = new Command();

program
  .name("symphony")
  .option("-w, --workflow <path>", "path to WORKFLOW.md", "WORKFLOW.md")
  .option("--once", "run one polling tick and exit")
  .action(async (opts: { workflow: string; once?: boolean }) => {
    const runtime = new SymphonyRuntime(opts.workflow);
    await runtime.initialize();

    if (opts.once) {
      await runtime.tick();
      log.info({ snapshot: runtime.snapshot() }, "tick complete");
      return;
    }

    await runtime.tick();
    const schedule = () => {
      setTimeout(() => {
        runtime
          .tick()
          .catch((error) => log.error({ error }, "poll tick failed"))
          .finally(schedule);
      }, runtime.pollIntervalMs());
    };
    schedule();
  });

await program.parseAsync();
