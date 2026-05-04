import type { Issue } from "../types.js";

export interface ProjectLocation {
  ownerKind: "org" | "user";
  owner: string;
  number: number;
}

export interface NormalizeOptions {
  statusField: string;
  priorityField: string | null;
  terminalStates: string[];
}

export interface IssueFilters {
  assignee?: string;
  labelRequired?: string[];
  labelExcluded?: string[];
}

export function parseProjectUrl(url: string): ProjectLocation {
  const parsed = new URL(url);
  const match = parsed.pathname.match(/^\/(orgs|users)\/([^/]+)\/projects\/(\d+)\/?$/);
  if (!match) throw new Error("missing_project_identification");
  return {
    ownerKind: match[1] === "orgs" ? "org" : "user",
    owner: match[2],
    number: Number(match[3]),
  };
}

export function normalizeProjectItem(item: any, options: NormalizeOptions): Issue {
  const fields = item.fieldValues?.nodes ?? [];
  const status = singleSelectValue(fields, options.statusField);
  if (!status) throw new Error("status_field_not_found");
  const priorityName = options.priorityField ? singleSelectValue(fields, options.priorityField) : null;
  const content = item.content;
  if (!content) throw new Error("missing_content");
  const type = content?.__typename ?? (content?.number ? "Issue" : "DraftIssue");
  const labels = type === "DraftIssue" ? [] : (content.labels?.nodes ?? []).map((node: any) => String(node.name).toLowerCase());
  const repoFullName = content.repository?.nameWithOwner ?? null;
  const branchName = labels.find((label: string) => label.startsWith("branch:"))?.slice("branch:".length) ?? null;
  const identifier =
    type === "DraftIssue" ? `draft:${String(content.id ?? item.id).slice(0, 8)}` : `${repoFullName}#${content.number}`;
  const terminal = new Set(options.terminalStates.map((state) => state.toLowerCase()));

  return {
    id: item.id,
    contentId: content.id ?? null,
    identifier,
    title: content.title ?? "",
    description: content.body ?? null,
    priority: mapPriority(priorityName),
    state: status,
    branchName,
    url: content.url ?? null,
    labels,
    blockedBy: [
      ...((content.trackedInIssues?.nodes ?? []) as any[])
        .filter((node) => isOpenTrackedIssue(node, terminal))
        .map((node) => ({
          id: node.id,
          identifier: `${node.repository.nameWithOwner}#${node.number}`,
          state: node.state,
        })),
      ...labels
        .map((label: string): RegExpMatchArray | null => label.match(/^blocked-by:([^#]+)#(\d+)$/))
        .filter((match: RegExpMatchArray | null): match is RegExpMatchArray => Boolean(match))
        .map((match: RegExpMatchArray) => ({
          id: `${match[1]}#${match[2]}`,
          identifier: `${match[1]}#${match[2]}`,
          state: "unknown",
        })),
    ],
    createdAt: content.createdAt ?? null,
    updatedAt: content.updatedAt ?? null,
    assignees: (content.assignees?.nodes ?? []).map((node: any) => node.login),
    repoFullName,
  };
}

export function applyIssueFilters<T extends Pick<Issue, "labels" | "assignees">>(issues: T[], filters: IssueFilters): T[] {
  const required = (filters.labelRequired ?? []).map((label) => label.toLowerCase());
  const excluded = new Set((filters.labelExcluded ?? []).map((label) => label.toLowerCase()));
  // GitHub logins are case-insensitive but stored canonical-cased. A
  // workflow that writes `Acme-Bot` would silently match nothing against
  // an `acme-bot` assignment. Compare lowercase on both sides — matches
  // the existing label behavior and tolerates hand-authored configs.
  const wantAssignee = filters.assignee?.toLowerCase();
  return issues.filter((issue) => {
    if (wantAssignee && !issue.assignees.some((a) => a.toLowerCase() === wantAssignee)) return false;
    if (!required.every((label) => issue.labels.includes(label))) return false;
    if (issue.labels.some((label) => excluded.has(label))) return false;
    return true;
  });
}

export class GitHubProjectsTracker {
  private projectId: string | null = null;
  private fieldCache: { statusFieldId?: string; statusOptions?: Record<string, string> } = {};

  constructor(
    private readonly options: {
      endpoint: string;
      apiToken: string;
      projectUrl?: string;
      projectOwner?: string;
      projectNumber?: number;
      statusField: string;
      priorityField: string | null;
      activeStates: string[];
      terminalStates: string[];
      filters?: IssueFilters;
      fetch?: typeof fetch;
    },
  ) {}

  async fetchCandidateIssues(): Promise<Issue[]> {
    const issues = await this.fetchIssuesByStates(this.options.activeStates);
    return applyIssueFilters(issues, this.options.filters ?? {});
  }

  async fetchIssuesByStates(states: string[]): Promise<Issue[]> {
    const projectId = await this.resolveProjectId();
    const wanted = new Set(states.map((state) => state.toLowerCase()));
    const result: Issue[] = [];
    let cursor: string | null = null;
    do {
      const data = await this.graphql(CANDIDATES_QUERY, { projectId, cursor });
      const items = data.node?.items;
      for (const node of items?.nodes ?? []) {
        await this.hydrateFieldValues(node);
        const issue = this.tryNormalizeCandidateItem(node);
        if (!issue) continue;
        if (wanted.has(issue.state.toLowerCase())) result.push(issue);
      }
      cursor = items?.pageInfo?.hasNextPage ? items.pageInfo.endCursor : null;
    } while (cursor);
    return result;
  }

  async fetchIssueStatesByIds(issueIds: string[]): Promise<Record<string, string>> {
    if (issueIds.length === 0) return {};
    const data = await this.graphql(ITEM_STATES_QUERY, { ids: issueIds });
    const states: Record<string, string> = {};
    for (const node of data.nodes ?? []) {
      if (!node) continue;
      await this.hydrateFieldValues(node);
      const status = singleSelectValue(node.fieldValues?.nodes ?? [], this.options.statusField);
      if (status) states[node.id] = status;
    }
    return states;
  }

  async transitionIssue(issue: Pick<Issue, "id">, state: string): Promise<void> {
    const projectId = await this.resolveProjectId();
    const { statusFieldId, statusOptions } = await this.resolveStatusField();
    const optionId = statusOptions[state];
    if (!optionId) throw new Error(`status_field_not_found: option ${state}`);
    await this.graphql(UPDATE_STATUS_MUTATION, {
      projectId,
      itemId: issue.id,
      fieldId: statusFieldId,
      optionId,
    });
  }

  async commentOnIssue(issue: Pick<Issue, "contentId">, body: string): Promise<void> {
    if (!issue.contentId) return;
    await this.graphql(ADD_COMMENT_MUTATION, { subjectId: issue.contentId, body });
  }

  private async resolveProjectId(): Promise<string> {
    if (this.projectId) return this.projectId;
    const location =
      this.options.projectUrl !== undefined
        ? parseProjectUrl(this.options.projectUrl)
        : {
            ownerKind: "unknown" as const,
            owner: this.options.projectOwner ?? "",
            number: this.options.projectNumber ?? 0,
          };
    if (location.ownerKind === "unknown") {
      const orgData = await this.graphql(ORG_PROJECT_QUERY, { owner: location.owner, number: location.number });
      let project = orgData.organization?.projectV2;
      if (!project?.id) {
        const userData = await this.graphql(USER_PROJECT_QUERY, { owner: location.owner, number: location.number });
        project = userData.user?.projectV2;
      }
      if (!project?.id) throw new Error("project_not_found");
      this.projectId = String(project.id);
      return this.projectId;
    }
    const query = location.ownerKind === "org" ? ORG_PROJECT_QUERY : USER_PROJECT_QUERY;
    const data = await this.graphql(query, { owner: location.owner, number: location.number });
    const project = location.ownerKind === "org" ? data.organization?.projectV2 : data.user?.projectV2;
    if (!project?.id) throw new Error("project_not_found");
    this.projectId = String(project.id);
    return this.projectId;
  }

  private tryNormalizeCandidateItem(node: any): Issue | null {
    try {
      return normalizeProjectItem(node, {
        statusField: this.options.statusField,
        priorityField: this.options.priorityField,
        terminalStates: this.options.terminalStates,
      });
    } catch (error) {
      if (error instanceof Error && (error.message === "status_field_not_found" || error.message === "missing_content")) return null;
      throw error;
    }
  }

  private async hydrateFieldValues(node: any): Promise<void> {
    let pageInfo = node.fieldValues?.pageInfo;
    if (!pageInfo?.hasNextPage) return;
    const nodes = [...(node.fieldValues?.nodes ?? [])];
    let cursor = pageInfo.endCursor ?? null;
    while (pageInfo?.hasNextPage) {
      const data = await this.graphql(ITEM_FIELD_VALUES_QUERY, { itemId: node.id, cursor });
      const fieldValues = data.node?.fieldValues;
      nodes.push(...(fieldValues?.nodes ?? []));
      pageInfo = fieldValues?.pageInfo;
      cursor = pageInfo?.endCursor ?? null;
    }
    node.fieldValues = {
      ...(node.fieldValues ?? {}),
      nodes,
      pageInfo: pageInfo ?? { hasNextPage: false, endCursor: null },
    };
  }

  private async resolveStatusField(): Promise<{ statusFieldId: string; statusOptions: Record<string, string> }> {
    if (this.fieldCache.statusFieldId && this.fieldCache.statusOptions) {
      return { statusFieldId: this.fieldCache.statusFieldId, statusOptions: this.fieldCache.statusOptions };
    }
    const projectId = await this.resolveProjectId();
    const data = await this.graphql(PROJECT_FIELDS_QUERY, { projectId });
    for (const field of data.node?.fields?.nodes ?? []) {
      if (field?.name === this.options.statusField) {
        this.fieldCache = {
          statusFieldId: field.id,
          statusOptions: Object.fromEntries((field.options ?? []).map((option: any) => [option.name, option.id])),
        };
        return { statusFieldId: this.fieldCache.statusFieldId!, statusOptions: this.fieldCache.statusOptions! };
      }
    }
    throw new Error("status_field_not_found");
  }

  private async graphql(query: string, variables: Record<string, unknown>): Promise<any> {
    const fetchImpl = this.options.fetch ?? fetch;
    const response = await fetchImpl(this.options.endpoint, {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.options.apiToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ query, variables }),
    });
    if (!response.ok) throw new Error(`github_api_status: ${response.status}`);
    const payload = await response.json();
    if (payload.errors?.length) throw new Error(`github_graphql_errors: ${payload.errors[0].message}`);
    return payload.data;
  }
}

function singleSelectValue(nodes: any[], fieldName: string): string | null {
  return nodes.find((node) => node?.field?.name === fieldName && typeof node.name === "string")?.name ?? null;
}

function mapPriority(name: string | null): number | null {
  if (!name) return null;
  return ({ P0: 1, P1: 2, P2: 3, P3: 4 } as Record<string, number>)[name] ?? null;
}

function isOpenTrackedIssue(node: any, terminal: Set<string>): boolean {
  const state = String(node.state ?? "").toLowerCase();
  if (state === "closed") return false;
  return !terminal.has(state);
}

const ORG_PROJECT_QUERY = `query Project($owner: String!, $number: Int!) { organization(login: $owner) { projectV2(number: $number) { id } } }`;
const USER_PROJECT_QUERY = `query Project($owner: String!, $number: Int!) { user(login: $owner) { projectV2(number: $number) { id } } }`;
const CANDIDATES_QUERY = `query Candidates($projectId: ID!, $cursor: String) {
  node(id: $projectId) { ... on ProjectV2 { items(first: 50, after: $cursor) {
    pageInfo { hasNextPage endCursor }
    nodes { id fieldValues(first: 20) { pageInfo { hasNextPage endCursor } nodes { ... on ProjectV2ItemFieldSingleSelectValue { name field { ... on ProjectV2SingleSelectField { name } } } } }
      content {
        ... on Issue { __typename id number title body url state createdAt updatedAt repository { nameWithOwner } labels(first: 50) { nodes { name } } assignees(first: 20) { nodes { login } } trackedInIssues(first: 20) { nodes { id number state repository { nameWithOwner } } } }
        ... on PullRequest { __typename id number title body url state createdAt updatedAt repository { nameWithOwner } labels(first: 50) { nodes { name } } assignees(first: 20) { nodes { login } } }
        ... on DraftIssue { __typename id title body createdAt updatedAt }
      }
    }
  } } }
}`;
const ITEM_STATES_QUERY = `query ItemStates($ids: [ID!]!) { nodes(ids: $ids) { ... on ProjectV2Item { id fieldValues(first: 20) { pageInfo { hasNextPage endCursor } nodes { ... on ProjectV2ItemFieldSingleSelectValue { name field { ... on ProjectV2SingleSelectField { name } } } } } } } }`;
const ITEM_FIELD_VALUES_QUERY = `query ItemFieldValues($itemId: ID!, $cursor: String) { node(id: $itemId) { ... on ProjectV2Item { id fieldValues(first: 20, after: $cursor) { pageInfo { hasNextPage endCursor } nodes { ... on ProjectV2ItemFieldSingleSelectValue { name field { ... on ProjectV2SingleSelectField { name } } } } } } } }`;
const PROJECT_FIELDS_QUERY = `query Fields($projectId: ID!) { node(id: $projectId) { ... on ProjectV2 { fields(first: 50) { nodes { ... on ProjectV2SingleSelectField { id name options { id name } } } } } } }`;
const UPDATE_STATUS_MUTATION = `mutation UpdateStatus($projectId: ID!, $itemId: ID!, $fieldId: ID!, $optionId: String!) { updateProjectV2ItemFieldValue(input: { projectId: $projectId, itemId: $itemId, fieldId: $fieldId, value: { singleSelectOptionId: $optionId } }) { projectV2Item { id } } }`;
const ADD_COMMENT_MUTATION = `mutation AddComment($subjectId: ID!, $body: String!) { addComment(input: { subjectId: $subjectId, body: $body }) { commentEdge { node { id } } } }`;
