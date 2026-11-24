import { DOCUMENT_WORKFLOW_TEMPLATE_ID, type WorkflowParticipantId } from "@t3tools/contracts";
import {
  codeReviewReviewers,
  investigationCrossReviews,
  investigationInvestigators,
  planningBranches,
  planningBranchIds,
  workflowParticipantIds,
  workflowParticipantLabel,
  workflowUsesMesh,
} from "@t3tools/shared/workflowParticipants";
import { isDocumentWorkflow } from "@t3tools/shared/documentWorkflow";
import {
  deriveCodeReviewWorkflowStatus,
  deriveInvestigationWorkflowStatus,
} from "@t3tools/shared/workflowStatus";
import {
  type CodeReviewWorkflow,
  type InvestigationWorkflow,
  type OrchestrationReadModel,
  type PlanningWorkflow,
  type ThreadId,
  type WorkflowBranch,
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
  latestWorkflowTemplateVersion,
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

type ParticipantIds = ReadonlyArray<WorkflowParticipantId>;

const TWO_ACTORS: ParticipantIds = workflowParticipantIds(2);
const L = workflowParticipantLabel;

function otherIds(ids: ParticipantIds, id: WorkflowParticipantId): WorkflowParticipantId[] {
  return ids.filter((candidate) => candidate !== id);
}

/** Cross-review node ids of plan X: `cross-review-x` for two authors, else one per reviewer. */
function planCrossReviewNodeIds(ids: ParticipantIds, reviewedId: WorkflowParticipantId): string[] {
  return workflowUsesMesh(ids.length)
    ? otherIds(ids, reviewedId).map((reviewerId) => `cross-review-${reviewedId}-by-${reviewerId}`)
    : [`cross-review-${reviewedId}`];
}

/** Cross-review node ids written by investigator X: `cross-review-x`, else one per reviewee. */
function investigationCrossReviewNodeIds(
  ids: ParticipantIds,
  reviewerId: WorkflowParticipantId,
): string[] {
  return workflowUsesMesh(ids.length)
    ? otherIds(ids, reviewerId).map((revieweeId) => `cross-review-${reviewerId}-on-${revieweeId}`)
    : [`cross-review-${reviewerId}`];
}

interface PlanningNodeStyle {
  readonly authorLabel: (label: string) => string;
  readonly revisionLabel: (label: string) => string;
  readonly mergeLabel: string;
  readonly draftArtifact: string;
  readonly mergeArtifact: string;
}

const PLAN_STYLE: PlanningNodeStyle = {
  authorLabel: (label) => `Plan ${label}`,
  revisionLabel: (label) => `Revise plan ${label}`,
  mergeLabel: "Synthesize plan",
  draftArtifact: "proposed-plan",
  mergeArtifact: "merged-plan",
};

const DOCUMENT_STYLE: PlanningNodeStyle = {
  authorLabel: (label) => `Draft ${label}`,
  revisionLabel: (label) => `Revise draft ${label}`,
  mergeLabel: "Merge document",
  draftArtifact: "document-draft",
  mergeArtifact: "document-draft",
};

/** Authoring, cross/self review, revision and merge nodes for the given authors. */
function planningAuthoringNodes(
  ids: ParticipantIds,
  style: PlanningNodeStyle,
): WorkflowNodeDefinition[] {
  const authorNodeIds = ids.map((id) => `author-${id}`);
  const mesh = workflowUsesMesh(ids.length);
  return [
    ...ids.map((id) =>
      node(
        `author-${id}`,
        style.authorLabel(L(id)),
        "parallel-agent",
        [],
        [`branch${L(id)}`],
        style.draftArtifact,
      ),
    ),
    ...ids.flatMap((reviewedId) =>
      mesh
        ? otherIds(ids, reviewedId).map((reviewerId) =>
            node(
              `cross-review-${reviewedId}-by-${reviewerId}`,
              `Cross-review ${L(reviewedId)} by ${L(reviewerId)}`,
              "review",
              authorNodeIds,
              [`branch${L(reviewerId)}`],
              "review",
            ),
          )
        : [
            node(
              `cross-review-${reviewedId}`,
              `Cross-review ${L(reviewedId)}`,
              "review",
              authorNodeIds,
              [`branch${L(otherIds(ids, reviewedId)[0]!)}`],
              "review",
            ),
          ],
    ),
    ...ids.map((id) =>
      node(
        `self-review-${id}`,
        `Self-review ${L(id)}`,
        "review",
        [`author-${id}`],
        [`branch${L(id)}`],
        "review",
        true,
      ),
    ),
    ...ids.map((id) =>
      node(
        `revision-${id}`,
        style.revisionLabel(L(id)),
        "agent",
        planCrossReviewNodeIds(ids, id),
        [`branch${L(id)}`],
        style.draftArtifact,
      ),
    ),
    node(
      "merge",
      style.mergeLabel,
      "synthesis",
      ids.map((id) => `revision-${id}`),
      ["merge"],
      style.mergeArtifact,
    ),
  ];
}

export function planningTemplateNodes(
  ids: ParticipantIds,
  version: 1 | 2,
): WorkflowNodeDefinition[] {
  const head = [
    ...planningAuthoringNodes(ids, PLAN_STYLE),
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
  ];
  if (version === 1) {
    return [
      ...head,
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
        ids.map((id) => `branch${L(id)}`),
        "review",
        true,
      ),
    ];
  }
  return [
    ...head,
    ...ids.map((id) =>
      node(
        `implementation-review-${id}`,
        `Implementation review ${L(id)}`,
        "review",
        ["implementation"],
        [`branch${L(id)}`],
        "review",
        true,
      ),
    ),
    node(
      "apply-feedback",
      "Apply review feedback",
      "agent",
      ids.map((id) => `implementation-review-${id}`),
      ["implementation"],
      "code-change",
      true,
    ),
  ];
}

