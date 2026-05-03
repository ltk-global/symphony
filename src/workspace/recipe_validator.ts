import { execFileSync } from "node:child_process";

export interface RecipeManifest {
  schema: string;
  repoId: string;
  repoFullName: string;
  generatedBy: string;
  generatedAt: string;
  inputHash: string;
  inputFiles: string[];
  discoveryFiles: string[];
  cacheKeys: Array<{ name: string; hashFiles: string[]; path: string }>;
  lfs: boolean;
  submodules: boolean;
  notes: string;
  approvedBy: string | null;
  approvedAt: string | null;
}

export interface ValidationResult {
  ok: boolean;
  errors: string[];
}

const REQUIRED_MANIFEST_KEYS = [
  "schema", "repoId", "repoFullName", "generatedBy", "generatedAt",
  "inputHash", "inputFiles", "discoveryFiles", "cacheKeys",
  "lfs", "submodules", "notes",
] as const;

const MAX_BODY_BYTES = 8 * 1024;
const MAX_MANIFEST_BYTES = 4 * 1024;

const SECRET_PATTERNS: Array<{ name: string; pattern: RegExp }> = [
  // {36,} (not exact {36}) catches both real PATs and longer accidental
  // disclosures; over-detection is preferred to under-detection here.
  { name: "github-token", pattern: /\b(ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36,}\b/ },
  { name: "github-fine-grained", pattern: /\bgithub_pat_[A-Za-z0-9_]{20,}\b/ },
  { name: "slack-webhook", pattern: /https:\/\/hooks\.slack\.com\/services\/[A-Za-z0-9\/]+/ },
  // Real Slack tokens are xox[baprs]-NNN-NNN-NNN-... ; require ≥2 dashes
  // after the prefix-dash so `xoxb-x` / `xoxb-fake` in test/comment text
  // doesn't false-positive.
  { name: "slack-token", pattern: /\bxox[baprs]-[A-Za-z0-9]+-[A-Za-z0-9]+-[A-Za-z0-9-]+/ },
  { name: "iris-token", pattern: /\bswm_[A-Za-z0-9]{20,}\b/ },
  // SKILL.md explicitly forbids hardcoded credential URLs; catch the
  // generic `https://user:secret@host/…` shape regardless of token format.
  { name: "credential-url", pattern: /\bhttps?:\/\/[^\s\/:@]+:[^\s\/@]+@/ },
];

