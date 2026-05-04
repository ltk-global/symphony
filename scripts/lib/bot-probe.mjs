// GitHub Projects v2 — bot-account probes used by the wizard's "set up a
// bot account now" walkthrough. Each takes a `graphql(query, variables)`
// callable so they can be unit-tested against a fake. Both functions are
// best-effort: a `null` from `user(login:)` means "not found", but a thrown
// error usually means the operator's PAT lacks read scope on that account.
// Callers handle the recovery; the helpers just answer the question.

const USER_EXISTS_QUERY = `
  query($login: String!) {
    user(login: $login) { login }
  }
`;

// Org-membership probe via REST: `GET /orgs/<org>/members/<user>` returns
// 204 (member) / 404 (not a member) / 302 (must auth). GraphQL's
// `Organization.membersWithRole` does NOT accept a `query` arg per the
// public schema, so prefix-match probes silently fail at the GraphQL
// layer. REST is the only documented exact-match for this question short
// of paginating every member of the org client-side.

// Resolve a GitHub login to its canonical-cased form, or null if unknown.
// `user(login:)` is case-insensitive but always returns the login in the
// user's chosen casing; using THAT as the workflow's `filters.assignee`
// avoids a runtime mismatch when the operator typed a different casing.
// Truthy → user exists (and the string IS the canonical form).
export async function resolveUserLogin(graphql, login) {
  try {
    const data = await graphql(USER_EXISTS_QUERY, { login });
    return data?.user?.login ?? null;
  } catch (error) {
    // GitHub returns a top-level GraphQL error (not `user: null`) when the
    // login is unknown. Recognize that shape and return null; let other
    // errors (rate limit, network, scope) propagate so callers can surface them.
    const msg = error instanceof Error ? error.message : String(error);
    if (/could not resolve to a user/i.test(msg)) return null;
    throw error;
  }
}

// Convenience boolean form for callers that don't need the canonical login.
export async function userExists(graphql, login) {
  return Boolean(await resolveUserLogin(graphql, login));
}

export async function userIsOrgMember(token, org, login, { fetchImpl = globalThis.fetch } = {}) {
  const url = `https://api.github.com/orgs/${encodeURIComponent(org)}/members/${encodeURIComponent(login)}`;
  const resp = await fetchImpl(url, {
    method: "GET",
    headers: {
      authorization: `Bearer ${token}`,
      "user-agent": "symphony-init/0.1",
      accept: "application/vnd.github+json",
    },
    redirect: "manual",
  });
  if (resp.status === 204) return true;
  if (resp.status === 404) return false;
  // 302: caller is anonymous (token rejected). 403: caller can't see org
  // membership (token lacks read:org, or this is a private membership we
  // can't read). 401: bad token. None are the same as "not a member" —
  // throw so callers can distinguish "couldn't probe" and warn cleanly.
  throw new Error(`couldn't read org membership for '${login}' in '${org}': HTTP ${resp.status}`);
}
