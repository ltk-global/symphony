import { readFile } from "node:fs/promises";
import { Liquid } from "liquidjs";
import YAML from "yaml";

export interface WorkflowDefinition {
  config: Record<string, unknown>;
  promptTemplate: string;
}

const liquid = new Liquid({
  strictVariables: true,
  strictFilters: true,
});

export async function loadWorkflow(path: string): Promise<WorkflowDefinition> {
  return loadWorkflowFromString(await readFile(path, "utf8"));
}

export function loadWorkflowFromString(source: string): WorkflowDefinition {
  if (!source.startsWith("---")) {
    return { config: {}, promptTemplate: source.trim() || defaultPrompt() };
  }

  const end = source.indexOf("\n---", 3);
  if (end === -1) throw new Error("workflow_parse_error: missing closing front matter fence");

  const frontMatter = source.slice(3, end).trim();
  const body = source.slice(end + 4).trim();
  const parsed = frontMatter ? YAML.parse(frontMatter) : {};
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("workflow_front_matter_not_a_map");
  }

  return {
    config: parsed as Record<string, unknown>,
    promptTemplate: body || defaultPrompt(),
  };
}

export async function renderPrompt(template: string, input: Record<string, unknown>): Promise<string> {
  return liquid.parseAndRender(template || defaultPrompt(), input);
}

function defaultPrompt(): string {
  return "You are working on a GitHub project item.";
}
