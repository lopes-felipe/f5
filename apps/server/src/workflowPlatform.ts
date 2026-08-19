import {
  deriveCodeReviewWorkflowStatus,
  deriveInvestigationWorkflowStatus,
  type CodeReviewWorkflow,
  type InvestigationWorkflow,
  type OrchestrationReadModel,
  type PlanningWorkflow,
  type ThreadId,
  type WorkflowModelSlot,
  type WorkflowBranchStatus,
  type WorkflowImplementationStatus,
  type WorkflowMergeStatus,
  type WorkflowStepStatus,
  type ConsolidationStatus,
  type InvestigationPhaseStatus,
  type WorkflowNodeDefinition,
  type WorkflowPlatformCreateRunInput,
  type WorkflowPlatformCreateRunResult,
  type WorkflowPlatformInspectRunInput,
  type WorkflowRunInspection,
  type WorkflowRunNodeInspection,
  type WorkflowRunNodeStatus,
  type WorkflowTemplate,
} from "@t3tools/contracts";
import { Effect } from "effect";

import type { WorkflowServiceShape } from "./orchestration/Services/WorkflowService.ts";
import type { CodeReviewWorkflowServiceShape } from "./orchestration/Services/CodeReviewWorkflowService.ts";
import type { InvestigationWorkflowServiceShape } from "./orchestration/Services/InvestigationWorkflowService.ts";
import {
  LATEST_WORKFLOW_TEMPLATE_VERSION,
  resolveWorkflowBehavior,
  UnsupportedWorkflowTemplateError,
} from "./orchestration/workflowBehavior.ts";

const retry = { maxAttempts: 2, backoffMs: 5_000 } as const;
const noRetry = { maxAttempts: 0, backoffMs: 0 } as const;

function node(
  id: string,
  label: string,
  kind: WorkflowNodeDefinition["kind"],
  dependsOn: string[],
  slotKeys: string[],
  artifactType: string | null,
  optional = false,
): WorkflowNodeDefinition {
  return {
    id,
    label,
    kind,
    dependsOn,
    slotKeys,
    artifactType,
    optional,
    retry: kind === "manual-approval" || kind === "project-script" ? noRetry : retry,
    failurePolicy:
      kind === "manual-approval" ? "manual" : kind === "project-script" ? "stop" : "retry",
  };
}