export function documentTemplateNodes(ids: ParticipantIds): WorkflowNodeDefinition[] {
  return [
    ...planningAuthoringNodes(ids, DOCUMENT_STYLE),
    node("reader-review", "Reader review", "review", ["merge"], ["reader"], "reader-report", true),
    node("polish", "Polish", "agent", ["reader-review"], ["merge"], "document", true),
  ];
}

export function codeReviewTemplateNodes(ids: ParticipantIds): WorkflowNodeDefinition[] {
  return [
    ...ids.map((id) =>
      node(
        `reviewer-${id}`,
        `Reviewer ${L(id)}`,
        "parallel-agent",
        [],
        [`reviewer${L(id)}`],
        "review",
      ),
    ),
    node(
      "consolidation",
      "Consolidate reviews",
      "synthesis",
      ids.map((id) => `reviewer-${id}`),
      ["consolidation"],
      "review-report",
    ),
  ];
}

export function investigationTemplateNodes(ids: ParticipantIds): WorkflowNodeDefinition[] {
  const investigatorNodeIds = ids.map((id) => `investigator-${id}`);
  const mesh = workflowUsesMesh(ids.length);
  return [
    ...ids.map((id) =>
      node(
        `investigator-${id}`,
        `Investigator ${L(id)}`,
        "parallel-agent",
        [],
        [`investigator${L(id)}`],
        "investigation",
      ),
    ),
    ...ids.flatMap((reviewerId) =>
      investigationCrossReviewNodeIds(ids, reviewerId).map((nodeId, index) =>
        node(
          nodeId,
          mesh
            ? `Cross-review ${L(reviewerId)} on ${L(otherIds(ids, reviewerId)[index]!)}`
            : `Cross-review ${L(reviewerId)}`,
          "review",
          investigatorNodeIds,
          [`investigator${L(reviewerId)}`],
          "review",
        ),
      ),
    ),
    ...ids.map((id) =>
      node(
        `self-review-${id}`,
        `Self-review ${L(id)}`,
        "review",
        [`investigator-${id}`],
        [`investigator${L(id)}`],
        "review",
        true,
      ),
    ),
    node(
      "synthesis",
      "Synthesize findings",
      "synthesis",
      ids.flatMap((id) => investigationCrossReviewNodeIds(ids, id)),
      ["synthesis"],
      "investigation-report",
    ),
  ];
}

