import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it, vi } from "vitest";
import { IrisClient } from "../src/iris/client.js";
import { Semaphore } from "../src/iris/semaphore.js";

function sseResponse(chunks: string[]) {
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
        controller.close();
      },
    }),
    { status: 200, headers: { "content-type": "text/event-stream" } },
  );
}

describe("IRIS client", () => {
  it("acquires semaphore slots in FIFO order", async () => {
    const semaphore = new Semaphore(1);
    const release1 = await semaphore.acquire();
    const order: string[] = [];
    const second = semaphore.acquire().then((release) => {
      order.push("second");
      release();
    });
    const third = semaphore.acquire().then((release) => {
      order.push("third");
      release();
    });

    release1();
    await Promise.all([second, third]);
    expect(order).toEqual(["second", "third"]);
  });

  it("parses success and blocked SSE events", async () => {
    const fetchImpl = vi.fn(async () =>
      sseResponse([
        'event: ready\ndata: {"container_id":"c1"}\n\n',
        'event: result\ndata: {"output":"{\\"pass\\":true}"}\n\n',
        'event: done\ndata: {"status":"success"}\n\n',
      ]),
    );
    const client = new IrisClient({
      baseUrl: "https://swarmy.firsttofly.com",
      token: "swm_test",
      maxConcurrent: 1,
      requestTimeoutMs: 10_000,
      fetch: fetchImpl as any,
    });

    const result = await client.run({ instruction: "Test", profile: "default" });
    expect(result.status).toBe("success");
    expect(result.containerId).toBe("c1");
    expect(result.result).toBe('{"pass":true}');
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://swarmy.firsttofly.com/api/agent/run",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("parses standards-compliant CRLF SSE frame delimiters", async () => {
    const fetchImpl = vi.fn(async () =>
      sseResponse([
        'event: ready\r\ndata: {"container_id":"c1"}\r\n\r\n',
        'event: result\r\ndata: {"output":"ok"}\r\n\r\n',
        'event: done\r\ndata: {"status":"success"}\r\n\r\n',
      ]),
    );
    const client = new IrisClient({
      baseUrl: "https://swarmy.firsttofly.com",
      token: "swm_test",
      maxConcurrent: 1,
      requestTimeoutMs: 10_000,
      fetch: fetchImpl as any,
    });

    const result = await client.run({ instruction: "Test", profile: "default" });

    expect(result.status).toBe("success");
    expect(result.containerId).toBe("c1");
    expect(result.result).toBe("ok");
  });

  it("resolves when a done event arrives even if the SSE stream stays open", async () => {
    const encoder = new TextEncoder();
    const fetchImpl = vi.fn(async () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(encoder.encode('event: done\ndata: {"status":"success"}\n\n'));
          },
        }),
        { status: 200, headers: { "content-type": "text/event-stream" } },
      ),
    );
    const client = new IrisClient({
      baseUrl: "https://swarmy.firsttofly.com",
      token: "swm_test",
      maxConcurrent: 1,
      requestTimeoutMs: 10_000,
      fetch: fetchImpl as any,
    });

    await expect(
      Promise.race([
        client.run({ instruction: "Test", profile: "default" }),
        new Promise((_, reject) => setTimeout(() => reject(new Error("timed out waiting for done")), 50)),
      ]),
    ).resolves.toMatchObject({ status: "success" });
  });

  it("shares semaphore capacity across IrisClient instances with the same shared key", async () => {
    const root = await mkdtemp(join(tmpdir(), "symphony-iris-test-"));
    const encoder = new TextEncoder();
    const controllers: ReadableStreamDefaultController<Uint8Array>[] = [];
    const fetchImpl = vi.fn(async () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controllers.push(controller);
          },
        }),
        { status: 200, headers: { "content-type": "text/event-stream" } },
      ),
    );
    const options = {
      baseUrl: "https://swarmy.firsttofly.com",
      token: "swm_test",
      maxConcurrent: 1,
      requestTimeoutMs: 10_000,
      fetch: fetchImpl as any,
      sharedSemaphoreKey: "test-key",
      sharedSemaphoreRoot: root,
    };
    const first = new IrisClient(options);
    const second = new IrisClient(options);

    const firstRun = first.run({ instruction: "one", profile: "default" });
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(1));
    const secondRun = second.run({ instruction: "two", profile: "default" });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    controllers[0].enqueue(encoder.encode('event: done\ndata: {"status":"success"}\n\n'));
    await expect(firstRun).resolves.toMatchObject({ status: "success" });
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(2));
    controllers[1].enqueue(encoder.encode('event: done\ndata: {"status":"success"}\n\n'));
    await expect(secondRun).resolves.toMatchObject({ status: "success" });
  });
});