const V1_WORKFLOW_TEMPLATES: ReadonlyArray<WorkflowTemplate> = [
  {
    id: "builtin.planning.dual",
    version: 1,
    runKind: "planning",
    title: "Dual-model planning",
    description:
      "Parallel plans, cross/self review, synthesis, approval, implementation, and gates.",
    nodes: [
      node("author-a", "Plan A", "parallel-agent", [], ["branchA"], "proposed-plan"),
      node("author-b", "Plan B", "parallel-agent", [], ["branchB"], "proposed-plan"),
      node(
        "cross-review-a",
        "Cross-review A",
        "review",
        ["author-a", "author-b"],
        ["branchB"],
        "review",
      ),
      node(
        "cross-review-b",
        "Cross-review B",
        "review",
        ["author-a", "author-b"],
        ["branchA"],
        "review",
      ),
      node("self-review-a", "Self-review A", "review", ["author-a"], ["branchA"], "review", true),
      node("self-review-b", "Self-review B", "review", ["author-b"], ["branchB"], "review", true),
      node(
        "revision-a",
        "Revise plan A",
        "agent",
        ["cross-review-a"],
        ["branchA"],
        "proposed-plan",
      ),
      node(
        "revision-b",
        "Revise plan B",
        "agent",
        ["cross-review-b"],
        ["branchB"],
        "proposed-plan",
      ),
      node(
        "merge",
        "Synthesize plan",
        "synthesis",
        ["revision-a", "revision-b"],
        ["merge"],
        "merged-plan",
      ),
      node("approval", "Approve merged plan", "manual-approval", ["merge"], [], "approval"),
      node(
        "implementation",
        "Implement",
        "agent",
        ["approval"],
        ["implementation"],
        "code-change",
        true,
      ),
      node(
        "quality-gates",
        "Project quality gates",
        "project-script",
        ["implementation"],
        [],
        "quality-report",
        true,
      ),
      node(
        "code-review",
        "Review implementation",
        "review",
        ["quality-gates"],
        ["branchA", "branchB"],
        "review",
        true,
      ),
    ],
    form: [
      {
        id: "requirementPrompt",
        label: "Requirement",
        type: "prompt",
        required: true,
        description: null,
      },
      { id: "branchA", label: "Planner A", type: "model-slot", required: true, description: null },
      { id: "branchB", label: "Planner B", type: "model-slot", required: true, description: null },
      {
        id: "merge",
        label: "Synthesis model",
        type: "model-slot",
        required: true,
        description: null,
      },
      {
        id: "selfReviewEnabled",
        label: "Self review",
        type: "boolean",
        required: false,
        description: null,
      },
      {
        id: "maxCostUsd",
        label: "Cost limit (USD)",
        type: "number",
        required: false,
        description: "Stops before launching the next node.",
      },
    ],
  },
  {
    id: "builtin.code-review.dual",
    version: 1,
    runKind: "codeReview",
    title: "Dual-model code review",
    description: "Parallel independent reviews followed by a consolidated report.",
    nodes: [
      node("reviewer-a", "Reviewer A", "parallel-agent", [], ["reviewerA"], "review"),
      node("reviewer-b", "Reviewer B", "parallel-agent", [], ["reviewerB"], "review"),
      node(
        "consolidation",
        "Consolidate reviews",
        "synthesis",
        ["reviewer-a", "reviewer-b"],
        ["consolidation"],
        "review-report",
      ),
    ],
    form: [
      {
        id: "reviewPrompt",
        label: "Review scope",
        type: "prompt",
        required: true,
        description: null,
      },
      { id: "branch", label: "Branch", type: "branch", required: false, description: null },
      {
        id: "reviewerA",
        label: "Reviewer A",
        type: "model-slot",
        required: true,
        description: null,
      },
      {
        id: "reviewerB",
        label: "Reviewer B",
        type: "model-slot",
        required: true,
        description: null,
      },
      {
        id: "consolidation",
        label: "Consolidator",
        type: "model-slot",
        required: true,
        description: null,
      },
      {
        id: "maxCostUsd",
        label: "Cost limit (USD)",
        type: "number",
        required: false,
        description: "Stops before launching the next node.",
      },
    ],
  },
  {
    id: "builtin.investigation.dual",
    version: 1,
    runKind: "investigation",
    title: "Dual-model investigation",
    description: "Parallel investigation, reciprocal review, optional self-review, and synthesis.",
    nodes: [
      node(
        "investigator-a",
        "Investigator A",
        "parallel-agent",
        [],
        ["investigatorA"],
        "investigation",
      ),
      node(
        "investigator-b",
        "Investigator B",
        "parallel-agent",
        [],
        ["investigatorB"],
        "investigation",
      ),
      node(
        "cross-review-a",
        "Cross-review A",
        "review",
        ["investigator-a", "investigator-b"],
        ["investigatorA"],
        "review",
      ),
      node(
        "cross-review-b",
        "Cross-review B",
        "review",
        ["investigator-a", "investigator-b"],
        ["investigatorB"],
        "review",
      ),
      node(
        "self-review-a",
        "Self-review A",
        "review",
        ["investigator-a"],
        ["investigatorA"],
        "review",
        true,
      ),
      node(
        "self-review-b",
        "Self-review B",
        "review",
        ["investigator-b"],
        ["investigatorB"],
        "review",
        true,
      ),
      node(
        "synthesis",
        "Synthesize findings",
        "synthesis",
        ["cross-review-a", "cross-review-b"],
        ["synthesis"],
        "investigation-report",
      ),
    ],
    form: [
      { id: "problemPrompt", label: "Problem", type: "prompt", required: true, description: null },
      { id: "branch", label: "Branch", type: "branch", required: false, description: null },
      {
        id: "investigatorA",
        label: "Investigator A",
        type: "model-slot",
        required: true,
        description: null,
      },
      {
        id: "investigatorB",
        label: "Investigator B",
        type: "model-slot",
        required: true,
        description: null,
      },
      {
        id: "synthesis",
        label: "Synthesis model",
        type: "model-slot",
        required: true,
        description: null,
      },
      {
        id: "selfReviewEnabled",
        label: "Self review",
        type: "boolean",
        required: false,
        description: null,
      },
      {
        id: "maxCostUsd",
        label: "Cost limit (USD)",
        type: "number",
        required: false,
        description: "Stops before launching the next node.",
      },
    ],
  },
];

