import {
  DOCUMENT_WORKFLOW_TEMPLATE_ID,
  type PlanningWorkflow,
  type ThreadId,
  type WorkflowDocumentType,
  type WorkflowModelSlot,
} from "@t3tools/contracts";
import { stripProposedPlanBlockTags } from "./proposedPlan";
import { threadIdsForPlanningWorkflow } from "./workflowThreads";

export const DEFAULT_WORKFLOW_DOCUMENT_TYPE = "rfc";
export const DOCUMENT_ARTIFACT_MAX_CHARS = 36_000;
export const DOCUMENT_PROMPT_OVERHEAD_MAX_CHARS = 10_000;
export const WORKFLOW_DOCUMENT_TYPE_ORDER = [
  "rfc",
  "one-pager",
  "adr",
  "prd",
  "runbook",
  "postmortem",
  "explainer",
  "custom",
] as const;
interface DocumentProfile {
  label: string;
  description: string;
  placeholder: string;
  audience: string;
  length: string;
  sections: ReadonlyArray<{ heading: string; purpose: string }>;
  writingRules: ReadonlyArray<string>;
  reviewFocus: ReadonlyArray<string>;
  readerPersona: string;
}
function sections(entries: ReadonlyArray<readonly [string, string]>) {
  return entries.map(([heading, purpose]) => ({ heading, purpose }));
}
export const WORKFLOW_DOCUMENT_PROFILES: Record<WorkflowDocumentType, DocumentProfile> = {
  rfc: {
    label: "RFC",
    description: "Proposal for a significant technical change, for engineering review.",
    placeholder:
      "Describe the proposed change, audience, desired tone, constraints, and supporting inputs.",
    audience: "Engineering reviewers and decision makers",
    length: "1,500 to 4,000 words",
    sections: sections([
      ["Summary", "Problem, proposal and requested decision in 2 to 4 sentences"],
      ["Background", "Relevant current state and context"],
      ["Problem Statement", "The problem and evidence"],
      ["Goals and Non-Goals", "Desired outcomes and explicit exclusions"],
      ["Proposal", "Recommended approach and rationale"],
      ["Alternatives Considered", "Trade-offs, including doing nothing"],
      ["Risks and Mitigations", "Failure modes and safeguards"],
      ["Rollout and Migration", "Phasing, compatibility, rollback and success metrics"],
      ["Open Questions", "Unresolved decisions and missing evidence"],
    ]),
    writingRules: [
      "State the requested decision explicitly.",
      "Separate existing behavior from proposed changes.",
    ],
    reviewFocus: ["Is the proposal decidable?", "Are alternatives and rollout risks credible?"],
    readerPersona:
      "A senior engineer on a neighboring team who must approve or push back on the proposal. Knows the company's stack, not this system's internals.",
  },
  "one-pager": {
    label: "One-pager",
    description: "Decision-oriented summary for stakeholders.",
    placeholder: "Describe the decision, stakeholder audience, tone, and supporting inputs.",
    audience: "Stakeholders deciding whether to approve or fund the proposal",
    length: "At most 700 words; no code blocks",
    sections: sections([
      ["TL;DR", "The main point and the ask"],
      ["Problem", "Why action is needed"],
      ["Proposal", "Recommended action"],
      ["Impact", "Expected outcomes"],
      ["Cost and Risks", "Investment and trade-offs"],
      ["Ask and Next Steps", "Decision needed and concrete next actions"],
    ]),
    writingRules: ["Lead with the ask.", "Use no code blocks; stay within 700 words."],
    reviewFocus: ["Is it decidable in two minutes?", "Is the ask clear and supported?"],
    readerPersona:
      "A director with two minutes between meetings who must decide whether to approve or fund this.",
  },
  adr: {
    label: "ADR",
    description: "Architecture Decision Record for exactly one decision.",
    placeholder: "Describe the architectural decision, audience, alternatives, tone, and evidence.",
    audience: "Current and future maintainers",
    length: "300 to 1,000 words",
    sections: sections([
      ["Status", "Proposed unless the brief explicitly says otherwise"],
      ["Context", "Forces and constraints behind the decision"],
      ["Decision", "One decision, beginning with We will …"],
      ["Alternatives Considered", "Other choices and why they were rejected"],
      ["Consequences", "Positive, negative and follow-up consequences"],
    ]),
    writingRules: [
      "Record exactly one decision.",
      "Status is Proposed unless the brief says otherwise; never invent approval.",
    ],
    reviewFocus: [
      "Is there exactly one decision?",
      "Can a future maintainer understand why it was made?",
    ],
    readerPersona:
      "An engineer joining the team a year from now who needs to understand why this decision was made.",
  },
  prd: {
    label: "PRD",
    description:
      "Product requirements: users, problem, testable requirements and success measures.",
    placeholder:
      "Describe the product problem, target users, audience, tone, scope, and research inputs.",
    audience: "Engineers and designers building the product",
    length: "1,000 to 3,000 words",
    sections: sections([
      ["Summary", "Product and intended outcome"],
      ["Problem and Users", "User needs and supporting evidence"],
      ["Goals and Non-Goals", "Outcomes and exclusions"],
      ["Requirements", "Numbered R1, R2, …; each testable and prioritized"],
      ["Key User Flows", "User journeys and failure cases"],
      ["Success Metrics", "Measurable outcomes; label unknown targets"],
      ["Dependencies and Risks", "Constraints and dependencies"],
      ["Open Questions", "Unresolved product decisions"],
    ]),
    writingRules: [
      "Describe what and why, not implementation.",
      "Make each requirement testable and assign a priority.",
    ],
    reviewFocus: ["Is every requirement testable and traceable to a goal?", "Is done unambiguous?"],
    readerPersona:
      "The engineer and designer who will build this and need to know exactly what done means.",
  },
  runbook: {
    label: "Runbook",
    description: "Step-by-step operational procedure for on-call.",
    placeholder:
      "Describe the operation, on-call audience, tone, environment, alerts, and known procedures.",
    audience: "On-call engineers unfamiliar with the system",
    length: "As long as the procedure needs",
    sections: sections([
      ["Overview", "Purpose and when to use this procedure"],
      ["Prerequisites and Access", "Permissions, tools and environment"],
      ["Symptoms and Alerts", "Recognizing the condition"],
      ["Diagnosis", "Ordered checks with exact commands and expected output"],
      ["Mitigation", "Numbered steps, each with verification and rollback"],
      ["Escalation", "When and how to seek help; unknown contacts are TBD"],
      ["References", "Supporting sources"],
    ]),
    writingRules: [
      "Every command must be copy-pasteable; use placeholders like <namespace>.",
      "Mark destructive steps Warning and include rollback.",
    ],
    reviewFocus: [
      "Could an unfamiliar engineer follow this at 3 a.m.?",
      "Does each mitigation have verification and rollback?",
    ],
    readerPersona: "An on-call engineer paged at 3 a.m. who has never worked on this system.",
  },
  postmortem: {
    label: "Postmortem",
    description: "Blameless incident review, suitable for Investigation output.",
    placeholder:
      "Provide the incident timeline, evidence, audience, tone, impact, and investigation findings.",
    audience: "Engineers and leaders learning from the incident",
    length: "800 to 2,500 words",
    sections: sections([
      ["Summary", "What happened and the outcome"],
      ["Impact", "Quantified impact; label unknown metrics"],
      ["Timeline", "Timestamps with timezone"],
      ["Root Cause and Contributing Factors", "Evidence-backed causes and contributing conditions"],
      ["Detection", "How the incident was discovered"],
      ["Response and Recovery", "Actions taken and recovery evidence"],
      ["What Went Well / Poorly / Where We Got Lucky", "Learning without blame"],
      ["Action Items", "Table: action, prevent/detect/mitigate, priority, owner [TBD]"],
    ]),
    writingRules: ["Be blameless.", "Never invent timestamps or metrics."],
    reviewFocus: [
      "Are causes supported by evidence?",
      "Do action items prevent, detect or mitigate recurrence?",
    ],
    readerPersona:
      "An engineering leader from another organization checking what happened and whether the action items prevent a recurrence.",
  },
  explainer: {
    label: "Technical explainer",
    description: "How an existing system or code area works, grounded in code.",
    placeholder:
      "Describe the system or code area, audience knowledge, tone, learning goals, and inputs.",
    audience: "New team members and maintainers",
    length: "1,000 to 3,000 words",
    sections: sections([
      ["Overview", "Purpose and system boundaries"],
      ["Key Concepts", "Terms and mental model"],
      ["Architecture", "Components and file_path:line_number citations"],
      ["How It Works", "Trace the principal data and control flows"],
      ["Configuration and Operations", "Settings and operating procedures"],
      ["Extending and Changing It", "How to change it safely"],
      ["Gotchas and FAQ", "Surprising behavior and common questions"],
      ["References", "Sources and further reading"],
    ]),
    writingRules: ["Ground descriptions in inspected code.", "Define terms before using them."],
    reviewFocus: [
      "Can a new maintainer safely change the code?",
      "Do citations support the stated behavior?",
    ],
    readerPersona: "A new team member in their first month who needs to change this code safely.",
  },
  custom: {
    label: "Custom document",
    description: "Structure, audience and length come from the brief.",
    placeholder:
      "Specify the document format, required structure, audience, tone, length, and inputs.",
    audience: "As specified in the brief",
    length: "As the brief specifies",
    sections: [],
    writingRules: [
      "Follow the structure, audience and length in the brief.",
      "Otherwise use the conventional structure for the requested kind of document.",
    ],
    reviewFocus: ["Does it fulfill the brief?", "Can the intended audience act on it?"],
    readerPersona: "A capable colleague from a neighboring team with no background on the topic.",
  },
};

