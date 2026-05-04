import { describe, expect, it, vi } from "vitest";
import {
  applyIssueFilters,
  GitHubProjectsTracker,
  normalizeProjectItem,
  parseProjectUrl,
} from "../src/tracker/github_projects.js";

describe("GitHub Projects tracker helpers", () => {
  it("parses org and user project URLs", () => {
    expect(parseProjectUrl("https://github.com/orgs/ltk-global/projects/7")).toEqual({
      ownerKind: "org",
      owner: "ltk-global",
      number: 7,
    });
    expect(parseProjectUrl("https://github.com/users/octocat/projects/3")).toEqual({
      ownerKind: "user",
      owner: "octocat",
      number: 3,
    });
  });

  it("normalizes project items and blocked-by labels", () => {
    const issue = normalizeProjectItem(
      {
        id: "PVI_1",
        fieldValues: {
          nodes: [
            { name: "Todo", field: { name: "Status" } },
            { name: "P1", field: { name: "Priority" } },
          ],
        },
        content: {
          __typename: "Issue",
          id: "I_1",
          number: 42,
          title: "Fix login",
          body: "Body",
          url: "https://github.com/ltk-global/web/issues/42",
          state: "OPEN",
          createdAt: "2026-04-01T00:00:00Z",
          updatedAt: "2026-04-02T00:00:00Z",
          repository: { nameWithOwner: "ltk-global/web" },
          labels: { nodes: [{ name: "Bug" }, { name: "blocked-by:ltk-global/api#5" }, { name: "branch:fix-login" }] },
          assignees: { nodes: [{ login: "ltk-symphony-bot" }] },
          trackedInIssues: {
            nodes: [{ id: "I_0", number: 4, state: "OPEN", repository: { nameWithOwner: "ltk-global/api" } }],
          },
        },
      },
      {
        statusField: "Status",
        priorityField: "Priority",
        terminalStates: ["Done"],
      },
    );

    expect(issue).toMatchObject({
      id: "PVI_1",
      contentId: "I_1",
      identifier: "ltk-global/web#42",
      priority: 2,
      state: "Todo",
      branchName: "fix-login",
      labels: ["bug", "blocked-by:ltk-global/api#5", "branch:fix-login"],
      repoFullName: "ltk-global/web",
    });
    expect(issue.blockedBy).toHaveLength(2);
  });

  it("does not treat closed tracked issues as blockers", () => {
    const issue = normalizeProjectItem(
      {
        id: "PVI_1",
        fieldValues: {
          nodes: [{ name: "Todo", field: { name: "Status" } }],
        },
        content: {
          __typename: "Issue",
          id: "I_1",
          number: 42,
          title: "Fix login",
          body: "Body",
          url: "https://github.com/ltk-global/web/issues/42",
          state: "OPEN",
          createdAt: "2026-04-01T00:00:00Z",
          updatedAt: "2026-04-02T00:00:00Z",
          repository: { nameWithOwner: "ltk-global/web" },
          labels: { nodes: [] },
          assignees: { nodes: [] },
          trackedInIssues: {
            nodes: [
              { id: "I_0", number: 4, state: "CLOSED", repository: { nameWithOwner: "ltk-global/api" } },
              { id: "I_2", number: 6, state: "OPEN", repository: { nameWithOwner: "ltk-global/api" } },
            ],
          },
        },
      },
      { statusField: "Status", priorityField: "Priority", terminalStates: ["Done"] },
    );

    expect(issue.blockedBy).toEqual([
      {
        id: "I_2",
        identifier: "ltk-global/api#6",
        state: "OPEN",
      },
    ]);
  });

  it("preserves pull request assignees during normalization", () => {
    const issue = normalizeProjectItem(
      {
        id: "PVI_pr",
        fieldValues: {
          nodes: [{ name: "Todo", field: { name: "Status" } }],
        },
        content: {
          __typename: "PullRequest",
          id: "PR_1",
          number: 12,
          title: "Update copy",
          body: "Body",
          url: "https://github.com/ltk-global/web/pull/12",
          state: "OPEN",
          createdAt: "2026-04-01T00:00:00Z",
          updatedAt: "2026-04-02T00:00:00Z",
          repository: { nameWithOwner: "ltk-global/web" },
          labels: { nodes: [] },
          assignees: { nodes: [{ login: "ltk-symphony-bot" }] },
        },
      },
      { statusField: "Status", priorityField: "Priority", terminalStates: ["Done"] },
    );

    expect(issue.assignees).toEqual(["ltk-symphony-bot"]);
  });

  it("applies assignee and label filters", () => {
    const issues = [
      { identifier: "a#1", assignees: ["bot"], labels: ["ready"], state: "Todo" },
      { identifier: "a#2", assignees: ["bot"], labels: ["ready", "wip"], state: "Todo" },
      { identifier: "a#3", assignees: ["human"], labels: ["ready"], state: "Todo" },
    ] as any[];

    expect(
      applyIssueFilters(issues, {
        assignee: "bot",
        labelRequired: ["ready"],
        labelExcluded: ["wip"],
      }).map((i) => i.identifier),
    ).toEqual(["a#1"]);
  });

  it("matches assignees case-insensitively (GitHub logins are stored canonical-cased)", () => {
    // Workflow author wrote `Acme-Bot` but the issue's assignees array has
    // GitHub's canonical form `acme-bot`. The filter MUST still match.
    const issues = [
      { identifier: "a#1", assignees: ["acme-bot"], labels: [], state: "Todo" },
      { identifier: "a#2", assignees: ["someone-else"], labels: [], state: "Todo" },
    ] as any[];
    expect(
      applyIssueFilters(issues, { assignee: "Acme-Bot" }).map((i) => i.identifier),
    ).toEqual(["a#1"]);
  });

  it("resolves owner/number projects for user owners when organization lookup misses", async () => {
    const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      if (body.query.includes("organization(")) return jsonResponse({ data: { organization: { projectV2: null } } });
      if (body.query.includes("user(")) return jsonResponse({ data: { user: { projectV2: { id: "PV_user" } } } });
      return candidatesResponse([]);
    });
    const tracker = new GitHubProjectsTracker({
      endpoint: "https://api.github.com/graphql",
      apiToken: "ghp_test",
      projectOwner: "octocat",
      projectNumber: 3,
      statusField: "Status",
      priorityField: "Priority",
      activeStates: ["Todo"],
      terminalStates: ["Done"],
      fetch: fetchImpl as any,
    });

    await expect(tracker.fetchCandidateIssues()).resolves.toEqual([]);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it("skips project items that have no configured Status value", async () => {
    const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      if (body.query.includes("organization(")) return jsonResponse({ data: { organization: { projectV2: { id: "PV_org" } } } });
      return candidatesResponse([
        projectItem({ id: "PVI_no_status", status: null, number: 1 }),
        projectItem({ id: "PVI_todo", status: "Todo", number: 2 }),
      ]);
    });
    const tracker = new GitHubProjectsTracker({
      endpoint: "https://api.github.com/graphql",
      apiToken: "ghp_test",
      projectOwner: "ltk-global",
      projectNumber: 7,
      statusField: "Status",
      priorityField: "Priority",
      activeStates: ["Todo"],
      terminalStates: ["Done"],
      fetch: fetchImpl as any,
    });

    await expect(tracker.fetchCandidateIssues()).resolves.toMatchObject([{ id: "PVI_todo" }]);
  });

  it("skips project items with missing content", async () => {
    const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      if (body.query.includes("organization(")) return jsonResponse({ data: { organization: { projectV2: { id: "PV_org" } } } });
      return candidatesResponse([
        {
          id: "PVI_missing_content",
          fieldValues: { nodes: [{ name: "Todo", field: { name: "Status" } }] },
          content: null,
        },
        projectItem({ id: "PVI_todo", status: "Todo", number: 2 }),
      ]);
    });
    const tracker = new GitHubProjectsTracker({
      endpoint: "https://api.github.com/graphql",
      apiToken: "ghp_test",
      projectOwner: "ltk-global",
      projectNumber: 7,
      statusField: "Status",
      priorityField: "Priority",
      activeStates: ["Todo"],
      terminalStates: ["Done"],
      fetch: fetchImpl as any,
    });

    await expect(tracker.fetchCandidateIssues()).resolves.toMatchObject([{ id: "PVI_todo" }]);
  });

  it("fetches additional field value pages when Status is past the first field page", async () => {
    const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      if (body.query.includes("organization(")) return jsonResponse({ data: { organization: { projectV2: { id: "PV_org" } } } });
      if (body.query.includes("ItemFieldValues")) {
        return jsonResponse({
          data: {
            node: {
              id: "PVI_late_status",
              fieldValues: {
                pageInfo: { hasNextPage: false, endCursor: null },
                nodes: [{ name: "Todo", field: { name: "Status" } }],
              },
            },
          },
        });
      }
      return jsonResponse({
        data: {
          node: {
            items: {
              pageInfo: { hasNextPage: false, endCursor: null },
              nodes: [
                {
                  ...projectItem({ id: "PVI_late_status", status: null, number: 2 }),
                  fieldValues: {
                    pageInfo: { hasNextPage: true, endCursor: "field_cursor_1" },
                    nodes: Array.from({ length: 20 }, (_, index) => ({
                      name: `Value ${index}`,
                      field: { name: `Field ${index}` },
                    })),
                  },
                },
              ],
            },
          },
        },
      });
    });
    const tracker = new GitHubProjectsTracker({
      endpoint: "https://api.github.com/graphql",
      apiToken: "ghp_test",
      projectOwner: "ltk-global",
      projectNumber: 7,
      statusField: "Status",
      priorityField: "Priority",
      activeStates: ["Todo"],
      terminalStates: ["Done"],
      fetch: fetchImpl as any,
    });

    await expect(tracker.fetchCandidateIssues()).resolves.toMatchObject([{ id: "PVI_late_status", state: "Todo" }]);
    const candidateRequest = fetchImpl.mock.calls.find(([, init]) => JSON.parse(String(init.body)).query.includes("Candidates"));
    expect(JSON.parse(String(candidateRequest?.[1].body)).query).toContain("pageInfo { hasNextPage endCursor }");
  });

  it("paginates field values when refreshing issue states by id", async () => {
    const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      if (body.query.includes("ItemFieldValues")) {
        return jsonResponse({
          data: {
            node: {
              id: "PVI_late_status",
              fieldValues: {
                pageInfo: { hasNextPage: false, endCursor: null },
                nodes: [{ name: "Done", field: { name: "Status" } }],
              },
            },
          },
        });
      }
      return jsonResponse({
        data: {
          nodes: [
            {
              id: "PVI_late_status",
              fieldValues: {
                pageInfo: { hasNextPage: true, endCursor: "field_cursor_1" },
                nodes: Array.from({ length: 20 }, (_, index) => ({
                  name: `Value ${index}`,
                  field: { name: `Field ${index}` },
                })),
              },
            },
          ],
        },
      });
    });
    const tracker = new GitHubProjectsTracker({
      endpoint: "https://api.github.com/graphql",
      apiToken: "ghp_test",
      projectOwner: "ltk-global",
      projectNumber: 7,
      statusField: "Status",
      priorityField: "Priority",
      activeStates: ["Todo"],
      terminalStates: ["Done"],
      fetch: fetchImpl as any,
    });

    await expect(tracker.fetchIssueStatesByIds(["PVI_late_status"])).resolves.toEqual({ PVI_late_status: "Done" });
  });
});

function jsonResponse(payload: unknown) {
  return new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json" } });
}

function candidatesResponse(nodes: any[]) {
  return jsonResponse({
    data: {
      node: {
        items: {
          pageInfo: { hasNextPage: false, endCursor: null },
          nodes,
        },
      },
    },
  });
}

function projectItem(input: { id: string; status: string | null; number: number }) {
  return {
    id: input.id,
    fieldValues: {
      nodes: [
        ...(input.status ? [{ name: input.status, field: { name: "Status" } }] : []),
        { name: "P2", field: { name: "Priority" } },
      ],
    },
    content: {
      __typename: "Issue",
      id: `I_${input.number}`,
      number: input.number,
      title: "Issue",
      body: "",
      url: `https://github.com/ltk-global/web/issues/${input.number}`,
      state: "OPEN",
      createdAt: "2026-04-01T00:00:00Z",
      updatedAt: "2026-04-02T00:00:00Z",
      repository: { nameWithOwner: "ltk-global/web" },
      labels: { nodes: [] },
      assignees: { nodes: [] },
      trackedInIssues: { nodes: [] },
    },
  };
}
