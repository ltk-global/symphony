import { describe, it, expect } from "vitest";
import {
  fetchStatusField,
  addStatusOption,
  createStatusField,
  ensureStatusField,
  DEFAULT_STATUS_OPTIONS,
} from "../scripts/lib/status-field.mjs";

// A controllable graphql() stub: each call routes by query substring.
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

describe("fetchStatusField", () => {
  it("returns { id, options } with color/description normalized", async () => {
    const graphql = makeFakeGraphql([
      ["field(name: \"Status\")", () => ({
        node: {
          field: {
            id: "FIELD_ID",
            options: [
              { id: "1", name: "Todo", color: "GRAY", description: "queued" },
              { id: "2", name: "Done" },  // no color/desc — should default
            ],
          },
        },
      })],
    ]);
    const result = await fetchStatusField(graphql, "PROJ_ID");
    expect(result).toEqual({
      id: "FIELD_ID",
      options: [
        { id: "1", name: "Todo", color: "GRAY", description: "queued" },
        { id: "2", name: "Done", color: "GRAY", description: "" },
      ],
    });
  });

  it("returns null when the project has no Status field", async () => {
    const graphql = makeFakeGraphql([
      ["field(name: \"Status\")", () => ({ node: { field: null } })],
    ]);
    expect(await fetchStatusField(graphql, "PROJ_ID")).toBe(null);
  });
});

describe("addStatusOption", () => {
  it("appends the new option, preserving existing ones", async () => {
    const graphql = makeFakeGraphql([
      ["updateProjectV2Field", (vars) => ({
        updateProjectV2Field: {
          projectV2Field: {
            options: vars.options.map((o, i) => ({ id: `o${i}`, name: o.name })),
          },
        },
      })],
    ]);
    const result = await addStatusOption(graphql, "FIELD_ID", [
      { id: "1", name: "Todo", color: "GRAY", description: "" },
      { id: "2", name: "Done", color: "GREEN", description: "" },
    ], { name: "Needs Human", color: "ORANGE", description: "park IRIS-blocked items" });

    expect(result.map((o) => o.name)).toEqual(["Todo", "Done", "Needs Human"]);
    expect(graphql.calls[0].variables.options).toEqual([
      { name: "Todo", color: "GRAY", description: "" },
      { name: "Done", color: "GREEN", description: "" },
      { name: "Needs Human", color: "ORANGE", description: "park IRIS-blocked items" },
    ]);
  });

  it("does not duplicate when the option already exists (case-insensitive)", async () => {
    const graphql = makeFakeGraphql([
      ["updateProjectV2Field", () => { throw new Error("should not be called"); }],
    ]);
    const existing = [
      { id: "1", name: "Todo", color: "GRAY", description: "" },
      { id: "2", name: "needs human", color: "ORANGE", description: "" },
    ];
    const result = await addStatusOption(graphql, "FIELD_ID", existing, { name: "Needs Human", color: "ORANGE", description: "x" });
    // Returns existing options unchanged.
    expect(result).toEqual(existing);
    expect(graphql.calls).toHaveLength(0);
  });
});

describe("createStatusField", () => {
  it("creates the field then populates options via updateProjectV2Field", async () => {
    const graphql = makeFakeGraphql([
      ["createProjectV2Field", () => ({
        createProjectV2Field: {
          projectV2Field: { id: "NEW_FIELD", name: "Status", options: [] },
        },
      })],
      ["updateProjectV2Field", (vars) => ({
        updateProjectV2Field: {
          projectV2Field: {
            options: vars.options.map((o, i) => ({ id: `n${i}`, name: o.name, color: o.color, description: o.description })),
          },
        },
      })],
    ]);
    const field = await createStatusField(graphql, "PROJ_ID");
    expect(field.id).toBe("NEW_FIELD");
    expect(field.options.map((o) => o.name)).toEqual(DEFAULT_STATUS_OPTIONS.map((o) => o.name));
    expect(field.options.map((o) => o.name)).toEqual(["Todo", "In Progress", "Done", "Needs Human"]);
    // Two GraphQL round-trips: create empty field, then add options.
    expect(graphql.calls).toHaveLength(2);
    expect(graphql.calls[0].variables).toMatchObject({ projectId: "PROJ_ID", name: "Status" });
    expect(graphql.calls[0].variables.options).toBeUndefined();
    expect(graphql.calls[1].variables.options.map((o) => o.name)).toEqual(["Todo", "In Progress", "Done", "Needs Human"]);
  });
});

describe("ensureStatusField", () => {
  it("returns the existing field when present", async () => {
    const graphql = makeFakeGraphql([
      ["field(name: \"Status\")", () => ({
        node: { field: { id: "EXISTING", options: [{ id: "1", name: "Todo", color: "GRAY", description: "" }] } },
      })],
      ["createProjectV2Field", () => { throw new Error("must not be called"); }],
    ]);
    const result = await ensureStatusField(graphql, "PROJ_ID", { autoCreate: true });
    expect(result.id).toBe("EXISTING");
    expect(result.options.map((o) => o.name)).toEqual(["Todo"]);
    expect(graphql.calls.find((c) => c.query.includes("createProjectV2Field"))).toBeUndefined();
  });

  it("creates the field when missing and autoCreate=true", async () => {
    const graphql = makeFakeGraphql([
      ["field(name: \"Status\")", () => ({ node: { field: null } })],
      ["createProjectV2Field", () => ({
        createProjectV2Field: { projectV2Field: { id: "NEW", name: "Status", options: [] } },
      })],
      ["updateProjectV2Field", (vars) => ({
        updateProjectV2Field: {
          projectV2Field: {
            options: vars.options.map((o, i) => ({ id: `i${i}`, name: o.name, color: o.color, description: o.description })),
          },
        },
      })],
    ]);
    const result = await ensureStatusField(graphql, "PROJ_ID", { autoCreate: true });
    expect(result.id).toBe("NEW");
    expect(result.options.map((o) => o.name)).toEqual(["Todo", "In Progress", "Done", "Needs Human"]);
  });

  it("returns null when missing and autoCreate=false", async () => {
    const graphql = makeFakeGraphql([
      ["field(name: \"Status\")", () => ({ node: { field: null } })],
    ]);
    const result = await ensureStatusField(graphql, "PROJ_ID", { autoCreate: false });
    expect(result).toBe(null);
  });
});