type WorkflowTemplateShell = Omit<WorkflowTemplate, "nodes" | "version"> & {
  readonly nodesFor: (ids: ParticipantIds, version: 1 | 2) => WorkflowNodeDefinition[];
};

const PLANNING_TEMPLATE_SHELL: WorkflowTemplateShell = {
  id: "builtin.planning.dual",
  runKind: "planning",
  title: "Dual-model planning",
  description: "Parallel plans, cross/self review, synthesis, approval, implementation, and gates.",
  nodesFor: planningTemplateNodes,
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
};

const CODE_REVIEW_TEMPLATE_SHELL: WorkflowTemplateShell = {
  id: "builtin.code-review.dual",
  runKind: "codeReview",
  title: "Dual-model code review",
  description: "Parallel independent reviews followed by a consolidated report.",
  nodesFor: (ids) => codeReviewTemplateNodes(ids),
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
      id: "autoPost",
      label: "Post merged review to the PR",
      type: "boolean",
      required: false,
      description: "Posts the merged review to the detected GitHub pull request when it finishes.",
    },
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
};

const INVESTIGATION_TEMPLATE_SHELL: WorkflowTemplateShell = {
  id: "builtin.investigation.dual",
  runKind: "investigation",
  title: "Dual-model investigation",
  description: "Parallel investigation, reciprocal review, optional self-review, and synthesis.",
  nodesFor: (ids) => investigationTemplateNodes(ids),
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
};

const DOCUMENT_TEMPLATE_SHELL: WorkflowTemplateShell = {
  id: DOCUMENT_WORKFLOW_TEMPLATE_ID,
  runKind: "planning",
  title: "Document",
  description: "Dual-model drafting, cross/self review, merge, audience review and polish.",
  nodesFor: (ids) => documentTemplateNodes(ids),
  form: [
    {
      id: "requirementPrompt",
      label: "Brief",
      type: "prompt",
      required: true,
      description: null,
    },
    {
      id: "documentType",
      label: "Document type",
      type: "text",
      required: true,
      description: "rfc, one-pager, adr, prd, runbook, postmortem, explainer, custom",
    },
    ...(
      [
        ["branchA", "Author A"],
        ["branchB", "Author B"],
        ["merge", "Merge model"],
        ["reader", "Reader model"],
      ] as const
    ).map(([id, label]) => ({
      id,
      label,
      type: "model-slot" as const,
      required: id !== "reader",
      description: null,
    })),
    {
      id: "selfReviewEnabled",
      label: "Own-model review",
      type: "boolean",
      required: false,
      description: null,
    },
    {
      id: "readerReviewEnabled",
      label: "Reader review",
      type: "boolean",
      required: false,
      description: null,
    },
    {
      id: "readerPersona",
      label: "Reader persona",
      type: "text",
      required: false,
      description: null,
    },
    { id: "maxCostUsd", label: "Cost limit", type: "number", required: false, description: null },
  ],
};

const V2_PLANNING_DESCRIPTION =
  "Parallel plans, evidence-backed review and synthesis, approval, implementation, dual review, and apply-feedback.";

/** The template for one version, expanded for the given actors. */
function expandTemplate(
  shell: WorkflowTemplateShell,
  version: 1 | 2,
  ids: ParticipantIds,
): WorkflowTemplate {
  const { nodesFor, ...rest } = shell;
  return {
    ...rest,
    version,
    ...(shell.id === "builtin.planning.dual" && version === 2
      ? { description: V2_PLANNING_DESCRIPTION }
      : {}),
    nodes: nodesFor(ids, version),
  };
}

