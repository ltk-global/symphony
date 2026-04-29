import type { Issue, NormalizedEvent, ToolResult, ToolSpec } from "../types.js";
import type { TurnSink } from "../observability/turn_recorder.js";

export interface AgentRunner {
  start(input: {
    workspacePath: string;
    prompt: string;
    issue: Issue;
    attempt: number | null;
    tools: ToolSpec[];
    abortSignal: AbortSignal;
    openTurnSink?: () => Promise<TurnSink>;
  }): Promise<AgentSession>;
}

export interface AgentSession {
  readonly sessionId: string;
  readonly events: AsyncIterable<NormalizedEvent>;
  startTurn(input: { text: string; toolResults?: ToolResult[] }): Promise<void>;
  cancel(reason: string): Promise<void>;
}