function v2Template(template: WorkflowTemplate): WorkflowTemplate {
  if (template.runKind !== "planning") {
    return { ...template, version: 2 };
  }
  return {
    ...template,
    version: 2,
    description:
      "Parallel plans, evidence-backed review and synthesis, approval, implementation, dual review, and apply-feedback.",
    nodes: [
      ...template.nodes.filter(
        (candidate) => candidate.id !== "quality-gates" && candidate.id !== "code-review",
      ),
      node(
        "implementation-review-a",
        "Implementation review A",
        "review",
        ["implementation"],
        ["branchA"],
        "review",
        true,
      ),
      node(
        "implementation-review-b",
        "Implementation review B",
        "review",
        ["implementation"],
        ["branchB"],
        "review",
        true,
      ),
      node(
        "apply-feedback",
        "Apply review feedback",
        "agent",
        ["implementation-review-a", "implementation-review-b"],
        ["implementation"],
        "code-change",
        true,
      ),
    ],
  };
}

export const BUILTIN_WORKFLOW_TEMPLATES: ReadonlyArray<WorkflowTemplate> = [
  ...V1_WORKFLOW_TEMPLATES,
  ...V1_WORKFLOW_TEMPLATES.map(v2Template),
];

export class WorkflowTemplateRegistryError extends Error {
  override readonly name = "WorkflowTemplateRegistryError";
}

export function validateWorkflowTemplateRegistry(templates: ReadonlyArray<WorkflowTemplate>): void {
  const keys = new Set<string>();
  const observedKinds = new Set<WorkflowNodeDefinition["kind"]>();
  for (const template of templates) {
    const key = `${template.id}@${template.version}`;
    if (keys.has(key)) throw new WorkflowTemplateRegistryError(`Duplicate template '${key}'.`);
    keys.add(key);
    const nodeIds = new Set<string>();
    for (const definition of template.nodes) {
      if (nodeIds.has(definition.id)) {
        throw new WorkflowTemplateRegistryError(
          `Template '${key}' has duplicate node '${definition.id}'.`,
        );
      }
      nodeIds.add(definition.id);
      observedKinds.add(definition.kind);
    }
    for (const definition of template.nodes) {
      for (const dependency of definition.dependsOn) {
        if (!nodeIds.has(dependency)) {
          throw new WorkflowTemplateRegistryError(
            `Template '${key}' node '${definition.id}' depends on missing node '${dependency}'.`,
          );
        }
      }
    }
    const visiting = new Set<string>();
    const visited = new Set<string>();
    const visit = (nodeId: string): void => {
      if (visiting.has(nodeId)) {
        throw new WorkflowTemplateRegistryError(`Template '${key}' contains a dependency cycle.`);
      }
      if (visited.has(nodeId)) return;
      visiting.add(nodeId);
      const definition = template.nodes.find((candidate) => candidate.id === nodeId)!;
      for (const dependency of definition.dependsOn) visit(dependency);
      visiting.delete(nodeId);
      visited.add(nodeId);
    };
    for (const nodeId of nodeIds) visit(nodeId);
    const matchingBehavior = resolveWorkflowBehavior({
      runKind: template.runKind,
      templateId: template.id,
      templateVersion: template.version,
    });
    if (
      matchingBehavior.templateId !== template.id ||
      matchingBehavior.templateVersion !== template.version
    ) {
      throw new WorkflowTemplateRegistryError(`Template '${key}' has no matching behavior.`);
    }
  }
  for (const kind of [
    "agent",
    "parallel-agent",
    "review",
    "synthesis",
    "manual-approval",
    "project-script",
  ] as const) {
    if (!observedKinds.has(kind)) {
      throw new WorkflowTemplateRegistryError(`No registered template uses node kind '${kind}'.`);
    }
  }
}

validateWorkflowTemplateRegistry(BUILTIN_WORKFLOW_TEMPLATES);

