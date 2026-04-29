import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { createInterface } from "node:readline";
import { IrisClient } from "../iris/client.js";

if (process.env.SYMPHONY_MCP_DEBUG) {
  process.stderr.write(`[symphony-mcp] node=${process.version} execPath=${process.execPath} fetch=${typeof fetch}\n`);
}

const debugLog = (msg: string) => {
  if (process.env.SYMPHONY_MCP_DEBUG) process.stderr.write(`[symphony-mcp] ${msg}\n`);
};

type JsonRpcRequest = { jsonrpc?: string; id?: string | number | null; method?: string; params?: any };

const lines = createInterface({ input: process.stdin });

let irisCallsThisSession = 0;

lines.on("line", (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  let request: JsonRpcRequest;
  try {
    request = JSON.parse(trimmed);
  } catch (error) {
    respond(null, undefined, { code: -32700, message: errorMessage(error) });
    return;
  }
  void handle(request).catch((error) => {
    respond(request.id ?? null, undefined, { code: -32603, message: errorMessage(error) });
  });
});

async function handle(request: JsonRpcRequest): Promise<void> {
  debugLog(`request method=${request.method} id=${request.id}`);
  if (!hasJsonRpcResponseId(request)) {
    // Notifications (no id): nothing to respond to. Includes notifications/initialized.
    return;
  }
  if (request.method === "initialize") {
    respond(request.id, {
      protocolVersion: "2024-11-05",
      capabilities: { tools: {} },
      serverInfo: { name: "symphony", version: "0.1.0" },
    });
    return;
  }
  if (request.method === "tools/list") {
    respond(request.id, {
      tools: [
        {
          name: "iris_run",
          description: "Run a browser instruction through Symphony IRIS.",
          inputSchema: {
            type: "object",
            properties: {
              instruction: { type: "string" },
              profile: { type: "string" },
              container_id: { type: "string" },
            },
            required: ["instruction"],
          },
        },
      ],
    });
    return;
  }
  if (request.method === "tools/call") {
    if (request.params?.name !== "iris_run") {
      respond(request.id, undefined, { code: -32602, message: `unsupported tool: ${request.params?.name}` });
      return;
    }
    const args = request.params.arguments ?? {};
    const tokenEnv = process.env.SYMPHONY_IRIS_TOKEN_ENV ?? "IRIS_TOKEN";
    const token = process.env[tokenEnv] ?? "";
    if (!token) {
      respond(request.id, undefined, { code: -32603, message: `missing ${tokenEnv}` });
      return;
    }

    const maxCallsPerTurn = parsePositiveInt(process.env.SYMPHONY_IRIS_MAX_CALLS_PER_TURN, 10);
    irisCallsThisSession += 1;
    if (irisCallsThisSession > maxCallsPerTurn) {
      respond(request.id, undefined, { code: -32000, message: `iris_run_call_limit_exceeded: ${maxCallsPerTurn}` });
      return;
    }

    const client = new IrisClient({
      baseUrl: process.env.SYMPHONY_IRIS_BASE_URL ?? "https://swarmy.firsttofly.com",
      token,
      maxConcurrent: Number(process.env.SYMPHONY_IRIS_MAX_CONCURRENT ?? 1),
      requestTimeoutMs: Number(process.env.SYMPHONY_IRIS_REQUEST_TIMEOUT_MS ?? 600_000),
      sharedSemaphoreKey: process.env.SYMPHONY_IRIS_SHARED_SEMAPHORE_KEY || undefined,
      sharedSemaphoreRoot: process.env.SYMPHONY_IRIS_SHARED_SEMAPHORE_ROOT || undefined,
    });
    const result = await client.run({
      instruction: String(args.instruction ?? ""),
      profile: resolveMcpIrisProfile(args, process.env),
      containerId: typeof args.container_id === "string" ? args.container_id : undefined,
    });

    if (result.status === "blocked") {
      const onBlocked = process.env.SYMPHONY_IRIS_ON_BLOCKED ?? "needs_human";
      if (onBlocked === "needs_human") {
        await writeBlockedMarker(process.env.SYMPHONY_BLOCKED_MARKER_PATH, result.blocked);
        respond(request.id, undefined, {
          code: -32001,
          message: `iris_blocked_handed_off: ${result.blocked?.reason ?? "blocked"}. Stop work — orchestrator will move this item to needs_human.`,
        });
        return;
      }
      if (onBlocked === "fail") {
        respond(request.id, undefined, { code: -32002, message: `iris_blocked: ${result.blocked?.reason ?? "blocked"}` });
        return;
      }
      // pass_through: fall through and return the result to the agent.
    }

    respond(request.id, { content: [{ type: "text", text: JSON.stringify(result) }] });
    return;
  }
  respond(request.id, undefined, { code: -32601, message: `method not found: ${request.method}` });
}

export function hasJsonRpcResponseId(request: Pick<JsonRpcRequest, "id">): boolean {
  return request.id !== undefined && request.id !== null;
}

export function resolveMcpIrisProfile(args: Record<string, unknown>, env: Pick<NodeJS.ProcessEnv, string>): string {
  const allowOverride = (env.SYMPHONY_IRIS_ALLOW_PROFILE_OVERRIDE ?? "true").toLowerCase() !== "false";
  if (allowOverride && typeof args.profile === "string") return args.profile;
  const labels = new Set(
    String(env.SYMPHONY_ISSUE_LABELS ?? "")
      .split(",")
      .map((label) => label.trim().toLowerCase())
      .filter(Boolean),
  );
  for (const [label, profile] of Object.entries(parseProfileOverrides(env.SYMPHONY_IRIS_PROFILE_OVERRIDES))) {
    if (labels.has(label.toLowerCase())) return profile;
  }
  return env.SYMPHONY_IRIS_DEFAULT_PROFILE ?? "claude-default-latest";
}

export async function writeBlockedMarker(markerPath: string | undefined, blocked: { vncUrl?: string; reason?: string } | undefined): Promise<void> {
  if (!markerPath) return;
  await mkdir(dirname(markerPath), { recursive: true });
  const payload = JSON.stringify({
    vncUrl: blocked?.vncUrl ?? "",
    reason: blocked?.reason ?? "",
    writtenAt: new Date().toISOString(),
  });
  await writeFile(markerPath, payload, "utf8");
}

function parseProfileOverrides(raw: string | undefined): Record<string, string> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return Object.fromEntries(Object.entries(parsed).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
  } catch {
    return {};
  }
}

function parsePositiveInt(raw: string | undefined, fallback: number): number {
  if (raw === undefined) return fallback;
  const value = Number.parseInt(raw, 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function respond(id: JsonRpcRequest["id"] | null, result?: unknown, error?: { code: number; message: string }): void {
  const payload = JSON.stringify({ jsonrpc: "2.0", id: id ?? null, ...(error ? { error } : { result }) });
  process.stdout.write(payload + "\n");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
