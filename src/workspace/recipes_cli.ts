// Operator-facing CLI for the recipe cache. Exposed via `symphony recipe …`
// in src/cli.ts. Stays self-contained: no daemon imports, no runtime deps —
// just synchronous fs work against `~/.symphony-cache/recipes/<stem>.{sh,json}`.
//
// All paths derive from SYMPHONY_CACHE_DIR (test seam) → fall back to
// ~/.symphony-cache. The `<stem>` shape is owned by `recipeStem` in
// src/workspace/recipes.ts; both sides import from there.
import { Command } from "commander";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { recipeStem } from "./recipes.js";

// All on-disk suffixes the cache can carry for a given stem. Iteration order
// matters for `regen`/`quarantine` cleanup but not for the others.
const ALL_SUFFIXES = [".sh", ".json", ".sh.pending", ".json.pending", ".quarantined"] as const;
const NON_QUARANTINE_SUFFIXES = [".sh", ".json", ".sh.pending", ".json.pending"] as const;

type RecipeStatus = "final" | "pending" | "quarantined";

function cacheRoot(): string {
  return process.env.SYMPHONY_CACHE_DIR || join(homedir(), ".symphony-cache");
}

function recipesDir(): string {
  return join(cacheRoot(), "recipes");
}

interface RecipeEntry {
  stem: string;
  sh: string;
  json: string;
  status: RecipeStatus;
  manifest: Record<string, unknown> | null;
  ageHours: number | null;
}

function listRecipes(): RecipeEntry[] {
  const dir = recipesDir();
  if (!existsSync(dir)) return [];
  const stems = new Set<string>();
  for (const name of readdirSync(dir)) {
    if (name.endsWith(".sh.pending")) stems.add(name.slice(0, -".sh.pending".length));
    else if (name.endsWith(".sh")) stems.add(name.slice(0, -".sh".length));
    else if (name.endsWith(".quarantined")) stems.add(name.slice(0, -".quarantined".length));
  }
  const entries: RecipeEntry[] = [];
  for (const stem of stems) {
    const sh = join(dir, `${stem}.sh`);
    const shPending = join(dir, `${stem}.sh.pending`);
    const quarantined = join(dir, `${stem}.quarantined`);
    let status: RecipeEntry["status"];
    let activeJson: string | null = null;
    let activeSh: string;
    if (existsSync(quarantined)) {
      status = "quarantined";
      activeSh = quarantined;
    } else if (existsSync(shPending)) {
      status = "pending";
      activeSh = shPending;
      activeJson = join(dir, `${stem}.json.pending`);
    } else if (existsSync(sh)) {
      status = "final";
      activeSh = sh;
      activeJson = join(dir, `${stem}.json`);
    } else {
      continue;
    }
    let manifest: Record<string, unknown> | null = null;
    let ageHours: number | null = null;
    if (activeJson && existsSync(activeJson)) {
      try {
        manifest = JSON.parse(readFileSync(activeJson, "utf8"));
        const ts = manifest && typeof manifest.generatedAt === "string"
          ? new Date(manifest.generatedAt).getTime()
          : NaN;
        if (Number.isFinite(ts)) ageHours = (Date.now() - ts) / 3_600_000;
      } catch {}
    } else if (status === "quarantined") {
      // Synthesize a minimal manifest from the marker file so list still shows
      // a row.
      try {
        manifest = JSON.parse(readFileSync(quarantined, "utf8"));
      } catch {
        manifest = null;
      }
    }
    entries.push({ stem, sh: activeSh, json: activeJson ?? "", status, manifest, ageHours });
  }
  return entries.sort((a, b) => a.stem.localeCompare(b.stem));
}

function findEntry(repo: string): RecipeEntry | null {
  const stem = recipeStem(repo);
  // Caller may pass either the original `repoFullName` (preferred) or a
  // sanitized form; try both.
  const all = listRecipes();
  return (
    all.find((e) => e.stem === stem)
    ?? all.find((e) => e.stem.startsWith(`${repo.replace(/[^A-Za-z0-9._-]/g, "_")}.`))
    ?? null
  );
}

// Resolve a user-supplied repo identifier to the stem actually on disk.
// Prefers the exact-match canonical stem; falls back to the sanitized-prefix
// match for cases where the operator typed a slightly different repo name.
function resolveStem(repo: string): string | null {
  const e = findEntry(repo);
  return e ? e.stem : null;
}

function fmtAge(ageHours: number | null): string {
  if (ageHours === null) return "unknown";
  if (ageHours < 1) return `${Math.round(ageHours * 60)}m`;
  if (ageHours < 48) return `${Math.round(ageHours)}h`;
  return `${Math.round(ageHours / 24)}d`;
}

function cmdList(): number {
  const all = listRecipes();
  if (all.length === 0) {
    console.log("No recipes cached.");
    return 0;
  }
  console.log(`${all.length} recipes in ${recipesDir()}:`);
  for (const e of all) {
    const repoFullName = (e.manifest?.repoFullName as string | undefined) ?? "?";
    console.log(`  [${e.status.padEnd(11)}] ${repoFullName}  age=${fmtAge(e.ageHours)}  stem=${e.stem}`);
  }
  return 0;
}

