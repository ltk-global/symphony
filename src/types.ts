export type AgentKind = "codex" | "claude_code";

export interface BlockedBy {
  id: string;
  identifier: string;
  state: string;
}

export interface Issue {
  id: string;
  contentId: string | null;
  identifier: string;
  title: string;
  description: string | null;
  priority: number | null;
  state: string;
  branchName: string | null;
  url: string | null;
  labels: string[];
  blockedBy: BlockedBy[];
  createdAt: string | null;
  updatedAt: string | null;
  assignees: string[];
  repoFullName: string | null;
}

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

export type NormalizedEvent =
  | { kind: "session_started"; sessionId: string; pid?: number }
  | { kind: "turn_started"; turnId: string }
  | { kind: "tool_call"; toolName: string; args: unknown; callId: string }
  | { kind: "tool_result"; callId: string; result: unknown }
  | { kind: "message"; text: string; final?: boolean }
  | { kind: "usage"; inputTokens: number; outputTokens: number; totalTokens: number }
  | { kind: "turn_completed"; usage?: Usage }
  | { kind: "turn_failed"; reason: string }
  | { kind: "turn_cancelled"; reason: string }
  | { kind: "turn_input_required"; prompt: string }
  | { kind: "rate_limited"; retryAfterMs: number };

export interface ToolSpec {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface ToolResult {
  callId: string;
  result: unknown;
}
