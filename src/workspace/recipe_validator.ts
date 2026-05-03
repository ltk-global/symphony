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
  { name: "github-token", pattern: /\b(ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36,}\b/ },
  { name: "github-fine-grained", pattern: /\bgithub_pat_[A-Za-z0-9_]{20,}\b/ },
  { name: "slack-webhook", pattern: /https:\/\/hooks\.slack\.com\/services\/[A-Z0-9\/]+/ },
  { name: "slack-token", pattern: /\bxox[baprs]-[A-Za-z0-9-]+/ },
  { name: "iris-token", pattern: /\bswm_[A-Za-z0-9]{20,}\b/ },
];

const BLOCKLIST: Array<{ name: string; pattern: RegExp; label: string }> = [
  { name: "pipe-to-shell", pattern: /\b(curl|wget|fetch)\b[^\n]*\|\s*(bash|sh|zsh)\b/i, label: "pipe-to-shell" },
  { name: "eval", pattern: /\beval\s+["'$]/, label: "eval-of-dynamic-input" },
  { name: "destructive-rm", pattern: /rm\s+-[a-z]*r[a-z]*f?\s+(\/+["']?(?!\$\{?WORKSPACE)|~\/|\$HOME|\$\{HOME)/i, label: "destructive-rm" },
  { name: "sudo", pattern: /\b(sudo|doas|su\s+-)\b/i, label: "sudo" },
  { name: "systemd", pattern: /\b(systemctl|launchctl|service)\s+(start|stop|restart|disable|enable|reload)\b/i, label: "system-service" },
  { name: "ssh-out", pattern: /\b(ssh|scp|rsync)\s+[^\n]*@/i, label: "ssh-out" },
  { name: "crontab", pattern: /\bcrontab\s+-/i, label: "crontab" },
  { name: "fork-bomb", pattern: /:\s*\(\s*\)\s*\{[^}]*:\s*\|\s*:/i, label: "fork-bomb" },
  { name: "etc-write", pattern: />>?\s*\/etc\//i, label: "/etc/-write" },
];

export function validateRecipe(body: string, manifest: RecipeManifest): ValidationResult {
  const errors: string[] = [];

  // Schema layer
  for (const k of REQUIRED_MANIFEST_KEYS) {
    if ((manifest as any)?.[k] === undefined) {
      errors.push(`manifest missing key: ${k}`);
    }
  }
  if (manifest?.schema !== "symphony.recipe.v1") {
    errors.push(`manifest.schema must be 'symphony.recipe.v1' (got: ${manifest?.schema})`);
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
      errors.push(`blocklist: ${rule.label} matched`);
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
