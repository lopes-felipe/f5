import {
  DOCUMENT_WORKFLOW_TEMPLATE_ID,
  DOCUMENT_WORKFLOW_BRIEF_MAX_CHARS,
  type ProviderInteractionMode,
  type ProviderKind,
  type WorkflowTurnExecutionProfile,
} from "@t3tools/contracts";

export type WorkflowRunKind = "planning" | "codeReview" | "investigation";
export type WorkflowBehaviorStage =
  | "author"
  | "plan-review"
  | "revision"
  | "merge"
  | "implementation"
  | "implementation-review"
  | "apply-feedback"
  | "investigation"
  | "investigation-review"
  | "synthesis"
  | "standalone-review"
  | "consolidation";

export const BUILTIN_WORKFLOW_TEMPLATE_IDS = {
  planning: "builtin.planning.dual",
  codeReview: "builtin.code-review.dual",
  investigation: "builtin.investigation.dual",
} as const;

export const LATEST_WORKFLOW_TEMPLATE_VERSION = 2;

export class UnsupportedWorkflowTemplateError extends Error {
  override readonly name = "UnsupportedWorkflowTemplateError";

  constructor(
    readonly runKind: WorkflowRunKind,
    readonly templateId: string,
    readonly templateVersion: number,
  ) {
    super(`Unsupported ${runKind} workflow template '${templateId}' version ${templateVersion}.`);
  }
}

export class UnsupportedWorkflowProviderError extends Error {
  override readonly name = "UnsupportedWorkflowProviderError";

  constructor(
    readonly provider: ProviderKind,
    readonly stage: WorkflowBehaviorStage,
  ) {
    super(`Provider '${provider}' cannot enforce the read-only workflow profile for '${stage}'.`);
  }
}

export interface WorkflowBehavior {
  readonly runKind: WorkflowRunKind;
  readonly templateId: string;
  readonly templateVersion: 1 | 2;
  readonly strictPlanCapture: boolean;
  readonly checkpointBackedImplementationReview: boolean;
  readonly idempotentStageSetup: boolean;
  readonly loudAuthoritativeArtifactLimit: boolean;
  readonly interactionModeForStage: (stage: WorkflowBehaviorStage) => ProviderInteractionMode;
  readonly executionProfileForStage: (
    stage: WorkflowBehaviorStage,
  ) => WorkflowTurnExecutionProfile | undefined;
  readonly planCaptureForProvider: (
    provider: ProviderKind,
  ) => "assistant-fallback" | "line-wrapper" | "exit-plan-mode" | "unsupported";
}

function readonlyProfileForStage(
  stage: WorkflowBehaviorStage,
): WorkflowTurnExecutionProfile | undefined {
  switch (stage) {
    // Stages the user is actively watching. A clarifying question is legitimate
    // here and the workflow blocks on the answer: `author`/`investigation` open
    // the run, and `revision`/`merge` reconcile competing artifacts, which is
    // exactly where genuine product decisions surface.
    case "author":
    case "investigation":
    case "revision":
    case "merge":
      return "attended-readonly";
    // Fan-out stages that run in parallel with nobody watching, so there is no
    // reply path for a question.
    case "plan-review":
    case "implementation-review":
    case "investigation-review":
    case "synthesis":
    case "standalone-review":
    case "consolidation":
      return "unattended-readonly";
    case "implementation":
    case "apply-feedback":
      return undefined;
  }
}

function behavior(
  runKind: WorkflowRunKind,
  templateVersion: 1 | 2,
  templateId: string = BUILTIN_WORKFLOW_TEMPLATE_IDS[runKind],
): WorkflowBehavior {
  const strictPlanCapture = runKind === "planning" && templateId !== DOCUMENT_WORKFLOW_TEMPLATE_ID;
  if (templateVersion === 1) {
    return {
      runKind,
      templateId,
      templateVersion,
      strictPlanCapture,
      checkpointBackedImplementationReview: false,
      idempotentStageSetup: false,
      loudAuthoritativeArtifactLimit: false,
      interactionModeForStage: (stage) =>
        stage === "author" || stage === "plan-review" || stage === "revision" || stage === "merge"
          ? "plan"
          : "default",
      executionProfileForStage: () => undefined,
      planCaptureForProvider: () => (strictPlanCapture ? "line-wrapper" : "assistant-fallback"),
    };
  }
  return {
    runKind,
    templateId,
    templateVersion,
    strictPlanCapture,
    checkpointBackedImplementationReview: true,
    idempotentStageSetup: true,
    loudAuthoritativeArtifactLimit: true,
    interactionModeForStage: (stage) => (readonlyProfileForStage(stage) ? "plan" : "default"),
    executionProfileForStage: readonlyProfileForStage,
    planCaptureForProvider: () => (strictPlanCapture ? "line-wrapper" : "assistant-fallback"),
  };
}

