// Shared GitHub GraphQL helpers used by setup-time scripts (init.mjs,
// project-checks.mjs). Run-time daemon code uses src/tracker/github_projects.ts
// instead — that one is class-scoped with injected endpoint/fetch for tests.
//
// `fetchImpl` defaults to the global `fetch` (Node 22+) so callers that
// don't need to inject a stub can call `graphql(token, query, vars)` directly.
// Tests inject a fake to avoid network.

export async function graphql(token, query, variables, fetchImpl = globalThis.fetch) {
  const response = await fetchImpl("https://api.github.com/graphql", {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      "user-agent": "symphony-init/0.1",
    },
    body: JSON.stringify({ query, variables: variables ?? null }),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${(await response.text()).slice(0, 200)}`);
  const body = await response.json();
  if (body.errors?.length) throw new Error(body.errors.map((e) => e.message).join("; "));
  return body.data;
}

// Parse a GitHub Projects v2 URL like:
//   https://github.com/orgs/foo/projects/3
//   https://github.com/users/foo/projects/3
// Returns `{ scope, owner, number }` or null. Anchored so it doesn't match
// substrings hidden inside another URL.
const PROJECT_URL_RE = /^https?:\/\/github\.com\/(orgs|users)\/([^/]+)\/projects\/(\d+)\/?$/;

export function parseProjectUrl(url) {
  const match = url.match(PROJECT_URL_RE);
  if (!match) return null;
  return { scope: match[1], owner: match[2], number: parseInt(match[3], 10) };
}
