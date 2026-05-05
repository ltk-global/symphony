import { describe, expect, it, vi } from "vitest";
import { parseVerifyResult, resolveVerifyUrl, VerifyStage } from "../src/verify/stage.js";

const issue: any = {
  id: "PVI_1",
  identifier: "ltk-global/web#42",
  title: "Fix login",
  description: "Login should work",
  labels: ["deploy:https://preview.example.com"],
  state: "Todo",
};

describe("verify stage", () => {
  it("resolves URLs from agent output, labels, and static config", () => {
    expect(
      resolveVerifyUrl(issue, { finalMessages: ['{"verify_url":"https://agent.example.com"}'] }, {
        urlSource: ["agent_output", "label"],
        agentOutputKey: "verify_url",
        urlLabelPrefix: "deploy:",
        urlStatic: "",
      }),
    ).toMatchObject({ url: "https://agent.example.com", source: "agent_output", attemptedSources: ["agent_output"], rejected: [] });

    expect(
      resolveVerifyUrl(issue, { finalMessages: ["not-json"] }, {
        urlSource: ["agent_output", "label"],
        agentOutputKey: "verify_url",
        urlLabelPrefix: "deploy:",
        urlStatic: "",
      }),
    ).toMatchObject({ url: "https://preview.example.com", source: "label" });
  });

  it("rejects github.com URLs and falls through to the next source", () => {
    // Agent emitted a PR URL (the bug we're guarding against). Verifier
    // should skip it, fall through to label, and report the rejection.
    const result = resolveVerifyUrl(
      issue,
      { finalMessages: ['{"verify_url":"https://github.com/acme/web/pull/15"}'] },
      {
        urlSource: ["agent_output", "label"],
        agentOutputKey: "verify_url",
        urlLabelPrefix: "deploy:",
        urlStatic: "",
      },
    );
    expect(result).toMatchObject({
      url: "https://preview.example.com",
      source: "label",
      attemptedSources: ["agent_output", "label"],
    });
    expect(result.rejected).toHaveLength(1);
    expect(result.rejected[0]).toMatchObject({
      url: "https://github.com/acme/web/pull/15",
      source: "agent_output",
    });
    expect(result.rejected[0].reason).toMatch(/github\.com/);
  });

  it("returns no URL (with rejection log) when every source emits a github.com URL", () => {
    const issueWithBadLabel = { ...issue, labels: ["deploy:https://github.com/acme/web/issues/1"] };
    const result = resolveVerifyUrl(
      issueWithBadLabel,
      { finalMessages: ['{"verify_url":"https://github.com/acme/web/pull/15"}'] },
      {
        urlSource: ["agent_output", "label"],
        agentOutputKey: "verify_url",
        urlLabelPrefix: "deploy:",
        urlStatic: "",
      },
    );
    expect(result.url).toBeNull();
    expect(result.rejected).toHaveLength(2);
    expect(result.attemptedSources).toEqual(["agent_output", "label"]);
  });

  it("accepts non-github.com URLs and GitHub Pages URLs (different host)", () => {
    const result = resolveVerifyUrl(
      { labels: [] },
      { finalMessages: ['{"verify_url":"https://acme.github.io/web/"}'] },
      {
        urlSource: ["agent_output"],
        agentOutputKey: "verify_url",
        urlLabelPrefix: "deploy:",
        urlStatic: "",
      },
    );
    expect(result.url).toBe("https://acme.github.io/web/");
  });

  it("rejects gist.github.com / raw.githubusercontent.com / github.dev", () => {
    // P1 finding from review: original guard was github.com-only. These
    // hosts all serve GitHub UI/content, never the deployed app.
    for (const url of [
      "https://gist.github.com/acme/abc123",
      "https://raw.githubusercontent.com/acme/web/main/README.md",
      "https://gist.githubusercontent.com/acme/abc123/raw/file.txt",
      "https://avatars.githubusercontent.com/u/1234",
      "https://github.dev/acme/web/pull/15",
    ]) {
      const result = resolveVerifyUrl(
        { labels: [] },
        { finalMessages: [`{"verify_url":"${url}"}`] },
        {
          urlSource: ["agent_output"],
          agentOutputKey: "verify_url",
          urlLabelPrefix: "deploy:",
          urlStatic: "",
        },
      );
      expect(result.url, `${url} should be rejected`).toBeNull();
      expect(result.rejected[0]?.url).toBe(url);
    }
  });

  it("rejects a github.com URL via the static source too (defense in depth)", () => {
    // Operator might write a verify.url_static that's a PR/issue URL — same
    // shape of error, same rejection. Otherwise a misconfigured workflow
    // skips the runtime guard.
    const result = resolveVerifyUrl(
      { labels: [] },
      { finalMessages: [] },
      {
        urlSource: ["static"],
        agentOutputKey: "verify_url",
        urlLabelPrefix: "deploy:",
        urlStatic: "https://github.com/acme/web/pull/15",
      },
    );
    expect(result.url).toBeNull();
    expect(result.rejected).toHaveLength(1);
    expect(result.rejected[0].source).toBe("static");
  });

  it("parses the last JSON line of an IRIS result", () => {
    expect(parseVerifyResult('progress\n{"pass":false,"summary":"broken","evidence_url":null}')).toEqual({
      pass: false,
      summary: "broken",
      evidenceUrl: null,
    });
    expect(parseVerifyResult("not-json").summary).toContain("not parseable");
  });

  it("transitions on pass and queues feedback on retryable fail", async () => {
    const tracker = { transitionIssue: vi.fn(), commentOnIssue: vi.fn() };
    const iris = { run: vi.fn(async () => ({ status: "success", result: '{"pass":false,"summary":"bad"}', containerId: "c1", events: [] })) };
    const stage = new VerifyStage({ tracker: tracker as any, iris: iris as any });

    const first = await stage.run({
      issue,
      lastTurn: { finalMessages: ['{"verify_url":"https://agent.example.com"}'] },
      config: {
        urlSource: "agent_output",
        agentOutputKey: "verify_url",
        urlLabelPrefix: "deploy:",
        urlStatic: "",
        profile: "",
        instructionTemplate: "Visit {{ verify_url }} for {{ issue.title }}",
        onPass: { transitionTo: "In Review", commentTemplate: "pass {{ result.summary }}" },
        onFail: {
          maxAttempts: 2,
          feedbackTemplate: "fail {{ result.summary }}",
          finalTransitionTo: "Needs Human",
          finalCommentTemplate: "final {{ result.summary }}",
        },
        onNoUrl: { transitionTo: "Needs Human", commentTemplate: "no url" },
      },
      irisConfig: { defaultProfile: "default", profileOverrides: {}, onBlocked: "fail" },
    });

    expect(first.kind).toBe("retry");
    if (first.kind !== "retry") throw new Error("expected retry");
    expect(first.feedback).toBe("fail bad");
    expect(tracker.transitionIssue).not.toHaveBeenCalled();
  });

  it("returns kind: passed even when transitionIssue throws (regression: would otherwise loop IRIS)", async () => {
    // Reproduces the bug found during the IRIS e2e test on 2026-04-29:
    //   verify passed on a real ngrok URL, IRIS reported pass + summary,
    //   tracker.transitionIssue threw "status_field_not_found: option In Review"
    //   (the project didn't have that Status option). The throw bubbled up,
    //   the orchestrator's session_consumer caught it and called scheduleRetry,
    //   which re-dispatched the agent, which re-emitted VERIFY_REQUESTED, which
    //   re-ran IRIS — burning ~2 minutes of IRIS time per loop.
    //
    // Fix: comment + transition are now best-effort side effects of a verify
    // outcome. Failures emit verify_comment_failed / verify_transition_failed
    // but never invalidate the kind: "passed" return.
    const events: Array<{ type: string; payload?: Record<string, unknown> }> = [];
    const eventLog = { emit: async (e: any) => { events.push({ type: e.type, payload: e.payload }); } };
    const tracker = {
      transitionIssue: vi.fn(async () => { throw new Error("status_field_not_found: option In Review"); }),
      commentOnIssue: vi.fn(),
    };
    const iris = { run: vi.fn(async () => ({ status: "success", result: '{"pass":true,"summary":"all good"}', containerId: "c2", events: [] })) };
    const stage = new VerifyStage({ tracker: tracker as any, iris: iris as any, eventLog: eventLog as any });

    const result = await stage.run({
      issue,
      lastTurn: { finalMessages: ['{"verify_url":"https://agent.example.com"}'] },
      config: {
        urlSource: "agent_output",
        agentOutputKey: "verify_url",
        urlLabelPrefix: "deploy:",
        urlStatic: "",
        profile: "",
        instructionTemplate: "Visit {{ verify_url }}",
        onPass: { transitionTo: "In Review", commentTemplate: "pass {{ result.summary }}" },
        onFail: { maxAttempts: 2, feedbackTemplate: "fail", finalTransitionTo: "Needs Human", finalCommentTemplate: "final" },
        onNoUrl: { transitionTo: "Needs Human", commentTemplate: "no url" },
      },
      irisConfig: { defaultProfile: "default", profileOverrides: {}, onBlocked: "fail" },
    });

    expect(result.kind).toBe("passed");
    expect(tracker.commentOnIssue).toHaveBeenCalledTimes(1);
    expect(tracker.transitionIssue).toHaveBeenCalledTimes(1);
    const types = events.map((e) => e.type);
    expect(types).toContain("verify_passed");
    expect(types).toContain("verify_transition_failed");
    const failure = events.find((e) => e.type === "verify_transition_failed");
    expect(failure?.payload).toMatchObject({ stage: "on_pass", target: "In Review" });
  });
});
