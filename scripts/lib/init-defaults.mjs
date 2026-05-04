// Pure helpers used by scripts/init.mjs. Kept dependency-free so they can be
// unit-tested without spinning up a fake readline / GitHub.

const ACTIVE_RE = /todo|in progress|review feedback/i;
const TERMINAL_RE = /done|cancelled|won't do/i;
const NEEDS_HUMAN_RE = /needs human|blocked/i;

export function defaultActiveStates(options) {
  return options.filter((o) => ACTIVE_RE.test(o.name)).map((o) => o.name);
}

export function defaultTerminalStates(options) {
  return options.filter((o) => TERMINAL_RE.test(o.name)).map((o) => o.name);
}

export function defaultNeedsHumanState(options) {
  if (options.length === 0) return null;
  // Prefer an exact "Needs Human" match (case-insensitive) over a looser
  // /blocked/ hit, otherwise an ambiguous project with both states picks
  // whichever option happens to come first.
  const exact = options.find((o) => o.name.toLowerCase() === "needs human");
  if (exact) return exact.name;
  return options.find((o) => NEEDS_HUMAN_RE.test(o.name))?.name ?? options[0].name;
}

export function parseList(value) {
  return value.split(",").map((s) => s.trim()).filter(Boolean);
}

export function slug(value) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 32) || "default";
}

// Tiny argv parser — wizard accepts a small, fixed set of flags. Unknown flags
// are ignored on purpose so we don't fight node-runner-style wrapper args.
//
// `eagerBootstrap` defaults to true; `--no-eager-bootstrap` flips it off so
// the wizard skips the LLM-authored recipe priming and the daemon does it
// lazily on the second dispatch.
export function parseInitArgs(argv) {
  const out = { yes: false, projectUrl: null, eagerBootstrap: true };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--yes" || arg === "-y") {
      out.yes = true;
    } else if (arg === "--no-eager-bootstrap") {
      out.eagerBootstrap = false;
    } else if (arg === "--project") {
      // `--project <url>` form: only consume the next arg if it doesn't look
      // like another flag, so `--project --yes` doesn't silently swallow --yes.
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        out.projectUrl = next;
        i++;
      }
    } else if (arg.startsWith("--project=")) {
      out.projectUrl = arg.slice("--project=".length);
    }
  }
  return out;
}
