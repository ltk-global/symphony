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
  { name: "slack-webhook", pattern: /https:\/\/hooks\.slack\.com\/services\/[A-Z0-9\/]+/ },
  // Real Slack tokens are xox[baprs]-NNN-NNN-NNN-... ; require ≥2 dashes
  // after the prefix-dash so `xoxb-x` / `xoxb-fake` in test/comment text
  // doesn't false-positive.
  { name: "slack-token", pattern: /\bxox[baprs]-[A-Za-z0-9]+-[A-Za-z0-9]+-[A-Za-z0-9-]+/ },
  { name: "iris-token", pattern: /\bswm_[A-Za-z0-9]{20,}\b/ },
];

const BLOCKLIST: Array<{ pattern: RegExp; label: string }> = [
  { pattern: /\b(curl|wget|fetch)\b[^\n]*\|\s*(bash|sh|zsh)\b/i, label: "pipe-to-shell" },
  { pattern: /\beval\s+["'$]/, label: "eval-of-dynamic-input" },
  // Allow optional opening quote before the destructive target so
  // `rm -rf "/"`, `rm -rf '$HOME'`, etc. don't slip past the gate.
  // Targets: `/`-rooted paths, `~/`, or `$HOME`/`${HOME}`. `$WORKSPACE` is
  // the only env-var prefix that's allowed and naturally excluded since
  // it doesn't start with any of these branches.
  { pattern: /rm\s+-[a-z]*r[a-z]*f?\s+["']?(\/+|~\/|\$\{?HOME\b)/i, label: "destructive-rm" },
  { pattern: /\b(sudo|doas|su\s+-)\b/i, label: "sudo" },
  { pattern: /\b(systemctl|launchctl|service)\s+(start|stop|restart|disable|enable|reload)\b/i, label: "system-service" },
  { pattern: /\b(ssh|scp|rsync)\s+[^\n]*@/i, label: "ssh-out" },
  { pattern: /\bcrontab\s+-/i, label: "crontab" },
  { pattern: /:\s*\(\s*\)\s*\{[^}]*:\s*\|\s*:/i, label: "fork-bomb" },
  { pattern: />>?\s*\/etc\//i, label: "/etc/-write" },
];

export function validateRecipe(body: string, manifest: RecipeManifest): ValidationResult {
  const errors: string[] = [];

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
      if (v !== undefined && !(Array.isArray(v) && v.every((x) => typeof x === "string"))) {
        errors.push(`manifest.${k} must be string[]`);
      }
    }
    if (m.cacheKeys !== undefined) {
      const ck = m.cacheKeys;
      if (!Array.isArray(ck) || !ck.every((entry) => isCacheKey(entry))) {
        errors.push("manifest.cacheKeys must be Array<{name, hashFiles[], path}>");
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

  // Blocklist layer
  for (const rule of BLOCKLIST) {
    if (rule.pattern.test(body)) {
      errors.push(`blocklist: ${rule.label}`);
    }
  }

  // Secret-scan layer
  for (const s of SECRET_PATTERNS) {
    if (s.pattern.test(body)) {
      errors.push(`secret-scan: ${s.name} detected — never inline tokens`);
    }
  }

  return { ok: errors.length === 0, errors };
}

function isCacheKey(entry: unknown): boolean {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) return false;
  const e = entry as Record<string, unknown>;
  return typeof e.name === "string"
    && typeof e.path === "string"
    && Array.isArray(e.hashFiles)
    && e.hashFiles.every((x) => typeof x === "string");
}
