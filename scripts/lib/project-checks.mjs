// Pre-flight project-state checks the wizard runs after the operator picks a
// project + Status options but before writing WORKFLOW.md. Each check returns
// { name, status: "ok"|"warn"|"fail", detail, hint? }. Failures don't abort
// the wizard — they surface so the operator can see exactly what's broken
// before committing to a config.

import { graphql } from "./github-graphql.mjs";

export async function runProjectChecks({ token, project, assignee, activeStates, fetchImpl = fetch }) {
  const checks = [];

  // 1. Bot account has project read access (we're already past auth, so this just
  //    measures whether there are any items the wizard's filters will see).
  try {
    const data = await graphql(token, `
      query($id: ID!) {
        node(id: $id) {
          ... on ProjectV2 {
            items(first: 20) { totalCount, nodes { id, content { __typename ... on Issue { number, repository { nameWithOwner } } } } }
            owner { __typename ... on User { login } ... on Organization { login } }
          }
        }
      }
    `, { id: project.id }, fetchImpl);
    const items = data.node?.items?.nodes ?? [];
    const totalCount = data.node?.items?.totalCount ?? 0;
    if (totalCount === 0) {
      checks.push({
        name: "candidate items",
        status: "warn",
        detail: "project has 0 items",
        hint: "Add issues via 'gh project item-add' or the project Workflows tab. The daemon will idle until items exist.",
      });
    } else {
      checks.push({ name: "candidate items", status: "ok", detail: `${totalCount} item${totalCount === 1 ? "" : "s"} on the project` });
    }

    // 2. Sample first item to learn the linked repo so we can probe further.
    const linked = items.find((i) => i.content?.__typename === "Issue");
    if (linked) {
      const repo = linked.content.repository.nameWithOwner;
      checks.push({ name: "linked repo", status: "ok", detail: `first item: ${repo}#${linked.content.number}` });
      // 3. Bot has push access to that repo? Check via repository(...)|viewerPermission.
      try {
        const perm = await graphql(token, `
          query($owner: String!, $name: String!) {
            repository(owner: $owner, name: $name) { viewerPermission, isPrivate }
          }
        `, { owner: repo.split("/")[0], name: repo.split("/")[1] }, fetchImpl);
        const level = perm.repository?.viewerPermission;
        if (!level) {
          checks.push({ name: "repo access", status: "fail", detail: `cannot read ${repo}`, hint: "Token lacks 'repo' scope or the repo is in an inaccessible org." });
        } else if (level === "READ" || level === "TRIAGE") {
          checks.push({ name: "repo access", status: "warn", detail: `viewerPermission=${level} on ${repo} — agent can read but cannot push or open PRs`, hint: "Grant the bot at least WRITE permission, OR plan to merge agent PRs manually from a different account." });
        } else {
          checks.push({ name: "repo access", status: "ok", detail: `${level} on ${repo}` });
        }
      } catch (error) {
        checks.push({ name: "repo access", status: "warn", detail: `couldn't probe ${repo}: ${shortMessage(error)}` });
      }
    } else if (totalCount > 0) {
      checks.push({ name: "linked repo", status: "warn", detail: "all items appear to be DraftIssues", hint: "Symphony's after_create hook needs ISSUE_REPO_FULL_NAME — drafts will be skipped. Convert one to a real issue or attach repo issues." });
    }
  } catch (error) {
    checks.push({ name: "candidate items", status: "fail", detail: shortMessage(error) });
  }

  // 4. Assignee user actually exists if the operator set one.
  if (assignee) {
    try {
      await graphql(token, `query($login: String!) { user(login: $login) { login } }`, { login: assignee }, fetchImpl);
      checks.push({ name: "assignee", status: "ok", detail: `${assignee} resolves` });
    } catch (error) {
      checks.push({
        name: "assignee",
        status: "fail",
        detail: `${assignee} not found`,
        hint: `Either fix the typo, or remove the filter (will dispatch ALL items in active states: ${activeStates.join(", ")}).`,
      });
    }
  } else {
    checks.push({ name: "assignee filter", status: "warn", detail: "no filter — daemon will pick up every item in active states", hint: "Strongly recommended for shared projects." });
  }

  return checks;
}

export function formatChecks(checks, colors) {
  // colors: { reset, green, yellow, red, dim }
  const out = [];
  for (const c of checks) {
    const tag = c.status === "ok" ? `${colors.green}✓${colors.reset}` : c.status === "warn" ? `${colors.yellow}!${colors.reset}` : `${colors.red}✗${colors.reset}`;
    out.push(`  ${tag} ${c.name}: ${c.detail}`);
    if (c.hint) out.push(`    ${colors.dim}${c.hint}${colors.reset}`);
  }
  return out.join("\n");
}

export function checksFailed(checks) {
  return checks.some((c) => c.status === "fail");
}

function shortMessage(error) {
  return error instanceof Error ? error.message.slice(0, 200) : String(error).slice(0, 200);
}
