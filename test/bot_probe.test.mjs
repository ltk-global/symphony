import { describe, it, expect } from "vitest";
import { userExists, userIsOrgMember } from "../scripts/lib/bot-probe.mjs";

function makeFakeGraphql(handlers) {
  const calls = [];
  const fn = async (query, variables) => {
    calls.push({ query, variables });
    for (const [needle, handler] of handlers) {
      if (query.includes(needle)) return handler(variables);
    }
    throw new Error(`No fake handler matched: ${query.slice(0, 60)}`);
  };
  fn.calls = calls;
  return fn;
}

describe("userExists", () => {
  it("returns true for an existing user", async () => {
    const graphql = makeFakeGraphql([
      ["user(login: $login)", () => ({ user: { id: "U_x", login: "acme-bot" } })],
    ]);
    expect(await userExists(graphql, "acme-bot")).toBe(true);
  });

  it("returns false when the user does not exist (null user)", async () => {
    const graphql = makeFakeGraphql([
      ["user(login: $login)", () => ({ user: null })],
    ]);
    expect(await userExists(graphql, "nope")).toBe(false);
  });

  it("returns false when GitHub raises a 'could not resolve to a User' error", async () => {
    // GitHub's actual behavior: top-level GraphQL error rather than `user: null`.
    const graphql = makeFakeGraphql([
      ["user(login: $login)", () => { throw new Error("Could not resolve to a User with the login of 'nope-asdf-1234'."); }],
    ]);
    expect(await userExists(graphql, "nope-asdf-1234")).toBe(false);
  });

  it("propagates other GraphQL errors so the caller can show them", async () => {
    const graphql = makeFakeGraphql([
      ["user(login: $login)", () => { throw new Error("API rate limit exceeded"); }],
    ]);
    await expect(userExists(graphql, "x")).rejects.toThrow("rate limit");
  });
});

describe("userIsOrgMember", () => {
  it("returns true on an exact (case-insensitive) match", async () => {
    const graphql = makeFakeGraphql([
      ["membersWithRole", () => ({ organization: { membersWithRole: { nodes: [
        { login: "Acme-Bot" },
        { login: "acme-bot-secondary" },
      ] } } })],
    ]);
    expect(await userIsOrgMember(graphql, "acme", "acme-bot")).toBe(true);
  });

  it("returns false when only prefix matches exist (no exact match)", async () => {
    // GitHub's `query:` is fuzzy/prefix-based — must not accept "acme-bot-x"
    // as evidence that "acme-bot" is a member.
    const graphql = makeFakeGraphql([
      ["membersWithRole", () => ({ organization: { membersWithRole: { nodes: [
        { login: "acme-bot-staging" },
        { login: "acme-bot-prod" },
      ] } } })],
    ]);
    expect(await userIsOrgMember(graphql, "acme", "acme-bot")).toBe(false);
  });

  it("returns false when the org has no matches", async () => {
    const graphql = makeFakeGraphql([
      ["membersWithRole", () => ({ organization: { membersWithRole: { nodes: [] } } })],
    ]);
    expect(await userIsOrgMember(graphql, "acme", "ghost")).toBe(false);
  });

  it("throws when the org isn't visible (null organization — rate limit / scope)", async () => {
    // Distinguishes "user not a member" (returns false) from "couldn't probe"
    // (throws). Otherwise validateAssignee would print a misleading
    // "exists but not a member of X" on a transient API hiccup.
    const graphql = makeFakeGraphql([
      ["membersWithRole", () => ({ organization: null })],
    ]);
    await expect(userIsOrgMember(graphql, "no-such-org", "x")).rejects.toThrow(/couldn't read org/);
  });
});
