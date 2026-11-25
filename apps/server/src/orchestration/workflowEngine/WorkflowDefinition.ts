/**
 * Declarative multi-model workflow DAG definition contract.
 *
 * Models built-in workflows (Feature Planning, Document, Code Review,
 * Investigation) as typed phase graphs and provides topological ordering and
 * structural validation so custom user-defined workflow templates can build
 * directly on the same engine primitives.
 */

export type WorkflowPhaseExecutionMode = "fan_out" | "cross_review" | "fan_in" | "single";

export interface WorkflowPhaseNode {
  readonly id: string;
  readonly label: string;
  readonly mode: WorkflowPhaseExecutionMode;
  readonly dependsOn: ReadonlyArray<string>;
  readonly requiresApprovalGate?: boolean;
  readonly optional?: boolean;
}

export interface WorkflowDefinitionSpec {
  readonly id: string;
  readonly version: number;
  readonly kind: "planning" | "document" | "codeReview" | "investigation" | "custom";
  readonly title: string;
  readonly phases: ReadonlyArray<WorkflowPhaseNode>;
}

export type WorkflowDefinitionValidationResult =
  | { readonly ok: true; readonly order: ReadonlyArray<WorkflowPhaseNode> }
  | { readonly ok: false; readonly errors: ReadonlyArray<string> };

/**
 * Validates phase ids, dependency references, and acyclicity, returning phases
 * in deterministic topological order when valid.
 */
export function validateWorkflowDefinition(
  spec: WorkflowDefinitionSpec,
): WorkflowDefinitionValidationResult {
  const errors: string[] = [];
  if (spec.phases.length === 0) {
    return { ok: false, errors: [`Workflow "${spec.id}" must declare at least one phase.`] };
  }

  const byId = new Map<string, WorkflowPhaseNode>();
  for (const phase of spec.phases) {
    if (byId.has(phase.id)) {
      errors.push(`Duplicate phase id "${phase.id}" in workflow "${spec.id}".`);
    } else {
      byId.set(phase.id, phase);
    }
  }

  for (const phase of spec.phases) {
    for (const dep of phase.dependsOn) {
      if (dep === phase.id) {
        errors.push(`Phase "${phase.id}" cannot depend on itself.`);
      } else if (!byId.has(dep)) {
        errors.push(`Phase "${phase.id}" depends on unknown phase "${dep}".`);
      }
    }
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }

  const inDegree = new Map<string, number>();
  const dependents = new Map<string, string[]>();
  for (const phase of spec.phases) {
    inDegree.set(phase.id, phase.dependsOn.length);
    for (const dep of phase.dependsOn) {
      const list = dependents.get(dep) ?? [];
      list.push(phase.id);
      dependents.set(dep, list);
    }
  }

  const ready: string[] = [];
  for (const phase of spec.phases) {
    if ((inDegree.get(phase.id) ?? 0) === 0) {
      ready.push(phase.id);
    }
  }

  const order: WorkflowPhaseNode[] = [];
  while (ready.length > 0) {
    const currentId = ready.shift()!;
    order.push(byId.get(currentId)!);
    for (const nextId of dependents.get(currentId) ?? []) {
      const nextDegree = (inDegree.get(nextId) ?? 1) - 1;
      inDegree.set(nextId, nextDegree);
      if (nextDegree === 0) {
        ready.push(nextId);
      }
    }
  }

  if (order.length !== spec.phases.length) {
    const cyclePhases = spec.phases
      .filter((phase) => !order.some((ordered) => ordered.id === phase.id))
      .map((phase) => phase.id);
    return {
      ok: false,
      errors: [
        `Workflow "${spec.id}" contains a dependency cycle involving: ${cyclePhases.join(", ")}.`,
      ],
    };
  }

  return { ok: true, order };
}

export const FEATURE_WORKFLOW_DEFINITION: WorkflowDefinitionSpec = {
  id: "builtin.feature-planning",
  version: 1,
  kind: "planning",
  title: "Feature Planning & Implementation",
  phases: [
    { id: "author", label: "Author Plans", mode: "fan_out", dependsOn: [] },
    { id: "review", label: "Cross-Review Plans", mode: "cross_review", dependsOn: ["author"] },
    { id: "revise", label: "Revise Plans", mode: "fan_out", dependsOn: ["review"] },
    {
      id: "merge",
      label: "Merge Final Plan",
      mode: "fan_in",
      dependsOn: ["revise"],
      requiresApprovalGate: true,
    },
    { id: "implement", label: "Implement", mode: "single", dependsOn: ["merge"], optional: true },
    {
      id: "code_review",
      label: "Code Review",
      mode: "fan_out",
      dependsOn: ["implement"],
      optional: true,
    },
    {
      id: "apply_reviews",
      label: "Apply Review Feedback",
      mode: "single",
      dependsOn: ["code_review"],
      optional: true,
    },
  ],
};

export const CODE_REVIEW_WORKFLOW_DEFINITION: WorkflowDefinitionSpec = {
  id: "builtin.code-review",
  version: 1,
  kind: "codeReview",
  title: "Multi-Model Code Review",
  phases: [
    { id: "reviewers", label: "Independent Reviews", mode: "fan_out", dependsOn: [] },
    { id: "consolidation", label: "Consolidated Review", mode: "fan_in", dependsOn: ["reviewers"] },
  ],
};

export const INVESTIGATION_WORKFLOW_DEFINITION: WorkflowDefinitionSpec = {
  id: "builtin.investigation",
  version: 1,
  kind: "investigation",
  title: "Multi-Model Root Cause Investigation",
  phases: [
    { id: "investigate", label: "Independent Investigations", mode: "fan_out", dependsOn: [] },
    {
      id: "review",
      label: "Cross & Self Review",
      mode: "cross_review",
      dependsOn: ["investigate"],
    },
    { id: "synthesis", label: "RCA Synthesis", mode: "fan_in", dependsOn: ["review"] },
  ],
};

export const BUILTIN_WORKFLOW_DEFINITIONS: ReadonlyArray<WorkflowDefinitionSpec> = [
  FEATURE_WORKFLOW_DEFINITION,
  CODE_REVIEW_WORKFLOW_DEFINITION,
  INVESTIGATION_WORKFLOW_DEFINITION,
];
