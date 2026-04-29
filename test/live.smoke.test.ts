// Live smoke tests for the Claude Code adapter, IrisClient, and the full
// Claude+MCP+IRIS path. Each scenario is gated on an env var so CI without
// `claude` installed or without an IRIS token doesn't break.
//
//   SYMPHONY_LIVE_CLAUDE=1   — exercises the real `claude` CLI (no tools)
//   SYMPHONY_LIVE_IRIS=1     — exercises IrisClient against swarmy.firsttofly.com
//   SYMPHONY_LIVE_E2E=1      — exercises Claude+MCP+IRIS end-to-end
//
// Both IRIS scenarios additionally require IRIS_TOKEN.

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ClaudeCodeAdapter } from "../src/agent/claude_code.js";
import { CodexAdapter } from "../src/agent/codex.js";
import { IrisClient } from "../src/iris/client.js";
import type { NormalizedEvent } from "../src/types.js";

const FIVE_MIN_MS = 5 * 60_000;
const TEN_MIN_MS = 10 * 60_000;

const liveClaude = process.env.SYMPHONY_LIVE_CLAUDE === "1";
const liveIris = process.env.SYMPHONY_LIVE_IRIS === "1";
const liveE2e = process.env.SYMPHONY_LIVE_E2E === "1";
const liveCodex = process.env.SYMPHONY_LIVE_CODEX === "1";

describe.skipIf(!liveClaude)("[live] Claude Code adapter", () => {
  it(
    "spawns claude --print stream-json and reaches turn_completed",
    async () => {
      const workspace = await mkdtemp(join(tmpdir(), "symphony-live-"));
      try {
        const adapter = new ClaudeCodeAdapter({
          command: process.env.SYMPHONY_CLAUDE_COMMAND ?? "claude",
          permissionMode: "bypassPermissions",
          allowedTools: [],
          disallowedTools: [],
          appendSystemPrompt: "",
          maxTurns: 5,
        } as any);

        const session = await adapter.start({
          workspacePath: workspace,
          prompt: 'Reply with exactly the five words: "Symphony live smoke test ok". Nothing else.',
          issue: { id: "live-smoke", identifier: "live#1", labels: [] } as any,
          attempt: null,
          tools: [],
          abortSignal: new AbortController().signal,
        });

        const events = await drainEvents(session.events, FIVE_MIN_MS);
        const kinds = events.map((e) => e.kind);
        expect(kinds).toContain("session_started");
        expect(kinds.some((k) => k === "turn_completed" || k === "turn_failed")).toBe(true);

        const messages = events.flatMap((e) => (e.kind === "message" ? [e.text] : []));
        expect(messages.join(" ")).toMatch(/symphony/i);
      } finally {
        await rm(workspace, { recursive: true, force: true });
      }
    },
    FIVE_MIN_MS,
  );
});

describe.skipIf(!liveIris)("[live] IrisClient", () => {
  it(
    "calls swarmy.firsttofly.com and gets a structured last line",
    async () => {
      const token = process.env.IRIS_TOKEN;
      expect(token, "IRIS_TOKEN env var required for live IRIS test").toBeTruthy();

      const client = new IrisClient({
        baseUrl: "https://swarmy.firsttofly.com",
        token: token!,
        maxConcurrent: 1,
        requestTimeoutMs: FIVE_MIN_MS,
      });

      const result = await client.run({
        instruction: [
          "Use swarmy-chrome-agent to navigate to https://example.com.",
          "Read the visible heading text.",
          'Print this exact JSON as the LAST line: {"pass": true, "summary": "loaded example.com", "evidence_url": "https://example.com"}',
        ].join("\n"),
        profile: process.env.IRIS_PROFILE ?? "claude-default-latest",
      });

      expect(result.status).toBe("success");
      expect(result.containerId).toBeTruthy();
      expect(result.result).toMatch(/"pass"\s*:\s*true/);
    },
    FIVE_MIN_MS,
  );
});

