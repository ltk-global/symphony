import { describe, it, expect } from "vitest";
import { parseProjectUrl } from "../scripts/lib/github-graphql.mjs";

describe("parseProjectUrl", () => {
  it("parses the canonical org form", () => {
    expect(parseProjectUrl("https://github.com/orgs/acme/projects/3")).toEqual({
      scope: "orgs",
      owner: "acme",
      number: 3,
    });
  });

  it("parses the canonical user form", () => {
    expect(parseProjectUrl("https://github.com/users/me/projects/42")).toEqual({
      scope: "users",
      owner: "me",
      number: 42,
    });
  });

  it("accepts trailing slash", () => {
    expect(parseProjectUrl("https://github.com/orgs/acme/projects/3/")).toMatchObject({ owner: "acme", number: 3 });
  });

  it("accepts /views/<n> tail (URL pasted from GitHub address bar)", () => {
    expect(parseProjectUrl("https://github.com/orgs/acme/projects/3/views/1")).toMatchObject({ owner: "acme", number: 3 });
  });

  it("accepts ?query string tail", () => {
    expect(parseProjectUrl("https://github.com/users/me/projects/3?pane=info")).toMatchObject({ owner: "me", number: 3 });
  });

  it("accepts /views with query string", () => {
    expect(parseProjectUrl("https://github.com/orgs/acme/projects/3/views/1?layout=board")).toMatchObject({ number: 3 });
  });

  it("rejects URLs on other hosts", () => {
    expect(parseProjectUrl("https://malicious.example/orgs/acme/projects/3")).toBeNull();
  });

  it("rejects substring matches", () => {
    expect(parseProjectUrl("prefix https://github.com/orgs/acme/projects/3 suffix")).toBeNull();
  });

  it("rejects URLs that aren't projects", () => {
    expect(parseProjectUrl("https://github.com/orgs/acme")).toBeNull();
    expect(parseProjectUrl("https://github.com/acme/repo/issues/3")).toBeNull();
  });

  it("rejects digits-then-extra (e.g. /projects/3xyz)", () => {
    expect(parseProjectUrl("https://github.com/orgs/acme/projects/3xyz")).toBeNull();
  });

  it("returns null for non-strings or empty", () => {
    expect(parseProjectUrl("")).toBeNull();
  });
});
