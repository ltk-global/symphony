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
    ).toEqual({ url: "https://agent.example.com", source: "agent_output", attemptedSources: ["agent_output"] });

    expect(
      resolveVerifyUrl(issue, { finalMessages: ["not-json"] }, {
        urlSource: ["agent_output", "label"],
        agentOutputKey: "verify_url",
        urlLabelPrefix: "deploy:",
        urlStatic: "",
      }),
    ).toMatchObject({ url: "https://preview.example.com", source: "label" });
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
});
