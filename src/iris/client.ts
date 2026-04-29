import { Semaphore } from "./semaphore.js";
import { FileSemaphore } from "./file_semaphore.js";

// Shapes here are best-effort: Swarmy's real wire format includes extra fields
// (phase, worker_id, web_ui_url, etc.) and `result.content` rather than `output`.
// The parser stays tolerant — see readSse — so unknown fields land in `events[]`
// untouched and known fields are extracted defensively.
export type IrisEvent =
  | { event: "ready"; container_id: string; vnc_url?: string; [k: string]: unknown }
  | { event: "progress"; message?: string; phase?: string; [k: string]: unknown }
  | { event: "activity"; tool?: string; data?: unknown; [k: string]: unknown }
  | { event: "delta"; content?: string; text?: string; [k: string]: unknown }
  | { event: "result"; content?: string; output?: string; container_id?: string; [k: string]: unknown }
  | { event: "done"; status?: "success" | "error" | "blocked"; [k: string]: unknown }
  | { event: "blocked"; vnc_url?: string; reason?: string; [k: string]: unknown };

export interface IrisRunResult {
  status: "success" | "error" | "blocked";
  containerId: string;
  result: string;
  blocked?: { vncUrl: string; reason: string };
  events: IrisEvent[];
}

export interface IrisClientOptions {
  baseUrl: string;
  token: string;
  maxConcurrent: number;
  requestTimeoutMs: number;
  fetch?: typeof fetch;
  semaphore?: Semaphore;
  sharedSemaphoreKey?: string;
  sharedSemaphoreRoot?: string;
}

export class IrisClient {
  private readonly fetchImpl: typeof fetch;
  readonly semaphore: Pick<Semaphore, "acquire">;

  constructor(private readonly options: IrisClientOptions) {
    this.fetchImpl = options.fetch ?? fetch;
    this.semaphore =
      options.semaphore ??
      (options.sharedSemaphoreKey
        ? new FileSemaphore(options.sharedSemaphoreKey, options.maxConcurrent, options.sharedSemaphoreRoot)
        : new Semaphore(options.maxConcurrent));
  }

  async run(input: {
    instruction: string;
    profile: string;
    containerId?: string;
    timeoutMs?: number;
    abortSignal?: AbortSignal;
    onEvent?: (event: IrisEvent) => void;
  }): Promise<IrisRunResult> {
    const release = await this.semaphore.acquire(input.abortSignal);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), input.timeoutMs ?? this.options.requestTimeoutMs);
    const forwardAbort = () => controller.abort();
    input.abortSignal?.addEventListener("abort", forwardAbort, { once: true });
    try {
      const response = await this.fetchImpl(`${this.options.baseUrl.replace(/\/$/, "")}/api/agent/run`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.options.token}`,
          "content-type": "application/json",
          accept: "text/event-stream",
        },
        body: JSON.stringify({
          instruction: input.instruction,
          profile: input.profile,
          ...(input.containerId ? { container_id: input.containerId } : {}),
        }),
        signal: controller.signal,
      });
      if (!response.ok || !response.body) throw new Error(`iris_unavailable: ${response.status}`);
      return await readSse(response.body, input.onEvent);
    } finally {
      clearTimeout(timeout);
      input.abortSignal?.removeEventListener("abort", forwardAbort);
      release();
    }
  }
}

async function readSse(body: ReadableStream<Uint8Array>, onEvent?: (event: IrisEvent) => void): Promise<IrisRunResult> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const events: IrisEvent[] = [];
  let buffer = "";
  let containerId = "";
  let result = "";
  let sawResult = false;
  let explicitStatus: IrisRunResult["status"] | undefined;
  let blocked: IrisRunResult["blocked"];

  const finalize = (): IrisRunResult => {
    const status: IrisRunResult["status"] = explicitStatus ?? (blocked ? "blocked" : sawResult ? "success" : "error");
    return { status, containerId, result, blocked, events };
  };

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    buffer = buffer.replace(/\r\n/g, "\n");
    let separator: number;
    while ((separator = buffer.indexOf("\n\n")) !== -1) {
      const frame = buffer.slice(0, separator);
      buffer = buffer.slice(separator + 2);
      const event = parseSseFrame(frame);
      if (!event) continue;
      events.push(event);
      onEvent?.(event);
      if (event.event === "ready" && typeof event.container_id === "string") containerId = event.container_id;
      if (event.event === "result") {
        const text = typeof event.content === "string" ? event.content : typeof event.output === "string" ? event.output : "";
        result = text;
        sawResult = true;
      }
      if (event.event === "blocked") {
        blocked = { vncUrl: typeof event.vnc_url === "string" ? event.vnc_url : "", reason: typeof event.reason === "string" ? event.reason : "" };
      }
      if (event.event === "done") {
        if (event.status === "success" || event.status === "error" || event.status === "blocked") explicitStatus = event.status;
        await reader.cancel();
        return finalize();
      }
    }
  }

  return finalize();
}

function parseSseFrame(frame: string): IrisEvent | null {
  let eventName = "";
  const dataLines: string[] = [];
  for (const line of frame.split(/\r?\n/)) {
    if (line.startsWith("event:")) eventName = line.slice("event:".length).trim();
    if (line.startsWith("data:")) dataLines.push(line.slice("data:".length).trimStart());
  }
  if (!eventName) return null;
  const data = dataLines.length ? JSON.parse(dataLines.join("\n")) : {};
  return { event: eventName, ...data } as IrisEvent;
}