describe.skipIf(!liveE2e)("[live] Claude + MCP + IRIS end-to-end", () => {
  it(
    "spawns Claude, registers the symphony MCP server, and the agent calls iris_run",
    async () => {
      const token = process.env.IRIS_TOKEN;
      expect(token, "IRIS_TOKEN env var required for live e2e test").toBeTruthy();

      // The runtime is normally responsible for setting these. The MCP subprocess
      // inherits them through claude_code.ts:buildClaudeToolRegistration.
      process.env.SYMPHONY_IRIS_BASE_URL = "https://swarmy.firsttofly.com";
      process.env.SYMPHONY_IRIS_TOKEN_ENV = "IRIS_TOKEN";
      process.env.SYMPHONY_IRIS_DEFAULT_PROFILE = process.env.IRIS_PROFILE ?? "claude-default-latest";
      process.env.SYMPHONY_IRIS_REQUEST_TIMEOUT_MS = String(FIVE_MIN_MS);
      process.env.SYMPHONY_IRIS_MAX_CONCURRENT = "1";
      process.env.SYMPHONY_IRIS_PROFILE_OVERRIDES = "{}";
      process.env.SYMPHONY_IRIS_SHARED_SEMAPHORE_KEY = "iris:live-e2e";

      const workspace = await mkdtemp(join(tmpdir(), "symphony-e2e-"));
      try {
        const adapter = new ClaudeCodeAdapter({
          command: process.env.SYMPHONY_CLAUDE_COMMAND ?? "claude",
          permissionMode: "bypassPermissions",
          allowedTools: [],
          disallowedTools: [],
          appendSystemPrompt:
            "You have access to the iris_run tool via the symphony MCP server (mcp__symphony__iris_run). Use it whenever you need to verify a URL.",
          maxTurns: 5,
        } as any);

        const session = await adapter.start({
          workspacePath: workspace,
          prompt: [
            "Call mcp__symphony__iris_run with this instruction:",
            "  Use swarmy-chrome-agent to navigate to https://example.com and read the heading.",
            '  Print this exact JSON as the LAST line: {"pass": true, "summary": "e2e ok", "evidence_url": "https://example.com"}',
            "After the tool returns, summarize the result in one sentence and then stop.",
          ].join("\n"),
          issue: { id: "live-e2e", identifier: "live#e2e", labels: [] } as any,
          attempt: null,
          tools: [{ name: "iris_run", description: "Run IRIS", inputSchema: { type: "object" } }],
          abortSignal: new AbortController().signal,
        });

        const events = await drainEvents(session.events, FIVE_MIN_MS);
        const kinds = events.map((e) => e.kind);
        expect(kinds).toContain("session_started");
        const final = events.find((e) => e.kind === "turn_completed" || e.kind === "turn_failed");
        expect(final, "expected a turn_completed/turn_failed terminal event").toBeTruthy();
        expect(final?.kind).toBe("turn_completed");

        const messages = events.flatMap((e) => (e.kind === "message" ? [e.text] : []));
        // The agent should reference the IRIS result somewhere in its summary.
        expect(messages.join(" ")).toMatch(/example\.com|pass|summary/i);
      } finally {
        await rm(workspace, { recursive: true, force: true });
      }
    },
    FIVE_MIN_MS,
  );
});

// Default to npx-fetched latest codex. Override via SYMPHONY_CODEX_COMMAND to
// pin a version or use a local checkout. Older homebrew-installed Codex (0.46)
// speaks a different protocol — stick with the npx package.
const DEFAULT_CODEX_COMMAND = "npx --yes @openai/codex@latest app-server";

describe.skipIf(!liveCodex)("[live] Codex adapter", () => {
  it(
    "completes a turn against codex app-server (initialize → thread/start → turn/start → turn/completed)",
    async () => {
      const workspace = await mkdtemp(join(tmpdir(), "symphony-codex-"));
      try {
        const command = process.env.SYMPHONY_CODEX_COMMAND ?? DEFAULT_CODEX_COMMAND;
        const adapter = new CodexAdapter({ command });

        const session = await adapter.start({
          workspacePath: workspace,
          prompt: 'Reply with exactly the five words: "Codex live smoke test ok". Nothing else.',
          issue: { id: "live-codex", identifier: "live#codex", labels: [] } as any,
          attempt: null,
          tools: [],
          abortSignal: new AbortController().signal,
        });

        const events = await drainEvents(session.events, FIVE_MIN_MS);
        const kinds = events.map((e) => e.kind);
        expect(kinds).toContain("session_started");
        expect(kinds).toContain("turn_completed");

        const messages = events.flatMap((e) => (e.kind === "message" ? [e.text] : []));
        expect(messages.join(" ")).toMatch(/codex/i);

        await session.cancel("test_done");
      } finally {
        await rm(workspace, { recursive: true, force: true });
      }
    },
    TEN_MIN_MS,
  );
});

