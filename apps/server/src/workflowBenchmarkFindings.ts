import {
  ThreadId,
  TurnId,
  type WorkflowBenchmarkFinding,
  type WorkflowBenchmarkInput,
  type WorkflowBenchmarkPhase,
} from "@t3tools/contracts";
import type { AttributedBenchmarkTurn } from "./workflowBenchmark.ts";
import {
  decodeStoredDispositions,
  decodeFindings,
  workflowFindingRef,
  type Finding,
} from "./orchestration/workflowFindingProtocol.ts";

export interface BenchmarkOutputRow {
  readonly threadId: string;
  readonly turnId: string;
  readonly taskId: string;
  readonly kind: "findings" | "dispositions";
  readonly coverage: string;
  readonly metadata: string | null;
  readonly messageId: string | null;
  readonly planId: string | null;
}

type FindingSelection = Extract<WorkflowBenchmarkInput["select"], { kind: "findings" }>;
type Resolution = NonNullable<WorkflowBenchmarkFinding["resolution"]>;
type Model = WorkflowBenchmarkFinding["reporters"][number]["model"];

interface Report {
  readonly ref: string;
  readonly phase: WorkflowBenchmarkPhase;
  readonly target: string | null;
  readonly model: Model;
  readonly origin: WorkflowBenchmarkFinding["reporters"][number]["origin"];
  readonly finding: Finding;
  verdict: "confirmed" | "checking" | "dismissed";
  resolution: Resolution | null;
  resolutionKind: "fixed" | "addressed" | null;
  test: WorkflowBenchmarkFinding["test"];
  testEvidence: WorkflowBenchmarkFinding["testEvidence"];
  reportedCorrection: string | null;
  decisionOrder: number;
}

function normalized(text: string) {
  return text.normalize("NFKC").trim().toLowerCase().replace(/\s+/g, " ");
}

const rank = { critical: 0, high: 1, medium: 2, low: 3 };

function proofTarget(entry: AttributedBenchmarkTurn, finding: Finding): string | null {
  const target = entry.attribution.reviewTarget;
  if (entry.attribution.runKind === "codeReview" && target?.baseRevision && target.headRevision) {
    return JSON.stringify([entry.phase, target.baseRevision, target.headRevision]);
  }
  if (!target?.turnId || !target.threadId) return null;
  if (entry.phase === "code-review" && !target.patchHash) return null;
  if (
    target.truncated &&
    !target.anchors?.some((path) => {
      const location = finding.location?.trim();
      return location === path || location?.startsWith(path + ":");
    })
  )
    return null;
  return JSON.stringify([
    entry.phase,
    target.threadId,
    target.turnId,
    target.planId ?? null,
    target.patchHash ?? null,
  ]);
}

function source(row: BenchmarkOutputRow) {
  return {
    threadId: ThreadId.make(row.threadId),
    turnId: TurnId.make(row.turnId),
    messageId: row.messageId,
    planId: row.planId,
  };
}

function isConfirmed(finding: WorkflowBenchmarkFinding) {
  return ["confirmed", "fixed", "addressed"].includes(finding.status);
}

function priority(finding: WorkflowBenchmarkFinding) {
  const open = finding.status === "checking" || finding.status === "confirmed";
  return open && rank[finding.severity] <= rank.high ? 0 : 1;
}

function countFindings(findings: readonly WorkflowBenchmarkFinding[]) {
  let confirmed = 0;
  let checking = 0;
  let dismissed = 0;
  let shared = 0;
  const exclusive = new Map<string, number>();
  for (const finding of findings) {
    if (isConfirmed(finding)) {
      confirmed++;
      const models = new Set(finding.reporters.map(({ model }) => model.id));
      const unknown = models.delete("unknown");
      if (models.size > 1) shared++;
      else {
        const [model] = models;
        if (model && !unknown) exclusive.set(model, (exclusive.get(model) ?? 0) + 1);
      }
    } else if (finding.status === "dismissed") dismissed++;
    else checking++;
  }
  return {
    confirmed,
    checking,
    dismissed,
    shared,
    exclusive: Array.from(exclusive, ([model, count]) => ({ model, count })),
  };
}

