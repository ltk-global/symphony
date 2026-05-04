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

// `membersWithRole(query: ...)` returns matches by login prefix; we filter
// the page client-side to require an exact case-insensitive match. The
// page size of 5 keeps the response small while tolerating GitHub's "type
// completion" style fuzzy match.
const ORG_MEMBER_QUERY = `
  query($org: String!, $login: String!) {
    organization(login: $org) {
      membersWithRole(query: $login, first: 5) {
        nodes { login }
      }
    }
  }
`;

export async function userExists(graphql, login) {
  try {
    const data = await graphql(USER_EXISTS_QUERY, { login });
    return Boolean(data?.user?.login);
  } catch (error) {
    // GitHub returns a top-level GraphQL error (not `user: null`) when the
    // login is unknown. Recognize that shape and return false; let other
    // errors (rate limit, network, scope) propagate so callers can surface them.
    const msg = error instanceof Error ? error.message : String(error);
    if (/could not resolve to a user/i.test(msg)) return false;
    throw error;
  }
}

export async function userIsOrgMember(graphql, org, login) {
  const data = await graphql(ORG_MEMBER_QUERY, { org, login });
  // organization === null means the operator's PAT can't see this org (rate
  // limit, missing read:org scope, private org). That's NOT the same as "not
  // a member", and callers need to be able to tell the difference. Throw
  // rather than returning a false negative that misleads "exists but not a
  // member of <org>" warnings.
  if (data?.organization === null || data?.organization === undefined) {
    throw new Error(`couldn't read org '${org}' (token may lack read:org scope, or org is private)`);
  }
  const nodes = data.organization.membersWithRole?.nodes ?? [];
  const lc = login.toLowerCase();
  return nodes.some((n) => n.login?.toLowerCase() === lc);
}
