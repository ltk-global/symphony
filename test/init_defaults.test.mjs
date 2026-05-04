import { describe, it, expect } from "vitest";
import {
  defaultActiveStates,
  defaultTerminalStates,
  defaultNeedsHumanState,
  parseList,
  slug,
  parseInitArgs,
} from "../scripts/lib/init-defaults.mjs";

const opts = (...names) => names.map((name, i) => ({ id: `id-${i}`, name }));

describe("defaultActiveStates", () => {
  it("matches Todo / In Progress / Review Feedback case-insensitively", () => {
    const o = opts("Todo", "In Progress", "Review Feedback", "Done", "Needs Human");
    expect(defaultActiveStates(o)).toEqual(["Todo", "In Progress", "Review Feedback"]);
  });

  it("preserves the project's casing of option names", () => {
    const o = opts("TODO", "in progress", "Done");
    expect(defaultActiveStates(o)).toEqual(["TODO", "in progress"]);
  });

  it("returns [] when nothing matches (caller falls back to a hard-coded default)", () => {
    expect(defaultActiveStates(opts("Backlog", "Shipped"))).toEqual([]);
  });
});

describe("defaultTerminalStates", () => {
  it("matches Done / Cancelled / Won't do", () => {
    const o = opts("Todo", "Done", "Cancelled", "Won't do");
    expect(defaultTerminalStates(o)).toEqual(["Done", "Cancelled", "Won't do"]);
  });

  it("returns [] when nothing matches", () => {
    expect(defaultTerminalStates(opts("Todo", "In Progress"))).toEqual([]);
  });
});

describe("defaultNeedsHumanState", () => {
  it("prefers an exact 'Needs Human' option", () => {
    const o = opts("Todo", "Blocked", "Needs Human");
    expect(defaultNeedsHumanState(o)).toBe("Needs Human");
  });

  it("falls back to a 'Blocked' option when no Needs Human exists", () => {
    expect(defaultNeedsHumanState(opts("Todo", "Blocked"))).toBe("Blocked");
  });

  it("falls back to the first option when no match at all", () => {
    expect(defaultNeedsHumanState(opts("Todo", "Done"))).toBe("Todo");
  });

  it("returns null when the options array is empty", () => {
    expect(defaultNeedsHumanState([])).toBe(null);
  });
});

describe("parseList", () => {
  it("splits comma-separated values and trims", () => {
    expect(parseList("Todo,  In Progress , Review Feedback ")).toEqual([
      "Todo",
      "In Progress",
      "Review Feedback",
    ]);
  });

  it("filters empty entries", () => {
    expect(parseList("Todo, , Done,")).toEqual(["Todo", "Done"]);
  });
});

describe("slug", () => {
  it("lowercases and replaces non-alphanumerics with dashes", () => {
    expect(slug("Symphony Bot Queue")).toBe("symphony-bot-queue");
    expect(slug("My Project / v2!")).toBe("my-project-v2");
  });

  it("falls back to 'default' for empty input", () => {
    expect(slug("")).toBe("default");
    expect(slug("---")).toBe("default");
  });

  it("caps at 32 chars", () => {
    expect(slug("a".repeat(50))).toHaveLength(32);
  });
});

describe("parseInitArgs", () => {
  it("returns defaults when no flags given", () => {
    expect(parseInitArgs([])).toEqual({ yes: false, projectUrl: null, eagerBootstrap: true });
  });

  it("recognizes --yes and -y", () => {
    expect(parseInitArgs(["--yes"])).toEqual({ yes: true, projectUrl: null, eagerBootstrap: true });
    expect(parseInitArgs(["-y"])).toEqual({ yes: true, projectUrl: null, eagerBootstrap: true });
  });

  it("recognizes --project <url> in both forms", () => {
    expect(parseInitArgs(["--project", "https://github.com/users/me/projects/3"])).toEqual({
      yes: false,
      projectUrl: "https://github.com/users/me/projects/3",
      eagerBootstrap: true,
    });
    expect(parseInitArgs(["--project=https://github.com/users/me/projects/3"])).toEqual({
      yes: false,
      projectUrl: "https://github.com/users/me/projects/3",
      eagerBootstrap: true,
    });
  });

  it("recognizes --no-eager-bootstrap", () => {
    expect(parseInitArgs(["--no-eager-bootstrap"])).toEqual({ yes: false, projectUrl: null, eagerBootstrap: false });
  });

  it("does not consume the next arg as --project value when it's another flag", () => {
    // Operator forgot the URL — `--yes` MUST still be honored, projectUrl stays null.
    expect(parseInitArgs(["--project", "--yes"])).toEqual({ yes: true, projectUrl: null, eagerBootstrap: true });
    expect(parseInitArgs(["--project", "--no-eager-bootstrap"])).toEqual({ yes: false, projectUrl: null, eagerBootstrap: false });
  });

  it("treats --project at end of argv as null (no value)", () => {
    expect(parseInitArgs(["--project"])).toEqual({ yes: false, projectUrl: null, eagerBootstrap: true });
  });

  it("combines flags", () => {
    expect(parseInitArgs(["--yes", "--no-eager-bootstrap", "--project", "https://github.com/users/me/projects/3"])).toEqual({
      yes: true,
      projectUrl: "https://github.com/users/me/projects/3",
      eagerBootstrap: false,
    });
  });

  it("ignores unknown flags rather than throwing (other Node CLI tools may add their own)", () => {
    expect(parseInitArgs(["--debug", "--yes"])).toEqual({ yes: true, projectUrl: null, eagerBootstrap: true });
  });
});