export function createWorkflowPlatformRun(
  input: WorkflowPlatformCreateRunInput,
  services: {
    readonly planning: WorkflowServiceShape;
    readonly codeReview: CodeReviewWorkflowServiceShape;
    readonly investigation: InvestigationWorkflowServiceShape;
  },
): Effect.Effect<WorkflowPlatformCreateRunResult, Error> {
  const runKind =
    input.templateId === "builtin.planning.dual"
      ? "planning"
      : input.templateId === "builtin.code-review.dual"
        ? "codeReview"
        : "investigation";
  return Effect.gen(function* () {
    const resolvedBehavior = yield* Effect.try({
      try: () =>
        resolveWorkflowBehavior({
          runKind,
          templateId: input.templateId,
          templateVersion: input.templateVersion ?? LATEST_WORKFLOW_TEMPLATE_VERSION,
        }),
      catch: (cause): UnsupportedWorkflowTemplateError =>
        cause instanceof UnsupportedWorkflowTemplateError
          ? cause
          : new UnsupportedWorkflowTemplateError(
              runKind,
              input.templateId,
              input.templateVersion ?? LATEST_WORKFLOW_TEMPLATE_VERSION,
            ),
    });

    switch (input.templateId) {
      case "builtin.planning.dual": {
        const workflowId = yield* services.planning.createWorkflow({
          ...input.input,
          templateId: resolvedBehavior.templateId,
          templateVersion: resolvedBehavior.templateVersion,
          ...(input.maxCostUsd ? { maxCostUsd: input.maxCostUsd } : {}),
        });
        return { runKind: "planning", workflowId } satisfies WorkflowPlatformCreateRunResult;
      }
      case "builtin.code-review.dual": {
        const workflowId = yield* services.codeReview.createWorkflow({
          ...input.input,
          templateId: resolvedBehavior.templateId,
          templateVersion: resolvedBehavior.templateVersion,
          ...(input.maxCostUsd ? { maxCostUsd: input.maxCostUsd } : {}),
        });
        return { runKind: "codeReview", workflowId } satisfies WorkflowPlatformCreateRunResult;
      }
      case "builtin.investigation.dual": {
        const workflowId = yield* services.investigation.createWorkflow({
          ...input.input,
          templateId: resolvedBehavior.templateId,
          templateVersion: resolvedBehavior.templateVersion,
          ...(input.maxCostUsd ? { maxCostUsd: input.maxCostUsd } : {}),
        });
        return { runKind: "investigation", workflowId } satisfies WorkflowPlatformCreateRunResult;
      }
    }
  });
}

type WorkflowDomainNodeStatus =
  | WorkflowBranchStatus
  | WorkflowImplementationStatus
  | WorkflowMergeStatus
  | WorkflowStepStatus
  | ConsolidationStatus
  | InvestigationPhaseStatus
  | "waiting"
  | "available"
  | "skipped"
  | "blocked";

function inspectionNode(input: {
  readonly definition: WorkflowNodeDefinition;
  readonly status: WorkflowDomainNodeStatus;
  readonly threadId: ThreadId | null;
  readonly slot: WorkflowModelSlot | null;
  readonly snapshot: OrchestrationReadModel;
}): WorkflowRunNodeInspection {
  const thread = input.threadId
    ? input.snapshot.threads.find((candidate) => candidate.id === input.threadId)
    : null;
  return {
    nodeId: input.definition.id,
    label: input.definition.label,
    kind: input.definition.kind,
    status: normalizeNodeStatus(input.status),
    threadId: input.threadId,
    slot: input.slot,
    artifactType: input.definition.artifactType,
    turnCostUsd: thread?.session?.turnCostUsd ?? null,
    estimatedContextTokens:
      thread?.session?.estimatedContextTokens ?? thread?.estimatedContextTokens ?? null,
    estimatedThinkingTokens:
      thread?.session?.estimatedThinkingTokens ?? thread?.estimatedThinkingTokens ?? null,
    modelContextWindowTokens:
      thread?.session?.modelContextWindowTokens ?? thread?.modelContextWindowTokens ?? null,
    sessionNotes: thread?.sessionNotes ?? null,
    compactionInput: thread?.compaction ?? null,
  };
}