export const WORKFLOW_BEHAVIORS: ReadonlyArray<WorkflowBehavior> = (
  ["planning", "codeReview", "investigation"] as const
)
  .flatMap((runKind) => [behavior(runKind, 1), behavior(runKind, 2)])
  .concat(behavior("planning", 2, DOCUMENT_WORKFLOW_TEMPLATE_ID));

const WORKFLOW_BEHAVIOR_BY_KEY = new Map<string, WorkflowBehavior>(
  WORKFLOW_BEHAVIORS.map(
    (entry) => [`${entry.runKind}:${entry.templateId}:${entry.templateVersion}`, entry] as const,
  ),
);

export function resolveWorkflowBehavior(input: {
  readonly runKind: WorkflowRunKind;
  readonly templateId?: string | undefined;
  readonly templateVersion?: number | undefined;
}): WorkflowBehavior {
  const templateId = input.templateId ?? BUILTIN_WORKFLOW_TEMPLATE_IDS[input.runKind];
  // Workflow records created before behavior versioning have no metadata and
  // must retain the legacy contract. Creation entrypoints resolve omission to
  // the latest version before persisting a new record.
  const templateVersion = input.templateVersion ?? 1;
  const resolved = WORKFLOW_BEHAVIOR_BY_KEY.get(
    `${input.runKind}:${templateId}:${templateVersion}`,
  );
  if (!resolved) {
    throw new UnsupportedWorkflowTemplateError(input.runKind, templateId, templateVersion);
  }
  return resolved;
}

export function workflowTurnBehaviorFields(input: {
  readonly runKind: WorkflowRunKind;
  readonly templateId?: string | undefined;
  readonly templateVersion?: number | undefined;
  readonly stage: WorkflowBehaviorStage;
}): {
  readonly interactionMode: ProviderInteractionMode;
  readonly workflowExecutionProfile?: WorkflowTurnExecutionProfile | undefined;
} {
  const resolved = resolveWorkflowBehavior(input);
  const profile = resolved.executionProfileForStage(input.stage);
  return {
    interactionMode: resolved.interactionModeForStage(input.stage),
    ...(profile ? { workflowExecutionProfile: profile } : {}),
  };
}

export function assertWorkflowStageProviderSupported(input: {
  readonly behavior: WorkflowBehavior;
  readonly stage: WorkflowBehaviorStage;
  readonly provider: ProviderKind;
}): void {
  if (
    input.behavior.executionProfileForStage(input.stage) !== undefined &&
    input.provider === "grok"
  ) {
    throw new UnsupportedWorkflowProviderError(input.provider, input.stage);
  }
  if (
    (input.stage === "author" || input.stage === "revision" || input.stage === "merge") &&
    input.behavior.planCaptureForProvider(input.provider) === "unsupported"
  ) {
    throw new UnsupportedWorkflowProviderError(input.provider, input.stage);
  }
}

export function latestWorkflowTemplateVersion(input: {
  runKind: WorkflowRunKind;
  templateId?: string | undefined;
}): number {
  const templateId = input.templateId ?? BUILTIN_WORKFLOW_TEMPLATE_IDS[input.runKind];
  const versions = WORKFLOW_BEHAVIORS.filter(
    (entry) => entry.runKind === input.runKind && entry.templateId === templateId,
  ).map((entry) => entry.templateVersion);
  if (!versions.length) throw new UnsupportedWorkflowTemplateError(input.runKind, templateId, 0);
  return Math.max(...versions);
}
export function documentWorkflowCreateInvariant(input: {
  templateId?: string | undefined;
  documentType?: string | null | undefined;
  requirementPrompt: string;
  readerReviewEnabled?: boolean | undefined;
  readerPersona?: string | null | undefined;
  readerSlot?: unknown;
}): string | null {
  if (input.templateId !== DOCUMENT_WORKFLOW_TEMPLATE_ID) {
    if (input.documentType != null) return "Only document workflows accept a document type.";
    if (
      input.readerReviewEnabled !== undefined ||
      input.readerPersona != null ||
      input.readerSlot != null
    )
      return "Reader review is only available for document workflows.";
    return null;
  }
  if (!input.documentType) return "Document workflows require a document type.";
  if (input.requirementPrompt.length > DOCUMENT_WORKFLOW_BRIEF_MAX_CHARS)
    return `Document briefs must be at most ${DOCUMENT_WORKFLOW_BRIEF_MAX_CHARS.toLocaleString("en-US")} characters.`;
  return null;
}
