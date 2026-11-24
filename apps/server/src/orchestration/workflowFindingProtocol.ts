import { Schema } from "effect";
import { WorkflowFindingSeverity, WorkflowFindingVerdict } from "@t3tools/contracts";

const textField = Schema.String.check(Schema.isMaxLength(4_000));
const localId = Schema.String.check(Schema.isPattern(/^[a-zA-Z0-9_-]{1,64}$/));
const reference = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(800));
const Finding = Schema.Struct({
  id: localId,
  severity: WorkflowFindingSeverity,
  title: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(300)),
  description: textField,
  location: Schema.NullOr(textField),
  evidence: Schema.NullOr(textField),
  subagentFinding: Schema.optional(Schema.Struct({ agentId: reference, findingId: localId })),
});
export const WORKFLOW_SUBAGENT_FINDING_INSTRUCTIONS =
  "If you delegate a review, ask the subagent to return its own f5-findings-v1 block. When you include one of those findings, keep its title and location and add subagentFinding with the exact provider agent ID and local finding ID from that result, if available.";
export type Finding = typeof Finding.Type;

const Disposition = Schema.Struct({
  ref: reference,
  verdict: WorkflowFindingVerdict,
  equivalentTo: Schema.optional(Schema.Array(reference).check(Schema.isMaxLength(30))),
  resolution: Schema.optional(Schema.Literals(["fixed", "addressed"])),
  evidence: Schema.optional(textField),
  correction: Schema.optional(Schema.Struct({ before: textField, after: textField })),
  testExecutionId: Schema.optional(reference),
  testCase: Schema.optional(reference),
  testReported: Schema.optional(Schema.Boolean),
});
export type Disposition = typeof Disposition.Type;

const Findings = Schema.Array(Finding).check(Schema.isMaxLength(200));
const Dispositions = Schema.Array(Disposition).check(Schema.isMaxLength(200));
const StoredDisposition = Schema.Struct({
  ...Disposition.fields,
  verifiedResolution: Schema.optional(Schema.Literals(["fixed", "addressed"])),
  verifiedTest: Schema.optional(Schema.Literals(["confirmed", "passed"])),
  diffFileChangeId: Schema.optional(Schema.String),
});
export const decodeStoredDispositions = Schema.decodeUnknownSync(Schema.Array(StoredDisposition));
export type StoredDisposition = typeof StoredDisposition.Type;
export const decodeFindings = Schema.decodeUnknownSync(Findings);
export const decodeDispositions = Schema.decodeUnknownSync(Dispositions);

type Coverage = "structured" | "invalid" | "unavailable";
export type FindingProtocolOutput = {
  readonly markdown: string;
  readonly coverage: Coverage;
  readonly metadata: ReadonlyArray<Finding | Disposition> | null;
};

const labels = {
  findings: "f5-findings-v1",
  dispositions: "f5-finding-dispositions-v1",
} as const;

/** Only top-level Markdown fences count. A quoted or nested example is ordinary content. */
export function parseWorkflowFindingOutput(
  markdown: string,
  kind: keyof typeof labels,
): FindingProtocolOutput {
  const lines = markdown.split(/\r?\n/);
  const blocks: Array<{ start: number; end: number | null }> = [];
  let fence: { mark: string; length: number; block?: (typeof blocks)[number] } | null = null;
  for (const [index, line] of lines.entries()) {
    const match = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (!match) continue;
    const marks = match[1]!;
    const info = match[2]!.trim();
    if (fence) {
      if (marks[0] === fence.mark && marks.length >= fence.length && !info) {
        if (fence.block) fence.block.end = index;
        fence = null;
      }
      continue;
    }
    const block = info === labels[kind] ? { start: index, end: null } : undefined;
    if (block) blocks.push(block);
    fence = { mark: marks[0]!, length: marks.length, ...(block ? { block } : {}) };
  }
  const block = blocks[0];
  if (!block) return { markdown, coverage: "unavailable", metadata: null };

  const cleaned = lines
    .filter(
      (_, index) =>
        !blocks.some(({ start, end }) => index >= start && (end === null || index <= end)),
    )
    .join("\n")
    .trim();
  const suffix =
    block.end === null
      ? ""
      : lines
          .slice(block.end + 1)
          .join("\n")
          .trim();
  const prefix = lines.slice(0, block.start).join("\n");
  const terminal =
    !suffix ||
    (suffix === "</proposed_plan>" && /(?:^|\n)\s*<proposed_plan>\s*(?:\n|$)/.test(prefix));
  if (blocks.length === 1 && block.end !== null && terminal) {
    const json = lines.slice(block.start + 1, block.end).join("\n");
    if (json.length <= 100_000) {
      try {
        const decoded = JSON.parse(json) as unknown;
        const metadata =
          kind === "findings" ? decodeFindings(decoded) : decodeDispositions(decoded);
        const keys = metadata.map((item) => ("id" in item ? item.id : item.ref));
        if (new Set(keys).size === keys.length)
          return { markdown: cleaned, coverage: "structured", metadata };
      } catch {
        // The readable report remains usable after malformed metadata.
      }
    }
  }
  return { markdown: cleaned, coverage: "invalid", metadata: null };
}

export function workflowFindingRef(threadId: string, turnId: string, localId: string): string {
  return [threadId, turnId, localId].map(encodeURIComponent).join("/");
}

export const WORKFLOW_DISPOSITIONS_INSTRUCTIONS = [
  "End the public artifact with exactly one f5-finding-dispositions-v1 fenced JSON array.",
  'Use entries such as {"ref":"<exact reference>","verdict":"confirmed","equivalentTo":[],"resolution":"fixed","evidence":"Supporting evidence","testExecutionId":"<F5 execution ID>"} only for references listed below.',
  "Use confirmed, checking or dismissed for verdict. For a claimed fix, include correction with exact before and after excerpts from the reported location. For a targeted test, include its F5 execution ID and the exact testCase selector. Set testReported to true for a claimed test without an identifiable execution. Place the block inside the delivered plan or document when submitting one.",
].join("\n");