function normalizeNodeStatus(status: WorkflowDomainNodeStatus): WorkflowRunNodeStatus {
  switch (status) {
    case "not_started":
      return "not_started";
    case "pending":
    case "pending_start":
      return "pending";
    case "manual_review":
    case "waiting":
      return "manual_review";
    case "completed":
    case "plan_saved":
    case "reviews_saved":
    case "revised":
    case "merged":
    case "implemented":
    case "code_reviews_saved":
    case "available":
      return "completed";
    case "skipped":
      return "skipped";
    case "error":
      return "error";
    case "authoring":
    case "reviews_requested":
    case "revising":
    case "in_progress":
    case "implementing":
    case "code_reviews_requested":
    case "applying_reviews":
    case "running":
      return "running";
    case "blocked":
      return "blocked";
    default:
      throw new WorkflowTemplateRegistryError(`Unmapped workflow node status '${status}'.`);
  }
}

function definition(template: WorkflowTemplate, id: string): WorkflowNodeDefinition {
  const value = template.nodes.find((candidate) => candidate.id === id);
  if (!value) {
    throw new WorkflowTemplateRegistryError(
      `Workflow template '${template.id}' is missing node '${id}'.`,
    );
  }
  return value;
}

function planningNodes(
  workflow: PlanningWorkflow,
  snapshot: OrchestrationReadModel,
  template: WorkflowTemplate,
): WorkflowRunNodeInspection[] {
  const review = (branch: PlanningWorkflow["branchA"], slot: "cross" | "self") =>
    branch.reviews.find((candidate) => candidate.slot === slot) ?? null;
  const implementation = workflow.implementation;
  return [
    inspectionNode({
      definition: definition(template, "author-a"),
      status: workflow.branchA.status,
      threadId: workflow.branchA.authorThreadId,
      slot: workflow.branchA.authorSlot,
      snapshot,
    }),
    inspectionNode({
      definition: definition(template, "author-b"),
      status: workflow.branchB.status,
      threadId: workflow.branchB.authorThreadId,
      slot: workflow.branchB.authorSlot,
      snapshot,
    }),
    inspectionNode({
      definition: definition(template, "cross-review-a"),
      status: review(workflow.branchA, "cross")?.status ?? "not_started",
      threadId: review(workflow.branchA, "cross")?.threadId ?? null,
      slot: workflow.branchB.authorSlot,
      snapshot,
    }),
    inspectionNode({
      definition: definition(template, "cross-review-b"),
      status: review(workflow.branchB, "cross")?.status ?? "not_started",
      threadId: review(workflow.branchB, "cross")?.threadId ?? null,
      slot: workflow.branchA.authorSlot,
      snapshot,
    }),
    inspectionNode({
      definition: definition(template, "self-review-a"),
      status:
        review(workflow.branchA, "self")?.status ??
        (workflow.selfReviewEnabled ? "not_started" : "skipped"),
      threadId: review(workflow.branchA, "self")?.threadId ?? null,
      slot: workflow.branchA.authorSlot,
      snapshot,
    }),
    inspectionNode({
      definition: definition(template, "self-review-b"),
      status:
        review(workflow.branchB, "self")?.status ??
        (workflow.selfReviewEnabled ? "not_started" : "skipped"),
      threadId: review(workflow.branchB, "self")?.threadId ?? null,
      slot: workflow.branchB.authorSlot,
      snapshot,
    }),
    inspectionNode({
      definition: definition(template, "revision-a"),
      status: workflow.branchA.revisionTurnId ? "completed" : "not_started",
      threadId: workflow.branchA.authorThreadId,
      slot: workflow.branchA.authorSlot,
      snapshot,
    }),
    inspectionNode({
      definition: definition(template, "revision-b"),
      status: workflow.branchB.revisionTurnId ? "completed" : "not_started",
      threadId: workflow.branchB.authorThreadId,
      slot: workflow.branchB.authorSlot,
      snapshot,
    }),
    inspectionNode({
      definition: definition(template, "merge"),
      status: workflow.merge.status,
      threadId: workflow.merge.threadId,
      slot: workflow.merge.mergeSlot,
      snapshot,
    }),
    inspectionNode({
      definition: definition(template, "approval"),
      status:
        workflow.merge.status === "manual_review"
          ? "waiting"
          : implementation
            ? "completed"
            : "not_started",
      threadId: workflow.merge.threadId,
      slot: null,
      snapshot,
    }),
    inspectionNode({
      definition: definition(template, "implementation"),
      status: implementation?.status ?? "not_started",
      threadId: implementation?.threadId ?? null,
      slot: implementation?.implementationSlot ?? null,
      snapshot,
    }),
    ...(template.version === 1
      ? [
          inspectionNode({
            definition: definition(template, "quality-gates"),
            status: implementation?.status === "completed" ? "available" : "not_started",
            threadId: implementation?.threadId ?? null,
            slot: null,
            snapshot,
          }),
          inspectionNode({
            definition: definition(template, "code-review"),
            status: implementation?.codeReviews.some((entry) => entry.status === "error")
              ? "error"
              : implementation?.codeReviews.length
                ? "running"
                : "not_started",
            threadId: implementation?.codeReviews[0]?.threadId ?? null,
            slot: implementation?.codeReviews[0]?.reviewerSlot ?? null,
            snapshot,
          }),
        ]
      : [
          ...([0, 1] as const).map((index) => {
            const review = implementation?.codeReviews[index] ?? null;
            return inspectionNode({
              definition: definition(template, `implementation-review-${index === 0 ? "a" : "b"}`),
              status:
                review?.status ??
                (implementation?.errorStage === "review-setup"
                  ? "error"
                  : implementation?.codeReviewEnabled
                    ? "not_started"
                    : "skipped"),
              threadId: review?.threadId ?? null,
              slot: review?.reviewerSlot ?? null,
              snapshot,
            });
          }),
          inspectionNode({
            definition: definition(template, "apply-feedback"),
            status:
              implementation?.status === "applying_reviews"
                ? "running"
                : implementation?.status === "error" &&
                    implementation.errorStage === "apply-feedback"
                  ? "error"
                  : implementation?.status === "completed"
                    ? "completed"
                    : implementation?.codeReviewEnabled
                      ? "not_started"
                      : "skipped",
            threadId: implementation?.threadId ?? null,
            slot: implementation?.implementationSlot ?? null,
            snapshot,
          }),
        ]),
  ];
}

