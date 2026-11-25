import { describe, expect, it } from "vitest";

import {
  BUILTIN_WORKFLOW_DEFINITIONS,
  validateWorkflowDefinition,
  type WorkflowDefinitionSpec,
} from "./WorkflowDefinition.ts";

describe("WorkflowDefinition", () => {
  it("validates all built-in workflow DAG definitions in topological order", () => {
    for (const def of BUILTIN_WORKFLOW_DEFINITIONS) {
      const result = validateWorkflowDefinition(def);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.order.length).toBe(def.phases.length);
      }
    }
  });

  it("rejects empty definitions, unknown dependencies, duplicate ids, and cycles", () => {
    const empty: WorkflowDefinitionSpec = {
      id: "empty",
      version: 1,
      kind: "custom",
      title: "Empty",
      phases: [],
    };
    expect(validateWorkflowDefinition(empty).ok).toBe(false);

    const cyclic: WorkflowDefinitionSpec = {
      id: "cyclic",
      version: 1,
      kind: "custom",
      title: "Cyclic",
      phases: [
        { id: "a", label: "A", mode: "single", dependsOn: ["b"] },
        { id: "b", label: "B", mode: "single", dependsOn: ["a"] },
      ],
    };
    const cyclicResult = validateWorkflowDefinition(cyclic);
    expect(cyclicResult.ok).toBe(false);
    if (!cyclicResult.ok) {
      expect(cyclicResult.errors[0]).toContain("cycle");
    }

    const unknownDep: WorkflowDefinitionSpec = {
      id: "bad-dep",
      version: 1,
      kind: "custom",
      title: "Bad Dep",
      phases: [{ id: "a", label: "A", mode: "single", dependsOn: ["missing"] }],
    };
    expect(validateWorkflowDefinition(unknownDep).ok).toBe(false);
  });
});