describe.skipIf(!liveCodex || !liveIris)("[live] Codex + IRIS end-to-end", () => {
  it(
    "registers the symphony MCP server with codex and the model calls iris_run",
    async () => {
      const token = process.env.IRIS_TOKEN;
      expect(token, "IRIS_TOKEN env var required").toBeTruthy();
      process.env.SYMPHONY_IRIS_BASE_URL = "https://swarmy.firsttofly.com";
      process.env.SYMPHONY_IRIS_TOKEN_ENV = "IRIS_TOKEN";
      process.env.SYMPHONY_IRIS_DEFAULT_PROFILE = process.env.IRIS_PROFILE ?? "claude-default-latest";
      process.env.SYMPHONY_IRIS_REQUEST_TIMEOUT_MS = String(FIVE_MIN_MS);
      process.env.SYMPHONY_IRIS_MAX_CONCURRENT = "1";
      process.env.SYMPHONY_IRIS_PROFILE_OVERRIDES = "{}";
      process.env.SYMPHONY_IRIS_SHARED_SEMAPHORE_KEY = "iris:codex-e2e";

      const workspace = process.env.SYMPHONY_KEEP_WS ?? await mkdtemp(join(tmpdir(), "symphony-codex-iris-"));
      console.error("WORKSPACE:", workspace);
      try {
        const command = process.env.SYMPHONY_CODEX_COMMAND ?? DEFAULT_CODEX_COMMAND;
        // Low reasoning was hallucinating tool calls without actually emitting
        // them (the assistant would say "I'll call iris_run" but never produce
        // an mcpToolCall event). Medium is the lightest setting where the
        // model reliably invokes registered MCP tools.
        // Hook codex's raw events so we can prove an mcpToolCall actually
        // fired (rather than the model hallucinating success).
        const irisCalls: Array<{ status: string; containerId?: string; error?: any; result?: any }> = [];
        const adapter = new CodexAdapter({
          command,
          reasoningEffort: "high",
          onRawEvent: (raw) => {
            if (raw.method === "item/completed" && raw.params?.item?.type === "mcpToolCall" && raw.params.item.tool === "iris_run") {
              const item = raw.params.item;
              const text = item.result?.content?.[0]?.text ?? "";
              let containerId: string | undefined;
              try {
                const parsed = JSON.parse(text);
                containerId = typeof parsed.containerId === "string" ? parsed.containerId : undefined;
              } catch {
                /* ignore */
              }
              irisCalls.push({ status: item.status ?? "unknown", containerId, error: item.error, result: item.result });
            }
          },
        });

        const session = await adapter.start({
          workspacePath: workspace,
          // Verbatim probe prompt — the only phrasing that reliably nudges
          // codex 0.125 to actually invoke the MCP tool rather than narrate.
          prompt: "List available MCP tools first, then call the iris_run tool from the symphony server with this instruction: 'Use swarmy-chrome-agent to navigate to https://example.com and read the heading. Print the LAST line as: {\"pass\": true, \"summary\": \"ok\", \"evidence_url\": \"https://example.com\"}'. After it returns, just say done.",
          issue: { id: "live-codex-iris", identifier: "live#codex-iris", labels: [] } as any,
          attempt: null,
          tools: [{ name: "iris_run", description: "Run IRIS", inputSchema: { type: "object" } }],
          abortSignal: new AbortController().signal,
        });

        const start = Date.now();
        const events = await drainEvents(session.events, TEN_MIN_MS);
        const elapsed = Date.now() - start;

        const kinds = events.map((e) => e.kind);
        expect(kinds).toContain("session_started");
        expect(kinds).toContain("turn_completed");

        const messages = events.flatMap((e) => (e.kind === "message" ? [e.text] : []));
        // The model is allowed to be flaky in narrating, but the wiring is
        // proven if codex actually emitted an mcpToolCall for iris_run that
        // succeeded with a real containerId.
        expect(irisCalls.length, `expected at least one iris_run mcpToolCall; model output: ${messages.join(" ").slice(0, 500)}`).toBeGreaterThan(0);
        const successful = irisCalls.find((c) => c.status === "completed" && c.containerId);
        expect(successful, `no successful iris_run call observed: ${JSON.stringify(irisCalls)}`).toBeTruthy();
        // The IRIS round-trip itself takes >5s — sanity check the timing.
        expect(elapsed, "turn completed too fast — likely no real iris_run").toBeGreaterThan(5000);

        await session.cancel("test_done");
      } finally {
        if (!process.env.SYMPHONY_KEEP_WS) await rm(workspace, { recursive: true, force: true });
      }
    },
    TEN_MIN_MS,
  );
});

async function drainEvents(stream: AsyncIterable<NormalizedEvent>, timeoutMs: number): Promise<NormalizedEvent[]> {
  const collected: NormalizedEvent[] = [];
  const deadline = Date.now() + timeoutMs;
  for await (const event of stream) {
    collected.push(event);
    if (event.kind === "turn_completed" || event.kind === "turn_failed" || event.kind === "turn_cancelled" || event.kind === "turn_input_required") {
      return collected;
    }
    if (Date.now() > deadline) throw new Error("drainEvents timed out");
  }
  return collected;
}