function codeReviewNodes(
  workflow: CodeReviewWorkflow,
  snapshot: OrchestrationReadModel,
  template: WorkflowTemplate,
): WorkflowRunNodeInspection[] {
  return [
    inspectionNode({
      definition: definition(template, "reviewer-a"),
      status: workflow.reviewerA.status,
      threadId: workflow.reviewerA.threadId,
      slot: workflow.reviewerA.slot,
      snapshot,
    }),
    inspectionNode({
      definition: definition(template, "reviewer-b"),
      status: workflow.reviewerB.status,
      threadId: workflow.reviewerB.threadId,
      slot: workflow.reviewerB.slot,
      snapshot,
    }),
    inspectionNode({
      definition: definition(template, "consolidation"),
      status: workflow.consolidation.status,
      threadId: workflow.consolidation.threadId,
      slot: workflow.consolidation.slot,
      snapshot,
    }),
  ];
}

function investigationNodes(
  workflow: InvestigationWorkflow,
  snapshot: OrchestrationReadModel,
  template: WorkflowTemplate,
): WorkflowRunNodeInspection[] {
  const investigator = (
    key: "investigatorA" | "investigatorB",
    suffix: "a" | "b",
  ): WorkflowRunNodeInspection[] => {
    const value = workflow[key];
    return [
      inspectionNode({
        definition: definition(template, `investigator-${suffix}`),
        status: value.investigationStatus,
        threadId: value.investigationThreadId,
        slot: value.slot,
        snapshot,
      }),
      inspectionNode({
        definition: definition(template, `cross-review-${suffix}`),
        status: value.crossReviewStatus,
        threadId: value.crossReviewThreadId,
        slot: value.slot,
        snapshot,
      }),
      inspectionNode({
        definition: definition(template, `self-review-${suffix}`),
        status: workflow.selfReviewEnabled ? value.selfReviewStatus : "skipped",
        threadId: value.selfReviewThreadId,
        slot: value.slot,
        snapshot,
      }),
    ];
  };
  return [
    ...investigator("investigatorA", "a"),
    ...investigator("investigatorB", "b"),
    inspectionNode({
      definition: definition(template, "synthesis"),
      status: workflow.synthesis.status,
      threadId: workflow.synthesis.threadId,
      slot: workflow.synthesis.slot,
      snapshot,
    }),
  ];
}