function cmdShow(repo: string): number {
  const e = findEntry(repo);
  if (!e) {
    console.error(`No recipe found for ${repo}`);
    return 1;
  }
  console.log(`# ${e.sh}`);
  if (existsSync(e.sh)) console.log(readFileSync(e.sh, "utf8"));
  if (e.json && existsSync(e.json)) {
    console.log(`\n# Manifest: ${e.json}`);
    console.log(readFileSync(e.json, "utf8"));
  }
  return 0;
}

function cmdApprove(repo: string): number {
  const stem = recipeStem(repo);
  const dir = recipesDir();
  const shPending = join(dir, `${stem}.sh.pending`);
  const jsonPending = join(dir, `${stem}.json.pending`);
  if (!existsSync(shPending)) {
    // Try sanitized fallback: lookup via list.
    const e = findEntry(repo);
    if (!e || e.status !== "pending") {
      console.error(`No pending recipe found for ${repo}`);
      return 1;
    }
    renameSync(e.sh, e.sh.replace(/\.pending$/, ""));
    if (e.json && existsSync(e.json)) renameSync(e.json, e.json.replace(/\.pending$/, ""));
    console.log(`approved ${repo}`);
    return 0;
  }
  renameSync(shPending, join(dir, `${stem}.sh`));
  if (existsSync(jsonPending)) renameSync(jsonPending, join(dir, `${stem}.json`));
  console.log(`approved ${repo}`);
  return 0;
}

function cmdReject(repo: string): number {
  const e = findEntry(repo);
  if (!e || e.status !== "pending") {
    console.error(`No pending recipe found for ${repo}`);
    return 1;
  }
  if (existsSync(e.sh)) unlinkSync(e.sh);
  if (e.json && existsSync(e.json)) unlinkSync(e.json);
  console.log(`rejected ${repo}`);
  return 0;
}

function cmdRegen(repo: string): number {
  const stem = resolveStem(repo) ?? recipeStem(repo);
  const dir = recipesDir();
  let removed = 0;
  for (const suffix of ALL_SUFFIXES) {
    const p = join(dir, `${stem}${suffix}`);
    if (existsSync(p)) {
      unlinkSync(p);
      removed += 1;
    }
  }
  if (removed === 0) {
    console.error(`No recipe found for ${repo}`);
    return 1;
  }
  console.log(`regen ${repo} — next dispatch will regenerate`);
  return 0;
}

function cmdQuarantine(repo: string): number {
  const dir = recipesDir();
  mkdirSync(dir, { recursive: true });
  // Use the existing entry's stem if any, else canonical — quarantining a
  // repo before any recipe is generated is a valid pre-emptive action.
  const stem = resolveStem(repo) ?? recipeStem(repo);
  const marker = join(dir, `${stem}.quarantined`);
  writeFileSync(marker, JSON.stringify({
    schema: "symphony.recipe.v1",
    repoFullName: repo,
    quarantinedAt: new Date().toISOString(),
  }, null, 2));
  for (const suffix of NON_QUARANTINE_SUFFIXES) {
    const p = join(dir, `${stem}${suffix}`);
    if (existsSync(p)) unlinkSync(p);
  }
  console.log(`quarantined ${repo}`);
  return 0;
}

function cmdPrune(force: boolean): number {
  const dir = recipesDir();
  if (!existsSync(dir)) {
    console.log("Nothing to prune.");
    return 0;
  }
  if (!force) {
    console.error("Refusing to prune without --force. Use `symphony recipe prune --force`.");
    return 1;
  }
  let removed = 0;
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    try {
      if (statSync(p).isFile()) { unlinkSync(p); removed += 1; }
    } catch {}
  }
  console.log(`pruned ${removed} files from ${dir}`);
  return 0;
}

export function buildRecipeCommand(): Command {
  const cmd = new Command("recipe").description("Inspect and manage the workspace recipe cache.");
  cmd.command("list").description("List recipes with status, repo, and age").action(() => process.exit(cmdList()));
  cmd.command("show <repo>").description("Print a recipe + manifest").action((repo: string) => process.exit(cmdShow(repo)));
  cmd.command("approve <repo>").description("Promote a pending recipe to final").action((repo: string) => process.exit(cmdApprove(repo)));
  cmd.command("reject <repo>").description("Delete a pending recipe").action((repo: string) => process.exit(cmdReject(repo)));
  cmd.command("regen <repo>").description("Force regeneration on next dispatch").action((repo: string) => process.exit(cmdRegen(repo)));
  cmd.command("quarantine <repo>").description("Mark recipe quarantined; daemon falls back to canned template").action((repo: string) => process.exit(cmdQuarantine(repo)));
  cmd.command("prune").description("Remove all cached recipes").option("--force", "actually delete", false).action((opts: { force: boolean }) => process.exit(cmdPrune(!!opts.force)));
  return cmd;
}

