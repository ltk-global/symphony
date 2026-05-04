// GitHub Projects v2 — Status field helpers. All take a `graphql(query, vars)`
// function as the first arg so they can be unit-tested without the network.

export const DEFAULT_STATUS_OPTIONS = [
  { name: "Todo", color: "GRAY", description: "Item is queued for work." },
  { name: "In Progress", color: "BLUE", description: "An agent is actively working on this item." },
  { name: "Done", color: "GREEN", description: "Item is complete." },
  { name: "Needs Human", color: "ORANGE", description: "Symphony parks IRIS-blocked items here for human resolution." },
];

const FETCH_STATUS_FIELD_QUERY = `
  query($id: ID!) {
    node(id: $id) {
      ... on ProjectV2 {
        field(name: "Status") {
          ... on ProjectV2SingleSelectField { id, name, options { id, name, color, description } }
        }
      }
    }
  }
`;

const UPDATE_FIELD_MUTATION = `
  mutation($fieldId: ID!, $options: [ProjectV2SingleSelectFieldOptionInput!]!) {
    updateProjectV2Field(input: { fieldId: $fieldId, singleSelectOptions: $options }) {
      projectV2Field {
        ... on ProjectV2SingleSelectField { id, options { id, name, color, description } }
      }
    }
  }
`;

const CREATE_FIELD_MUTATION = `
  mutation($projectId: ID!, $name: String!, $options: [ProjectV2SingleSelectFieldOptionInput!]!) {
    createProjectV2Field(input: {
      projectId: $projectId,
      dataType: SINGLE_SELECT,
      name: $name,
      singleSelectOptions: $options
    }) {
      projectV2Field {
        ... on ProjectV2SingleSelectField { id, name, options { id, name, color, description } }
      }
    }
  }
`;

export async function fetchStatusField(graphql, projectId) {
  const data = await graphql(FETCH_STATUS_FIELD_QUERY, { id: projectId });
  const field = data?.node?.field;
  if (!field) return null;
  return {
    id: field.id,
    options: (field.options ?? []).map((o) => ({
      id: o.id,
      name: o.name,
      color: o.color ?? "GRAY",
      description: o.description ?? "",
    })),
  };
}

export async function addStatusOption(graphql, fieldId, existing, { name, color = "GRAY", description = "" }) {
  const lc = name.toLowerCase();
  if (existing.some((o) => o.name.toLowerCase() === lc)) return existing;

  const merged = [
    ...existing.map((o) => ({
      name: o.name,
      color: o.color ?? "GRAY",
      description: o.description ?? "",
    })),
    { name, color, description },
  ];
  const data = await graphql(UPDATE_FIELD_MUTATION, { fieldId, options: merged });
  return data?.updateProjectV2Field?.projectV2Field?.options ?? existing;
}

export async function createStatusField(graphql, projectId, name = "Status") {
  const options = DEFAULT_STATUS_OPTIONS.map((o) => ({ name: o.name, color: o.color, description: o.description }));
  const data = await graphql(CREATE_FIELD_MUTATION, { projectId, name, options });
  const field = data?.createProjectV2Field?.projectV2Field;
  if (!field) throw new Error("createProjectV2Field returned no field");
  return {
    id: field.id,
    options: field.options ?? [],
  };
}

export async function ensureStatusField(graphql, projectId, { autoCreate = false } = {}) {
  const existing = await fetchStatusField(graphql, projectId);
  if (existing) return existing;
  if (!autoCreate) return null;
  return await createStatusField(graphql, projectId);
}