type DocumentIdentity = {
  readonly templateId?: string | undefined;
  readonly documentType?: WorkflowDocumentType | null | undefined;
};
export function planningWorkflowDocumentType(
  workflow: DocumentIdentity,
): WorkflowDocumentType | null {
  return workflow.templateId === DOCUMENT_WORKFLOW_TEMPLATE_ID
    ? (workflow.documentType ?? "custom")
    : null;
}
export function isDocumentWorkflow(workflow: DocumentIdentity): boolean {
  return planningWorkflowDocumentType(workflow) !== null;
}
export function documentWorkflowForThread(
  workflows: ReadonlyArray<PlanningWorkflow>,
  threadId: ThreadId,
): PlanningWorkflow | null {
  return (
    workflows.find(
      (workflow) =>
        isDocumentWorkflow(workflow) &&
        workflow.deletedAt === null &&
        threadIdsForPlanningWorkflow(workflow).includes(threadId),
    ) ?? null
  );
}
export function documentReaderPersona(workflow: PlanningWorkflow): string {
  return (
    workflow.readerPersona ??
    WORKFLOW_DOCUMENT_PROFILES[planningWorkflowDocumentType(workflow) ?? "custom"].readerPersona
  );
}
export function defaultDocumentReaderSlot(input: {
  branchA: WorkflowModelSlot;
  branchB: WorkflowModelSlot;
  merge: WorkflowModelSlot;
}): WorkflowModelSlot {
  return (
    [input.branchA, input.branchB].find(
      (slot) => slot.provider !== input.merge.provider || slot.model !== input.merge.model,
    ) ?? input.branchA
  );
}
export function documentReaderPassPhase(
  workflow: PlanningWorkflow,
): "reading" | "polishing" | "error" | "done" | null {
  switch (workflow.readerPass?.status) {
    case "reader_requested":
    case "reader_running":
      return "reading";
    case "reader_saved":
    case "polishing":
      return "polishing";
    case "error":
      return "error";
    case "completed":
    case "skipped":
      return "done";
    default:
      return null;
  }
}