const BLOCKLIST: Array<{ pattern: RegExp; label: string }> = [
  // Loose match: any `bash|sh|zsh` invocation on the same line as a
  // curl/wget/fetch pipe is suspicious. Wrappers (`time bash`,
  // `nohup bash`, `command bash`, env vars, path-prefixes, quotes) all
  // collapse into "bash exists in the pipeline". Over-detection is
  // preferred to under-detection here; benign `curl … | grep bash` is
  // vanishingly rare in a workspace-bootstrap recipe.
  { pattern: /\b(curl|wget|fetch)\b[^\n]*\|[^\n]*\b(bash|sh|zsh)\b/i, label: "pipe-to-shell" },
  // Catch backtick command substitution (`eval \`...\``) as well as the
  // quote-/`$`-prefixed forms.
  { pattern: /\beval\s+["'$`]/, label: "eval-of-dynamic-input" },
  // Targets: `/`-rooted, `~` (with or without `/`), `$HOME`/`${HOME}`, or
  // `../` parent-relative (recipes run in $WORKSPACE — `..` escapes). The
  // `[^\n;&|]*\s` lookbehind allows any number of intermediate operands so
  // `rm -rf node_modules /` or `rm -rf build ../sibling` are still caught
  // (bash would delete every operand). `$WORKSPACE` is the only $-prefixed
  // path allowed; no branch starts with it. Optional `--` separator and
  // opening quote handle `rm -rf -- "/"` etc.
  // Drop the `-[a-z]*r[a-z]*f?` constraint — split short flags
  // (`rm -f -r …`), long forms (`rm --recursive --force …`), and even
  // unflagged `rm $HOME` are all destructive. Any `rm` invocation whose
  // operands include a destructive target is rejected.
  { pattern: /\brm\b[^\n;&|]*\s(--\s+)?["']?(\/+|~|\$\{?HOME\b|\.\.\/)/i, label: "destructive-rm" },
  // Any `..` segment anywhere in an rm command's operand list — catches
  // `rm -rf "$WORKSPACE/../sibling"`, terminal `rm -rf $WORKSPACE/..`, and
  // bare `rm -rf ..`. The lookahead requires `..` to be followed by a path
  // separator, whitespace, quote, statement separator, or end of input.
  { pattern: /\brm\b[^\n;&|]*\.\.(?=[/\s"';|&]|$)/i, label: "destructive-rm-traversal" },
  // `\bsu\s+-\b` doesn't work — `-` is non-word so `\b` after it requires
  // a word char immediately, which fails for the common `su - root` form.
  // Drop the trailing boundary on the `su -` branch.
  { pattern: /\b(sudo|doas)\b|\bsu\s+-/i, label: "sudo" },
  // `service` takes `service <name> <action>` (action follows the unit
  // name); systemctl/launchctl take `<cmd> <action> [unit]` (action follows
  // the command). Cover both shapes.
  { pattern: /\b(systemctl|launchctl)\s+(start|stop|restart|disable|enable|reload|reload-or-restart)\b|\bservice\s+\S+\s+(start|stop|restart|reload|reload-or-restart)\b/i, label: "system-service" },
  { pattern: /\b(ssh|scp|rsync)\s+[^\n]*@/i, label: "ssh-out" },
  { pattern: /\bcrontab\s+-/i, label: "crontab" },
  { pattern: /:\s*\(\s*\)\s*\{[^}]*:\s*\|\s*:/i, label: "fork-bomb" },
  { pattern: />>?\s*\/etc\//i, label: "/etc/-write" },
  // Block redirects to home — `> ~/.npmrc`, `>> $HOME/.bashrc`, etc.
  // would mutate the runner's persistent user environment.
  { pattern: />>?\s*["']?(~|\$\{?HOME\b)/i, label: "home-write" },
];

export function validateRecipe(body: unknown, manifest: RecipeManifest): ValidationResult {
  const errors: string[] = [];

  if (typeof body !== "string") {
    return { ok: false, errors: ["recipe body must be a string"] };
  }

  // Schema layer — keys present, types correct (LLM JSON can't be trusted).
  const m = manifest as unknown as Record<string, unknown> | null | undefined;
  for (const k of REQUIRED_MANIFEST_KEYS) {
    if (m?.[k] === undefined) {
      errors.push(`manifest missing key: ${k}`);
    }
  }
  if (manifest?.schema !== "symphony.recipe.v1") {
    errors.push(`manifest.schema must be 'symphony.recipe.v1' (got: ${manifest?.schema})`);
  }
  if (m) {
    for (const k of ["repoId", "repoFullName", "generatedBy", "generatedAt", "inputHash", "notes"] as const) {
      if (m[k] !== undefined && typeof m[k] !== "string") {
        errors.push(`manifest.${k} must be string`);
      }
    }
    for (const k of ["lfs", "submodules"] as const) {
      if (m[k] !== undefined && typeof m[k] !== "boolean") {
        errors.push(`manifest.${k} must be boolean`);
      }
    }
    for (const k of ["inputFiles", "discoveryFiles"] as const) {
      const v = m[k];
      if (v !== undefined) {
        if (!Array.isArray(v) || !v.every((x) => typeof x === "string")) {
          errors.push(`manifest.${k} must be string[]`);
        } else if (!v.every(isSafeRelativePath)) {
          errors.push(`manifest.${k} entries must be safe relative paths (no leading /, no ..)`);
        }
      }
    }
    if (m.cacheKeys !== undefined) {
      const ck = m.cacheKeys;
      if (!Array.isArray(ck) || !ck.every((entry) => isCacheKey(entry))) {
        errors.push("manifest.cacheKeys must be Array<{name, hashFiles[], path}>");
      } else if (!ck.every((entry) => isSafeCacheKey(entry as Record<string, unknown>))) {
        errors.push("manifest.cacheKeys paths must be safe relative paths (no leading /, no ..)");
      }
    }
    for (const k of ["approvedBy", "approvedAt"] as const) {
      const v = m[k];
      if (v !== undefined && v !== null && typeof v !== "string") {
        errors.push(`manifest.${k} must be string or null`);
      }
    }
  }
  if (Buffer.byteLength(body, "utf8") > MAX_BODY_BYTES) {
    errors.push(`recipe body size > ${MAX_BODY_BYTES}B`);
  }
  if (Buffer.byteLength(JSON.stringify(manifest ?? {}), "utf8") > MAX_MANIFEST_BYTES) {
    errors.push(`manifest size > ${MAX_MANIFEST_BYTES}B`);
  }

  // Charset layer — UTF-8 already enforced by string type; reject NUL + CR + other control chars.
  if (/[\x00-\x08\x0B\x0C\x0E-\x1F]/.test(body)) {
    errors.push("recipe body contains control chars (only \\n and \\t allowed)");
  }
  if (body.includes("\r")) {
    errors.push("recipe body contains carriage return");
  }

  // Bash treats both `\<newline>` and a trailing `|<newline>` as pipeline
  // continuations, so forbidden commands can be split across lines to
  // bypass single-line regex (e.g. `curl x \\\n| bash` or `curl x |\nbash`).
  // Match against the joined form.
  const joinedBody = body
    .replace(/\\\n/g, "")
    .replace(/\|\s*\n\s*/g, "| ");

  // Blocklist layer
  for (const rule of BLOCKLIST) {
    if (rule.pattern.test(joinedBody)) {
      errors.push(`blocklist: ${rule.label}`);
    }
  }

  // Secret-scan layer — applied to body AND manifest text. Both are
  // persisted artifacts; a token in `manifest.notes` is just as bad.
  const manifestText = (() => {
    try { return JSON.stringify(manifest); } catch { return ""; }
  })();
  for (const s of SECRET_PATTERNS) {
    if (s.pattern.test(joinedBody) || s.pattern.test(manifestText)) {
      errors.push(`secret-scan: ${s.name} detected — never inline tokens`);
    }
  }

  // Bash syntax check — catch unterminated `if`/`for`/`while`, mismatched
  // braces/parens, etc., before persisting. Falls through silently if bash
  // isn't on PATH (rare on Symphony's target systems).
  const syntaxErr = bashSyntaxError(body);
  if (syntaxErr) errors.push(`bash syntax: ${syntaxErr}`);

  return { ok: errors.length === 0, errors };
}

function bashSyntaxError(body: string): string | null {
  try {
    execFileSync("bash", ["-n"], {
      input: body,
      stdio: ["pipe", "ignore", "pipe"],
      timeout: 2000,
    });
    return null;
  } catch (err) {
    const stderr = (err as { stderr?: Buffer | string })?.stderr;
    if (stderr) {
      const text = Buffer.isBuffer(stderr) ? stderr.toString() : stderr;
      return text.trim().slice(0, 200);
    }
    if (err instanceof Error && err.message.includes("ENOENT")) return null;
    return null;
  }
}

function isCacheKey(entry: unknown): boolean {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) return false;
  const e = entry as Record<string, unknown>;
  return typeof e.name === "string"
    && typeof e.path === "string"
    && Array.isArray(e.hashFiles)
    && e.hashFiles.every((x) => typeof x === "string");
}

function isSafeRelativePath(p: string): boolean {
  if (typeof p !== "string" || p.length === 0) return false;
  if (p.startsWith("/")) return false;
  // Reject any segment equal to ".." (matches "..", "../foo", "foo/..", "a/../b").
  return !p.split("/").some((seg) => seg === "..");
}

function isSafeCacheKey(e: Record<string, unknown>): boolean {
  if (typeof e.path === "string" && !isSafeRelativePath(e.path)) return false;
  const hashFiles = e.hashFiles;
  if (Array.isArray(hashFiles) && !hashFiles.every((x) => typeof x === "string" && isSafeRelativePath(x))) return false;
  return true;
}
