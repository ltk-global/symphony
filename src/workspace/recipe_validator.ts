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
// Must match the cap in `computeInputHash` (recipes.ts and
// workspace-bootstrap.mjs). Manifests beyond this size silently drop
// entries from the hash; reject them here so validation matches behavior.
const MAX_MANIFEST_FILES = 64;

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
  // Loose match: any `bash|sh|zsh|$SHELL` invocation on the same line as
  // a curl/wget/fetch pipe is suspicious. Wrappers (`time bash`, env
  // vars, path-prefixes, quotes) all collapse into "shell exists in the
  // pipeline". Over-detection is preferred to under-detection.
  { pattern: /\b(curl|wget|fetch)\b[^\n]*\|[^\n]*(\b(bash|sh|zsh)\b|\$\{?SHELL\b)/i, label: "pipe-to-shell" },
  // Process substitution + source/exec: `bash <(curl …)`,
  // `source <(curl …)`, `. <(wget …)`, `exec < <(curl …)` — all remote-code
  // execution shapes equivalent to pipe-to-shell.
  { pattern: /(?:\b(bash|sh|zsh|source|exec)\b|(?:^|[\s;&|])\.)[^\n]*<\s*\(?\s*(curl|wget|fetch)\b/i, label: "process-substitution-to-shell" },
  // `bash -c "$(curl …)"`, `bash -lc "$(…)"`, `bash <<< "$(curl …)"` —
  // same RCE shape as pipe-to-shell. Allow any short-flag bundle that
  // contains `c` (sh -c, bash -lc, bash -Cl) and bash here-strings.
  { pattern: /\b(bash|sh|zsh)\b[^\n]*(?:-[a-zA-Z]*c[a-zA-Z]*\s+|<<<\s*)[^\n]*\b(curl|wget|fetch)\b/i, label: "shell-c-remote-fetch" },
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
  // `service <name> <action>` and `systemctl/launchctl [flags] <action>`
  // — both shapes covered, including leading flags like `systemctl --user
  // start foo`. The `[^\n;&|]*\s` between cmd and action allows any flags.
  { pattern: /\b(systemctl|launchctl)\b[^\n;&|]*\s(start|stop|restart|disable|enable|reload|reload-or-restart)\b|\bservice\s+\S+\s+(start|stop|restart|reload|reload-or-restart)\b/i, label: "system-service" },
  // ssh/scp/rsync to a remote — match ANY invocation. The skill forbids
  // these outright; default-user `ssh github.com` and `scp host:/path` need
  // to be caught regardless of `:`/`@`. `ssh-keygen` doesn't match because
  // `\bssh\s+` requires whitespace after `ssh`, but `ssh-keygen` has `-`.
  { pattern: /\b(ssh|scp|rsync)\s+\S/i, label: "ssh-out" },
  { pattern: /\bcrontab\s+-/i, label: "crontab" },
  { pattern: /:\s*\(\s*\)\s*\{[^}]*:\s*\|\s*:/i, label: "fork-bomb" },
  // Block redirects to ANY absolute path except `/dev/{null,stderr,stdout}`.
  // `>>?\|?` covers `>`, `>>`, and `>|` (force-overwrite under noclobber).
  // Covers `> /etc/foo`, `> /tmp/x`, `> /usr/local/bin/y`, etc.
  { pattern: />>?\|?\s*["']?\/(?!dev\/(?:null|stderr|stdout)\b)[A-Za-z]/i, label: "absolute-write" },
  // Block redirects to parent-relative paths — `> ../foo` escapes $WORKSPACE.
  { pattern: />>?\|?\s*["']?\.\.\//, label: "absolute-write" },
  // Block redirects through $WORKSPACE-prefixed traversal: `> $WORKSPACE/../x`.
  { pattern: />>?\|?\s*["']?\$\{?WORKSPACE\}?\/+\.\./i, label: "absolute-write" },
  // Block filesystem-mutating commands writing to an absolute destination.
  // `(?:\S+\s+)*` allows zero or more intermediate operands so single-arg
  // forms (`mkdir /tmp/x`) AND flagged forms (`cp -r src /tmp/x`) both match.
  { pattern: /\b(cp|mv|install|mkdir|chmod|chown|ln|rmdir|tee|touch)\s+(?:\S+\s+)*["']?\/(?!dev\/(?:null|stderr|stdout)\b)[A-Za-z]/i, label: "absolute-write" },
  // Block filesystem-mutating commands writing to a parent-relative path
  // OR through $WORKSPACE traversal.
  { pattern: /\b(cp|mv|install|tee|touch|mkdir|chmod|chown|ln|rmdir)\b[^\n;&|]*\s["']?(\.\.\/|\$\{?WORKSPACE\}?\/+\.\.)/i, label: "absolute-write" },
  // Block redirects to home — `> ~/.npmrc`, `>> $HOME/.bashrc`, etc.
  // would mutate the runner's persistent user environment.
  { pattern: />>?\s*["']?(~|\$\{?HOME\b)/i, label: "home-write" },
  // Chained shell var assignments enabling indirect command expansion:
  // `c=curl; b=bash; $c | $b` would run as `curl | bash` but no other rule
  // matches the literal text. We don't try to track all expansion forms;
  // reject the chain shape, which has no legitimate use in a bootstrap
  // recipe.
  { pattern: /\b[A-Za-z_]\w*=\S+\s*;\s*[A-Za-z_]\w*=/, label: "chained-var-assignments" },
  // Block attempts to relax the forced `set -euo pipefail` preamble.
  // `set +e` / `set +o errexit` etc. would let a failed install be
  // silently ignored while `exit 0` still runs.
  { pattern: /\bset\s+\+(e|u|o\s+(errexit|nounset|pipefail)|[a-zA-Z]*[euo])\b/i, label: "shell-options-relax" },
  // Reject ANY reference to ~ or $HOME in the body. The skill explicitly
  // forbids touching the runner's home directory; copy/mv/npm-config/etc.
  // forms (not redirects) were bypassing the home-write rule. Recipes use
  // $WORKSPACE / $SYMPHONY_CACHE_DIR for everything mutable. The tilde
  // alternation matches `~/path` AND bare `~` (when preceded by non-word
  // and followed by whitespace/quote/end), but not `name~vsn` or
  // `path/to/~/file` (where `~` is part of a longer identifier).
  { pattern: /(\$\{?HOME\b|(?<![\w/.])~(?=[\s/'"]|$))/, label: "home-reference" },
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
        } else if (v.length > MAX_MANIFEST_FILES) {
          errors.push(`manifest.${k} exceeds ${MAX_MANIFEST_FILES} entries (cap matches computeInputHash)`);
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

  // Bash treats `\<newline>` and trailing `|<newline>` as pipeline
  // continuations. `#` starts a comment when at line-start, after
  // whitespace, OR immediately after a control operator (`|#`, `;#`,
  // `&#`, `(#`, `)#`) — bash starts a new word boundary at those.
  // Mid-word `#` (URL fragment, `ok#tag`) is still literal.
  const joinedBody = body
    .replace(/(^|[\s|;&()])#[^\n]*/g, "$1")
    .replace(/\\\n/g, "")
    .replace(/\|\s*\n\s*/g, "| ");

  // Blocklist + secret scan run against multiple views of the body, each
  // catching what the others miss. The `fullyNormalizedBody` view applies
  // every transformation cumulatively so adversarial bodies that mix
  // continuations + quotes + escapes (`c'url' x |\n b'as'h`) get all of
  // them collapsed before pattern matching.
  //   - body (raw): `#` inside quoted strings; persisted artifact.
  //   - joinedBody: bash continuations + line comments collapsed.
  //   - quotelessBody: adjacent-quote concat (incl. ANSI-C `$'…'`).
  //   - unescapedBody: backslash-escape removal.
  //   - combinedBody: quotes AND escapes stripped together.
  //   - fullyNormalizedBody: comments + continuations + quotes + escapes.
  // Apply OR of all views as the safety gate.
  const quotelessBody = body.replace(/\$?['"]/g, "");
  const unescapedBody = body.replace(/\\(.)/g, "$1");
  const combinedBody = quotelessBody.replace(/\\(.)/g, "$1");
  // Decode ANSI-C `$'…'` escapes (hex `\xNN`, octal `\NNN`, Unicode
  // `\uNNNN`/`\UNNNNNNNN`, named `\n`/`\t`/etc.) before stripping quotes
  // and backslashes. Without this, an LLM could spell forbidden words
  // via numeric escapes (`r$'\155'` → `rm`, `c$'u'rl` → `curl`).
  // String.fromCodePoint throws RangeError for code points above 0x10FFFF
  // (a malformed `\UFFFFFFFF` from an LLM would crash validateRecipe rather
  // than triggering fallback). safeFromCodePoint clamps to U+FFFD.
  const safeFromCodePoint = (cp: number): string => {
    if (!Number.isFinite(cp) || cp < 0 || cp > 0x10FFFF) return "�";
    try { return String.fromCodePoint(cp); } catch { return "�"; }
  };
  const fullyNormalizedBody = joinedBody
    .replace(/\\x([0-9a-fA-F]{2})/g, (_m, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/\\u([0-9a-fA-F]{4})/g, (_m, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/\\U([0-9a-fA-F]{8})/g, (_m, h) => safeFromCodePoint(parseInt(h, 16)))
    .replace(/\\([0-7]{1,3})/g, (_m, o) => String.fromCharCode(parseInt(o, 8) & 0xff))
    .replace(/\$?['"]/g, "")
    .replace(/\\(.)/g, "$1");
  const views = [body, joinedBody, quotelessBody, unescapedBody, combinedBody, fullyNormalizedBody];
  for (const rule of BLOCKLIST) {
    if (views.some((v) => rule.pattern.test(v))) {
      errors.push(`blocklist: ${rule.label}`);
    }
  }

  // Secret-scan layer — same view set as the blocklist plus the manifest
  // text. Tokens split by adjacent quoting (`ghp_abcd…'efgh…'`) need the
  // quoteless/combined views; tokens in comments need the raw body view.
  const manifestText = (() => {
    try { return JSON.stringify(manifest); } catch { return ""; }
  })();
  for (const s of SECRET_PATTERNS) {
    if (views.some((v) => s.pattern.test(v)) || s.pattern.test(manifestText)) {
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