/** Tracks CommonMark fences so examples cannot supply document headings. */
function outsideFenceLines(text: string): Array<{ line: string; index: number }> {
  let fence: { marker: string; length: number } | null = null;
  const result: Array<{ line: string; index: number }> = [];
  for (const [index, line] of text.split("\n").entries()) {
    if (fence) {
      if (new RegExp(`^ {0,3}${fence.marker}{${fence.length},}\\s*$`).test(line)) fence = null;
      continue;
    }
    const match = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (match?.[1]) {
      fence = { marker: match[1][0]!, length: match[1].length };
      continue;
    }
    result.push({ line, index });
  }
  return result;
}
export function normalizeDocumentMarkdown(text: string): string {
  let normalized = text.replace(/\r\n?/g, "\n").trim();
  if (/^<proposed_plan>\s*\n/i.test(normalized) && /\n\s*<\/proposed_plan>$/i.test(normalized))
    normalized = stripProposedPlanBlockTags(normalized);
  const title = outsideFenceLines(normalized).find(({ line }) => /^#\s+\S/.test(line));
  if (title) {
    const lines = normalized.split("\n");
    const preamble = lines.slice(0, title.index).join("\n");
    if (preamble.length <= 500 && preamble.split("\n").filter((line) => line.trim()).length <= 3)
      normalized = lines.slice(title.index).join("\n");
  }
  const outside = new Set(outsideFenceLines(normalized).map(({ index }) => index));
  return (
    normalized
      .split("\n")
      .map((line, index) => (outside.has(index) ? line.trimEnd() : line))
      .join("\n")
      .trimEnd() + "\n"
  );
}
export type DocumentValidationResult =
  | { valid: true; markdown: string }
  | { valid: false; reason: string };
const headingKey = (heading: string) =>
  heading
    .toLowerCase()
    .replace(/^\s*\d+[.)]\s*/, "")
    .replace(/[^a-z0-9]/g, "");