function planningStatus(workflow: PlanningWorkflow): string {
  if (workflow.implementation) return workflow.implementation.status;
  if (workflow.merge.status !== "not_started") return workflow.merge.status;
  if (workflow.branchA.status === "error" || workflow.branchB.status === "error") return "error";
  return workflow.branchA.status === "pending" && workflow.branchB.status === "pending"
    ? "pending"
    : "running";
}

export function inspectWorkflowPlatformRun(
  input: WorkflowPlatformInspectRunInput,
  snapshot: OrchestrationReadModel,
): WorkflowRunInspection {
  let template: WorkflowTemplate;
  const projectFor = (projectId: PlanningWorkflow["projectId"]) => {
    const project = snapshot.projects.find((candidate) => candidate.id === projectId);
    if (!project) throw new Error(`Project '${projectId}' was not found.`);
    return project;
  };
  let workflow: PlanningWorkflow | CodeReviewWorkflow | InvestigationWorkflow;
  let status: string;
  let nodes: WorkflowRunNodeInspection[];
  if (input.runKind === "planning") {
    const value = snapshot.planningWorkflows.find((candidate) => candidate.id === input.workflowId);
    if (!value) throw new Error(`Planning workflow '${input.workflowId}' was not found.`);
    workflow = value;
    template = templateForWorkflow(value, "planning");
    status = planningStatus(value);
    nodes = planningNodes(value, snapshot, template);
  } else if (input.runKind === "codeReview") {
    const value = snapshot.codeReviewWorkflows.find(
      (candidate) => candidate.id === input.workflowId,
    );
    if (!value) throw new Error(`Code review workflow '${input.workflowId}' was not found.`);
    workflow = value;
    template = templateForWorkflow(value, "codeReview");
    status = deriveCodeReviewWorkflowStatus(value);
    nodes = codeReviewNodes(value, snapshot, template);
  } else {
    const value = snapshot.investigationWorkflows.find(
      (candidate) => candidate.id === input.workflowId,
    );
    if (!value) throw new Error(`Investigation workflow '${input.workflowId}' was not found.`);
    workflow = value;
    template = templateForWorkflow(value, "investigation");
    status = deriveInvestigationWorkflowStatus(value);
    nodes = investigationNodes(value, snapshot, template);
  }
  const project = projectFor(workflow.projectId);
  const totalCostUsd = workflow.totalCostUsd ?? 0;
  const maxCostUsd = workflow.maxCostUsd ?? null;
  return {
    workflowId: workflow.id,
    projectId: workflow.projectId,
    title: workflow.title,
    templateId: template.id,
    templateVersion: template.version,
    runKind: input.runKind,
    status,
    totalCostUsd,
    maxCostUsd,
    budgetRemainingUsd:
      maxCostUsd === null ? null : Number(Math.max(0, maxCostUsd - totalCostUsd).toFixed(6)),
    nodes,
    projectMemories: project.memories.filter((memory) => memory.deletedAt === null),
    projectSkills: project.skills ?? [],
  };
}

function templateForWorkflow(
  workflow: PlanningWorkflow | CodeReviewWorkflow | InvestigationWorkflow,
  runKind: "planning" | "codeReview" | "investigation",
): WorkflowTemplate {
  const behavior = resolveWorkflowBehavior({
    runKind,
    templateId: workflow.templateId,
    templateVersion: workflow.templateVersion,
  });
  const template = BUILTIN_WORKFLOW_TEMPLATES.find(
    (candidate) =>
      candidate.id === behavior.templateId && candidate.version === behavior.templateVersion,
  );
  if (!template) {
    throw new WorkflowTemplateRegistryError(
      `Workflow template registry is missing '${behavior.templateId}' version ${behavior.templateVersion}.`,
    );
  }
  return template;
}
