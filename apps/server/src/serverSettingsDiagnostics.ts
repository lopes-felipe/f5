import { ServerSettings } from "@t3tools/contracts";
import type { SchemaIssue } from "effect";

const knownFields = new Set(Object.keys(ServerSettings.fields));
const maxIssues = 256;
const maxFields = 16;

/** Schema formatters include actual values and record keys, which can contain credentials. */
export function summarizeSettingsIssue(issue?: SchemaIssue.Issue): string {
  if (!issue) return "Invalid settings document";
  const pending = [{ issue, hasPath: false }];
  const fields = new Set<string>();
  let visited = 0;
  let omitted = false;
  while (pending.length > 0 && visited++ < maxIssues) {
    const current = pending.pop()!;
    switch (current.issue._tag) {
      case "Pointer": {
        const path = current.issue.path;
        const field = path[0];
        if (!current.hasPath && typeof field === "string" && knownFields.has(field)) {
          if (fields.size < maxFields) fields.add(field);
          else if (!fields.has(field)) omitted = true;
        }
        pending.push({
          issue: current.issue.issue,
          hasPath: current.hasPath || path.length > 0,
        });
        break;
      }
      case "Encoding":
      case "Filter":
        pending.push({ issue: current.issue.issue, hasPath: current.hasPath });
        break;
      case "AnyOf":
      case "Composite": {
        const remaining = maxIssues - visited - pending.length;
        const children = current.issue.issues;
        if (children.length > remaining) omitted = true;
        for (let i = 0; i < Math.min(children.length, remaining); i++) {
          pending.push({ issue: children[i]!, hasPath: current.hasPath });
        }
        break;
      }
    }
  }
  const summary =
    fields.size > 0
      ? `Invalid settings fields: ${[...fields].sort().join(", ")}`
      : "Invalid settings document";
  return omitted || pending.length > 0
    ? `${summary}; additional validation failures omitted`
    : summary;
}