const TEMPLATE_SHELLS: ReadonlyArray<{
  readonly shell: WorkflowTemplateShell;
  readonly versions: ReadonlyArray<1 | 2>;
}> = [
  { shell: PLANNING_TEMPLATE_SHELL, versions: [1, 2] },
  { shell: CODE_REVIEW_TEMPLATE_SHELL, versions: [1, 2] },
  { shell: INVESTIGATION_TEMPLATE_SHELL, versions: [1, 2] },
  { shell: DOCUMENT_TEMPLATE_SHELL, versions: [2] },
];

/** A registered template expanded for `ids` actors, or undefined when it is not registered. */
export function expandWorkflowTemplate(
  templateId: string,
  version: number,
  ids: ParticipantIds,
): WorkflowTemplate | undefined {
  const entry = TEMPLATE_SHELLS.find(
    (candidate) =>
      candidate.shell.id === templateId && candidate.versions.includes(version as 1 | 2),
  );
  return entry ? expandTemplate(entry.shell, version as 1 | 2, ids) : undefined;
}

export const DOCUMENT_WORKFLOW_TEMPLATES: ReadonlyArray<WorkflowTemplate> = [
  expandTemplate(DOCUMENT_TEMPLATE_SHELL, 2, TWO_ACTORS),
];

const ORDERED_TWO_ACTOR_TEMPLATES: ReadonlyArray<WorkflowTemplate> = [
  ...([1, 2] as const).flatMap((version) =>
    [PLANNING_TEMPLATE_SHELL, CODE_REVIEW_TEMPLATE_SHELL, INVESTIGATION_TEMPLATE_SHELL].map(
      (shell) => expandTemplate(shell, version, TWO_ACTORS),
    ),
  ),
  ...DOCUMENT_WORKFLOW_TEMPLATES,
];

export const BUILTIN_WORKFLOW_TEMPLATES: ReadonlyArray<WorkflowTemplate> =
  ORDERED_TWO_ACTOR_TEMPLATES;

export class WorkflowTemplateRegistryError extends Error {
  override readonly name = "WorkflowTemplateRegistryError";
}