export function validateDocumentArtifact(
  text: string,
  documentType: WorkflowDocumentType,
  mode: "capture" | "replacement",
): DocumentValidationResult {
  const markdown = normalizeDocumentMarkdown(text);
  const lines = outsideFenceLines(markdown);
  if (!/^#[ \t]+\S/.test(markdown))
    return {
      valid: false,
      reason: "The response must start with a # title heading, without a preamble.",
    };
  if (!markdown.split("\n").slice(1).join("\n").trim())
    return {
      valid: false,
      reason: "The document has a title but no body; provide the complete document.",
    };
  const headings = lines.flatMap(({ line }) => /^##\s+(.+?)\s*#*\s*$/.exec(line)?.[1] ?? []);
  if (!headings.length)
    return {
      valid: false,
      reason: "The document needs at least one ## section heading outside code fences.",
    };
  if (markdown.length > DOCUMENT_ARTIFACT_MAX_CHARS)
    return {
      valid: false,
      reason: `The document is ${markdown.length.toLocaleString("en-US")} characters; the limit is ${DOCUMENT_ARTIFACT_MAX_CHARS.toLocaleString("en-US")}.`,
    };
  if (mode === "replacement" && documentType !== "custom") {
    const required = WORKFLOW_DOCUMENT_PROFILES[documentType].sections;
    const found = new Set(headings.map(headingKey));
    if (
      required.filter(({ heading }) => found.has(headingKey(heading))).length <
      Math.ceil(required.length / 2)
    )
      return {
        valid: false,
        reason:
          "Return the complete document with at least half of the required section headings, not a partial edit or a generic plan.",
      };
  }
  return { valid: true, markdown };
}