export function benchmarkFindings(
  turns: ReadonlyArray<AttributedBenchmarkTurn>,
  outputs: ReadonlyArray<BenchmarkOutputRow>,
) {
  const key = (threadId: string, turnId: string) => JSON.stringify([threadId, turnId]);
  const byTurn = new Map(
    turns.flatMap((entry) =>
      entry.turn.turnId && entry.turn.threadId
        ? [[key(entry.turn.threadId, entry.turn.turnId), entry] as const]
        : [],
    ),
  );
  const reports: Report[] = [];
  const indexes = new Map<string, number>();
  const parent: number[] = [];
  const exact = new Map<string, number>();
  const root = (index: number): number => {
    let result = index;
    while (parent[result] !== result) result = parent[result]!;
    while (index !== result) {
      const next = parent[index]!;
      parent[index] = result;
      index = next;
    }
    return result;
  };
  const join = (a: number, b: number) => {
    const first = root(a);
    const second = root(b);
    if (first !== second) parent[Math.max(first, second)] = Math.min(first, second);
  };
  for (const row of outputs) {
    if (row.kind !== "findings" || !row.metadata || row.coverage !== "structured") continue;
    const entry = byTurn.get(key(row.threadId, row.turnId));
    if (!entry || entry.attribution.taskId !== row.taskId || entry.turn.status === "Reverted")
      continue;
    for (const finding of decodeFindings(JSON.parse(row.metadata))) {
      const ref = workflowFindingRef(row.threadId, row.turnId, finding.id);
      const target = proofTarget(entry, finding);
      const index = reports.length;
      indexes.set(ref, index);
      parent.push(index);
      reports.push({
        ref,
        phase: entry.phase,
        target,
        model: entry.turn.model,
        origin: source(row),
        finding,
        verdict: "checking",
        resolution: null,
        resolutionKind: null,
        test: null,
        testEvidence: undefined,
        reportedCorrection: null,
        decisionOrder: -1,
      });
      if (!target || !finding.location?.trim()) continue;
      const duplicate = JSON.stringify([
        target,
        normalized(finding.location),
        normalized(finding.title),
        normalized(finding.description),
      ]);
      const earlier = exact.get(duplicate);
      if (earlier === undefined) exact.set(duplicate, index);
      else join(earlier, index);
    }
  }
  for (const [order, row] of outputs.entries()) {
    if (row.kind !== "dispositions" || !row.metadata || row.coverage !== "structured") continue;
    const entry = byTurn.get(key(row.threadId, row.turnId));
    if (!entry || entry.attribution.taskId !== row.taskId || entry.turn.status === "Reverted")
      continue;
    const allowed = new Set(entry.attribution.findingRefs);
    for (const disposition of decodeStoredDispositions(JSON.parse(row.metadata))) {
      if (!allowed.has(disposition.ref)) continue;
      const index = indexes.get(disposition.ref);
      if (index === undefined) continue;
      const report = reports[index]!;
      report.verdict = disposition.verdict;
      report.decisionOrder = order;
      report.resolutionKind = null;
      report.resolution = null;
      report.test =
        disposition.verifiedTest ??
        (disposition.testExecutionId || disposition.testReported ? "reported" : null);
      report.testEvidence =
        disposition.verifiedTest && disposition.testExecutionId
          ? {
              id: disposition.testExecutionId,
              origin: disposition.verifiedTest === "confirmed" ? report.origin : source(row),
            }
          : undefined;
      report.reportedCorrection =
        disposition.resolution === "fixed" && !disposition.verifiedResolution
          ? disposition.evidence?.trim() || "The correcting stage reported a fix."
          : null;
      if (report.verdict !== "confirmed") continue;
      const evidence = disposition.evidence?.trim() || null;
      if (evidence && disposition.verifiedResolution) {
        report.resolutionKind = disposition.verifiedResolution;
        report.resolution = {
          model: entry.turn.model,
          origin: source(row),
          evidence,
          ...(disposition.diffFileChangeId
            ? { diffFileChangeId: disposition.diffFileChangeId }
            : {}),
        };
      }
      for (const equivalent of disposition.equivalentTo ?? []) {
        const otherIndex = indexes.get(equivalent);
        if (otherIndex === undefined || !allowed.has(equivalent)) continue;
        if (report.target && report.target === reports[otherIndex]!.target) join(index, otherIndex);
      }
    }
  }
  const groups = new Map<number, Report[]>();
  for (const [index, report] of reports.entries()) {
    const group = root(index);
    const members = groups.get(group) ?? [];
    members.push(report);
    groups.set(group, members);
  }
  const byPhase = new Map<WorkflowBenchmarkPhase, WorkflowBenchmarkFinding[]>();
  for (const members of groups.values()) {
    const first = members[0]!;
    const severe = members.reduce(
      (worst, member) =>
        rank[member.finding.severity] < rank[worst.finding.severity] ? member : worst,
      first,
    );
    const resolved = members
      .filter((member) => member.resolutionKind !== null)
      .sort((a, b) => b.decisionOrder - a.decisionOrder)[0];
    const tested =
      resolved?.test === "passed"
        ? resolved
        : members.find((member) => member.test === "confirmed");
    const status =
      resolved?.resolutionKind ??
      (members.some((member) => member.verdict === "confirmed")
        ? "confirmed"
        : members.every((member) => member.verdict === "dismissed")
          ? "dismissed"
          : "checking");
    const findings = byPhase.get(first.phase) ?? [];
    findings.push({
      id: first.ref,
      aliases: members.slice(1).map(({ ref }) => ref),
      severity: severe.finding.severity,
      title: severe.finding.title,
      description: severe.finding.description,
      location: severe.finding.location,
      evidence: [
        ...new Set(
          members.flatMap(({ finding, reportedCorrection }) => [
            ...(finding.evidence ? [finding.evidence] : []),
            ...(reportedCorrection ? [`Reported fix — ${reportedCorrection}`] : []),
          ]),
        ),
      ],
      reporters: members.map(({ model, origin }) => ({ model, origin })),
      status,
      resolution: resolved?.resolution ?? null,
      test:
        tested?.test ??
        resolved?.test ??
        (members.some((member) => member.test) ? "reported" : null),
      ...(tested?.testEvidence ? { testEvidence: tested.testEvidence } : {}),
    });
    byPhase.set(first.phase, findings);
  }
  const pages = new Map(
    [...byPhase].map(([phase, findings]) => [
      phase,
      {
        counts: countFindings(findings),
        entries: findings
          .sort(
            (a, b) =>
              priority(a) - priority(b) ||
              rank[a.severity] - rank[b.severity] ||
              a.title.localeCompare(b.title) ||
              a.id.localeCompare(b.id),
          )
          .map((finding) => ({
            finding,
            searchText: normalized(
              [
                finding.title,
                finding.description,
                finding.location,
                ...finding.evidence,
                finding.resolution?.evidence,
              ].join(" "),
            ),
          })),
      },
    ]),
  );
  return {
    count: (phase: WorkflowBenchmarkPhase) => pages.get(phase)?.entries.length ?? 0,
    total: groups.size,
    page: (select: FindingSelection) => {
      const page = pages.get(select.phase);
      const search = normalized(select.search ?? "");
      const filtered = (page?.entries ?? []).filter(
        ({ finding, searchText }) =>
          (!select.model || finding.reporters.some(({ model }) => model.id === select.model)) &&
          (!select.severity || finding.severity === select.severity) &&
          (!select.status || finding.status === select.status) &&
          (!search || searchText.includes(search)),
      );
      const offset = select.offset ?? 0;
      return {
        kind: "findings" as const,
        items: filtered.slice(offset, offset + 50).map(({ finding }) => finding),
        count: filtered.length,
        counts: page?.counts ?? countFindings([]),
      };
    },
  };
}