/** Unique node ids, existing dependencies and no cycle; throws on the first violation. */
export function validateWorkflowTemplateStructure(template: WorkflowTemplate): void {
  const key = `${template.id}@${template.version}`;
  const nodeIds = new Set<string>();
  for (const definition of template.nodes) {
    if (nodeIds.has(definition.id)) {
      throw new WorkflowTemplateRegistryError(
        `Template '${key}' has duplicate node '${definition.id}'.`,
      );
    }
    nodeIds.add(definition.id);
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
}

export function validateWorkflowTemplateRegistry(templates: ReadonlyArray<WorkflowTemplate>): void {
  const keys = new Set<string>();
  const observedKinds = new Set<WorkflowNodeDefinition["kind"]>();
  for (const template of templates) {
    const key = `${template.id}@${template.version}`;
    if (keys.has(key)) throw new WorkflowTemplateRegistryError(`Duplicate template '${key}'.`);
    keys.add(key);
    validateWorkflowTemplateStructure(template);
    for (const definition of template.nodes) observedKinds.add(definition.kind);
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
  const runKind = (() => {
    switch (input.templateId) {
      case DOCUMENT_WORKFLOW_TEMPLATE_ID:
      case "builtin.planning.dual":
        return "planning";
      case "builtin.code-review.dual":
        return "codeReview";
      case "builtin.investigation.dual":
        return "investigation";
    }
  })();
  return Effect.gen(function* () {
    const resolvedBehavior = yield* Effect.try({
      try: () =>
        resolveWorkflowBehavior({
          runKind,
          templateId: input.templateId,
          templateVersion:
            input.templateVersion ??
            latestWorkflowTemplateVersion({ runKind, templateId: input.templateId }),
        }),
      catch: (cause): UnsupportedWorkflowTemplateError =>
        cause instanceof UnsupportedWorkflowTemplateError
          ? cause
          : new UnsupportedWorkflowTemplateError(
              runKind,
              input.templateId,
              input.templateVersion ??
                latestWorkflowTemplateVersion({ runKind, templateId: input.templateId }),
            ),
    });

    switch (input.templateId) {
      case DOCUMENT_WORKFLOW_TEMPLATE_ID:
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

function documentReaderNodes(
  workflow: PlanningWorkflow,
  snapshot: OrchestrationReadModel,
  template: WorkflowTemplate,
): WorkflowRunNodeInspection[] {
  const pass = workflow.readerPass;
  const skipped = !workflow.readerReviewEnabled || pass?.status === "skipped";
  const readerStatus =
    pass?.status === "error" && pass.errorStage === "reader"
      ? "error"
      : pass?.pinnedTurnId
        ? "completed"
        : skipped
          ? "skipped"
          : pass?.status === "reader_requested" || pass?.status === "reader_running"
            ? "running"
            : "not_started";
  const polishStatus = skipped
    ? "skipped"
    : pass?.status === "completed"
      ? "completed"
      : pass?.errorStage === "polish"
        ? "error"
        : pass?.status === "polishing"
          ? "running"
          : "not_started";
  return [
    inspectionNode({
      definition: definition(template, "reader-review"),
      status: readerStatus,
      threadId: pass?.readerThreadId ?? null,
      slot: workflow.readerSlot ?? null,
      snapshot,
    }),
    inspectionNode({
      definition: definition(template, "polish"),
      status: polishStatus,
      threadId: workflow.merge.threadId,
      slot: workflow.merge.mergeSlot,
      snapshot,
    }),
  ];
}

function planningNodes(
  workflow: PlanningWorkflow,
  snapshot: OrchestrationReadModel,
  template: WorkflowTemplate,
): WorkflowRunNodeInspection[] {
  const ids = planningBranchIds(workflow);
  const branches = planningBranches(workflow);
  const mesh = workflowUsesMesh(ids.length);
  const branchFor = (id: WorkflowParticipantId) => branches[ids.indexOf(id)]!;
  const review = (
    branch: WorkflowBranch,
    slot: "cross" | "self",
    reviewerBranchId?: WorkflowParticipantId,
  ) =>
    branch.reviews.find(
      (candidate) =>
        candidate.slot === slot &&
        (reviewerBranchId === undefined || candidate.reviewerBranchId === reviewerBranchId),
    ) ?? null;
  const implementation = workflow.implementation;
  return [
    ...ids.map((id) =>
      inspectionNode({
        definition: definition(template, `author-${id}`),
        status: branchFor(id).status,
        threadId: branchFor(id).authorThreadId,
        slot: branchFor(id).authorSlot,
        snapshot,
      }),
    ),
    ...ids.flatMap((reviewedId) =>
      ids
        .filter((reviewerId) => reviewerId !== reviewedId)
        .map((reviewerId) => {
          const record = review(branchFor(reviewedId), "cross", mesh ? reviewerId : undefined);
          return inspectionNode({
            definition: definition(
              template,
              mesh ? `cross-review-${reviewedId}-by-${reviewerId}` : `cross-review-${reviewedId}`,
            ),
            status: record?.status ?? "not_started",
            threadId: record?.threadId ?? null,
            slot: branchFor(reviewerId).authorSlot,
            snapshot,
          });
        }),
    ),
    ...ids.map((id) =>
      inspectionNode({
        definition: definition(template, `self-review-${id}`),
        status:
          review(branchFor(id), "self")?.status ??
          (workflow.selfReviewEnabled ? "not_started" : "skipped"),
        threadId: review(branchFor(id), "self")?.threadId ?? null,
        slot: branchFor(id).authorSlot,
        snapshot,
      }),
    ),
    ...ids.map((id) =>
      inspectionNode({
        definition: definition(template, `revision-${id}`),
        status: branchFor(id).revisionTurnId ? "completed" : "not_started",
        threadId: branchFor(id).authorThreadId,
        slot: branchFor(id).authorSlot,
        snapshot,
      }),
    ),
    inspectionNode({
      definition: definition(template, "merge"),
      status:
        isDocumentWorkflow(workflow) && ["merged", "manual_review"].includes(workflow.merge.status)
          ? "completed"
          : workflow.merge.status,
      threadId: workflow.merge.threadId,
      slot: workflow.merge.mergeSlot,
      snapshot,
    }),
    ...(isDocumentWorkflow(workflow)
      ? documentReaderNodes(workflow, snapshot, template)
      : [
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
                ...ids.map((id, index) => {
                  const review = implementation?.codeReviews[index] ?? null;
                  return inspectionNode({
                    definition: definition(template, `implementation-review-${id}`),
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
        ]),
  ];
}

function codeReviewNodes(
  workflow: CodeReviewWorkflow,
  snapshot: OrchestrationReadModel,
  template: WorkflowTemplate,
): WorkflowRunNodeInspection[] {
  return [
    ...codeReviewReviewers(workflow).map(({ id, reviewer }) =>
      inspectionNode({
        definition: definition(template, `reviewer-${id}`),
        status: reviewer.status,
        threadId: reviewer.threadId,
        slot: reviewer.slot,
        snapshot,
      }),
    ),
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
  const investigators = investigationInvestigators(workflow);
  const mesh = workflowUsesMesh(investigators.length);
  const crossReviews = investigationCrossReviews(workflow);
  return [
    ...investigators.flatMap(({ id, investigator }) => [
      inspectionNode({
        definition: definition(template, `investigator-${id}`),
        status: investigator.investigationStatus,
        threadId: investigator.investigationThreadId,
        slot: investigator.slot,
        snapshot,
      }),
      ...investigators
        .filter((peer) => peer.id !== id)
        .map(({ id: revieweeId }) => {
          const view = crossReviews.find(
            (entry) => entry.reviewerId === id && entry.revieweeId === revieweeId,
          );
          return inspectionNode({
            definition: definition(
              template,
              mesh ? `cross-review-${id}-on-${revieweeId}` : `cross-review-${id}`,
            ),
            status: view?.status ?? "not_started",
            threadId: view?.threadId ?? null,
            slot: investigator.slot,
            snapshot,
          });
        }),
      inspectionNode({
        definition: definition(template, `self-review-${id}`),
        status: workflow.selfReviewEnabled ? investigator.selfReviewStatus : "skipped",
        threadId: investigator.selfReviewThreadId,
        slot: investigator.slot,
        snapshot,
      }),
    ]),
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
  if (isDocumentWorkflow(workflow)) {
    if (workflow.readerPass?.status === "error") return "error";
    if (workflow.merge.status === "merged") return "running";
    if (workflow.merge.status === "manual_review") return "completed";
  }
  if (workflow.implementation) return workflow.implementation.status;
  if (workflow.merge.status !== "not_started") return workflow.merge.status;
  const branches = planningBranches(workflow);
  if (branches.some((branch) => branch.status === "error")) return "error";
  return branches.every((branch) => branch.status === "pending") ? "pending" : "running";
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

function workflowActorCount(
  workflow: PlanningWorkflow | CodeReviewWorkflow | InvestigationWorkflow,
  runKind: "planning" | "codeReview" | "investigation",
): number {
  switch (runKind) {
    case "planning":
      return planningBranches(workflow as PlanningWorkflow).length;
    case "codeReview":
      return codeReviewReviewers(workflow as CodeReviewWorkflow).length;
    case "investigation":
      return investigationInvestigators(workflow as InvestigationWorkflow).length;
  }
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
  const template = expandWorkflowTemplate(
    behavior.templateId,
    behavior.templateVersion,
    workflowParticipantIds(workflowActorCount(workflow, runKind)),
  );
  if (!template) {
    throw new WorkflowTemplateRegistryError(
      `Workflow template registry is missing '${behavior.templateId}' version ${behavior.templateVersion}.`,
    );
  }
  return template;
}
