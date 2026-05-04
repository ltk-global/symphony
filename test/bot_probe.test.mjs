import { describe, it, expect } from "vitest";
import { userExists, resolveUserLogin, userIsOrgMember } from "../scripts/lib/bot-probe.mjs";

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

describe("resolveUserLogin", () => {
  it("returns the canonical login when the user exists", async () => {
    // Caller types "acme-bot", GitHub stores "Acme-Bot" — the helper
    // returns GitHub's canonical form so the workflow's filters.assignee
    // matches the runtime issue.assignees array exactly.
    const graphql = makeFakeGraphql([
      ["user(login: $login)", () => ({ user: { login: "Acme-Bot" } })],
    ]);
    expect(await resolveUserLogin(graphql, "acme-bot")).toBe("Acme-Bot");
  });

  it("returns null when the user does not exist (null user)", async () => {
    const graphql = makeFakeGraphql([
      ["user(login: $login)", () => ({ user: null })],
    ]);
    expect(await resolveUserLogin(graphql, "nope")).toBeNull();
  });

  it("returns null when GitHub raises a 'could not resolve to a User' error", async () => {
    // GitHub's actual behavior: top-level GraphQL error rather than `user: null`.
    const graphql = makeFakeGraphql([
      ["user(login: $login)", () => { throw new Error("Could not resolve to a User with the login of 'nope-asdf-1234'."); }],
    ]);
    expect(await resolveUserLogin(graphql, "nope-asdf-1234")).toBeNull();
  });

  it("propagates other GraphQL errors so the caller can show them", async () => {
    const graphql = makeFakeGraphql([
      ["user(login: $login)", () => { throw new Error("API rate limit exceeded"); }],
    ]);
    await expect(resolveUserLogin(graphql, "x")).rejects.toThrow("rate limit");
  });
});

describe("userExists", () => {
  it("is the boolean coercion of resolveUserLogin", async () => {
    const graphql = makeFakeGraphql([
      ["user(login: $login)", () => ({ user: { login: "Acme-Bot" } })],
    ]);
    expect(await userExists(graphql, "acme-bot")).toBe(true);
  });

  it("returns false on null", async () => {
    const graphql = makeFakeGraphql([
      ["user(login: $login)", () => ({ user: null })],
    ]);
    expect(await userExists(graphql, "nope")).toBe(false);
  });
});

describe("userIsOrgMember", () => {
  function makeFakeFetch(handler) {
    const calls = [];
    const fn = async (url, init) => {
      calls.push({ url, init });
      return handler(url, init);
    };
    fn.calls = calls;
    return fn;
  }

  it("returns true on HTTP 204 (member)", async () => {
    const fetchImpl = makeFakeFetch(() => ({ status: 204 }));
    expect(await userIsOrgMember("ghp_x", "acme", "acme-bot", { fetchImpl })).toBe(true);
    expect(fetchImpl.calls[0].url).toBe("https://api.github.com/orgs/acme/members/acme-bot");
  });

  it("returns false on HTTP 404 (not a member)", async () => {
    const fetchImpl = makeFakeFetch(() => ({ status: 404 }));
    expect(await userIsOrgMember("ghp_x", "acme", "ghost", { fetchImpl })).toBe(false);
  });

  it("URL-encodes org and login (defends against weird org/login chars)", async () => {
    const fetchImpl = makeFakeFetch(() => ({ status: 204 }));
    await userIsOrgMember("t", "ac/me", "user with space", { fetchImpl });
    expect(fetchImpl.calls[0].url).toBe("https://api.github.com/orgs/ac%2Fme/members/user%20with%20space");
  });

  it("throws on 302 (token rejected, would auto-redirect to login page)", async () => {
    const fetchImpl = makeFakeFetch(() => ({ status: 302 }));
    await expect(userIsOrgMember("bad", "acme", "x", { fetchImpl })).rejects.toThrow(/HTTP 302/);
  });

  it("throws on 403 (token lacks read:org or membership is private)", async () => {
    const fetchImpl = makeFakeFetch(() => ({ status: 403 }));
    await expect(userIsOrgMember("ghp_x", "acme", "x", { fetchImpl })).rejects.toThrow(/HTTP 403/);
  });

  it("sends Authorization: Bearer + user-agent", async () => {
    const fetchImpl = makeFakeFetch(() => ({ status: 204 }));
    await userIsOrgMember("ghp_secret", "acme", "x", { fetchImpl });
    expect(fetchImpl.calls[0].init.headers.authorization).toBe("Bearer ghp_secret");
    expect(fetchImpl.calls[0].init.headers["user-agent"]).toContain("symphony-init");
  });
});
