import type {
  CodeReviewWorkflow,
  InvestigationWorkflow,
  PlanningWorkflow,
  ThreadId,
  WorkflowBenchmarkPhase,
  WorkflowModelSlot,
  WorkflowRunKind,
} from "@t3tools/contracts";
import { isDocumentWorkflow } from "@t3tools/shared/documentWorkflow";

export type BenchmarkWorkflow = PlanningWorkflow | CodeReviewWorkflow | InvestigationWorkflow;

export const BENCHMARK_PHASES = {
  authoring: "Authoring",
  reviews: "Reviews",
  revision: "Revision",
  merge: "Merge",
  implementation: "Implementation",
  "code-review": "Code review",
  "apply-feedback": "Apply feedback",
  "reader-review": "Reader review",
  polish: "Polish",
  consolidation: "Consolidation",
  investigation: "Investigation",
  synthesis: "Synthesis",
} satisfies Record<WorkflowBenchmarkPhase, string>;

export function benchmarkPhases(run: BenchmarkWorkflow): readonly WorkflowBenchmarkPhase[] {
  if ("reviewerA" in run) return ["reviews", "consolidation"];
  if ("investigatorA" in run) return ["investigation", "reviews", "synthesis"];
  if (isDocumentWorkflow(run)) {
    return [
      "authoring",
      "reviews",
      "revision",
      "merge",
      ...(run.readerReviewEnabled ? (["reader-review", "polish"] as const) : []),
    ];
  }
  return [
    "authoring",
    "reviews",
    "revision",
    "merge",
    "implementation",
    "code-review",
    "apply-feedback",
  ];
}

export function benchmarkRunKind(run: BenchmarkWorkflow): WorkflowRunKind {
  if ("reviewerA" in run) return "codeReview";
  if ("investigatorA" in run) return "investigation";
  return "planning";
}

export function benchmarkPhase(taskId: string): WorkflowBenchmarkPhase | null {
  if (taskId.startsWith("author-")) return "authoring";
  if (taskId.startsWith("revision-")) return "revision";
  if (taskId.startsWith("investigator-")) return "investigation";
  if (taskId.startsWith("implementation-review-")) return "code-review";
  if (/^(cross-review|self-review|reviewer)-[ab]$/.test(taskId)) return "reviews";
  return Object.hasOwn(BENCHMARK_PHASES, taskId) ? (taskId as WorkflowBenchmarkPhase) : null;
}

export function benchmarkOutputKind(taskId: string): "findings" | "dispositions" | null {
  switch (benchmarkPhase(taskId)) {
    case "reviews":
    case "code-review":
    case "reader-review":
      return "findings";
    case "revision":
    case "apply-feedback":
    case "consolidation":
    case "synthesis":
    case "polish":
      return "dispositions";
    default:
      return null;
  }
}

export function benchmarkRole(taskId: string): string {
  const suffix = taskId.at(-1)?.toUpperCase();
  if (taskId.startsWith("cross-review-")) return "Cross-review";
  if (taskId.startsWith("self-review-")) return "Self-review";
  if (taskId.startsWith("implementation-review-") || taskId.startsWith("reviewer-")) {
    return `Reviewer ${suffix}`;
  }
  if (taskId.startsWith("author-")) return `Author ${suffix}`;
  if (taskId.startsWith("revision-")) return `Revision ${suffix}`;
  if (taskId.startsWith("investigator-")) return `Investigator ${suffix}`;
  const phase = benchmarkPhase(taskId);
  return phase ? BENCHMARK_PHASES[phase] : taskId;
}

export interface BenchmarkTask {
  readonly id: string;
  readonly threadId: ThreadId | null;
  readonly slot: WorkflowModelSlot;
  readonly status: string;
  readonly turnId?: string | null | undefined;
  readonly messageId?: string | null | undefined;
  readonly planId?: string | null | undefined;
  readonly commandId?: string | null | undefined;
}

export function benchmarkTasks(run: BenchmarkWorkflow): BenchmarkTask[] {
  if ("reviewerA" in run) {
    return [
      ...(["reviewerA", "reviewerB"] as const).map((key, index) => {
        const stage = run[key];
        return {
          id: index === 0 ? "reviewer-a" : "reviewer-b",
          threadId: stage.threadId,
          slot: stage.slot,
          status: stage.status,
          turnId: stage.pinnedTurnId,
          messageId: stage.pinnedAssistantMessageId,
          commandId: stage.dispatchCommandId,
        };
      }),
      {
        id: "consolidation",
        ...run.consolidation,
        turnId: run.consolidation.pinnedTurnId,
        messageId: run.consolidation.pinnedAssistantMessageId,
        commandId: run.consolidation.dispatchCommandId,
      },
    ];
  }
  if ("investigatorA" in run) {
    const tasks: BenchmarkTask[] = [];
    for (const [suffix, stage] of [
      ["a", run.investigatorA],
      ["b", run.investigatorB],
    ] as const) {
      tasks.push(
        {
          id: `investigator-${suffix}`,
          threadId: stage.investigationThreadId,
          slot: stage.slot,
          status: stage.investigationStatus,
          turnId: stage.investigationTurnId,
          messageId: stage.investigationMessageId,
          commandId: stage.investigationDispatchCommandId,
        },
        {
          id: `cross-review-${suffix}`,
          threadId: stage.crossReviewThreadId,
          slot: stage.slot,
          status: stage.crossReviewStatus,
          turnId: stage.crossReviewTurnId,
          messageId: stage.crossReviewMessageId,
          commandId: stage.crossReviewDispatchCommandId,
        },
      );
      if (run.selfReviewEnabled)
        tasks.push({
          id: `self-review-${suffix}`,
          threadId: stage.selfReviewThreadId,
          slot: stage.slot,
          status: stage.selfReviewStatus,
          turnId: stage.selfReviewTurnId,
          messageId: stage.selfReviewMessageId,
          commandId: stage.selfReviewDispatchCommandId,
        });
    }
    tasks.push({
      id: "synthesis",
      ...run.synthesis,
      turnId: run.synthesis.pinnedTurnId,
      messageId: run.synthesis.pinnedAssistantMessageId,
      commandId: run.synthesis.dispatchCommandId,
    });
    return tasks;
  }

  const tasks: BenchmarkTask[] = [];
  for (const branch of [run.branchA, run.branchB]) {
    tasks.push(
      {
        id: `author-${branch.branchId}`,
        threadId: branch.authorThreadId,
        slot: branch.authorSlot,
        status: branch.planTurnId ? "completed" : branch.status,
        turnId: branch.planTurnId,
      },
      {
        id: `revision-${branch.branchId}`,
        threadId: branch.authorThreadId,
        slot: branch.authorSlot,
        status: branch.revisionTurnId
          ? "completed"
          : branch.status === "revising"
            ? "running"
            : "not_started",
        turnId: branch.revisionTurnId,
      },
    );
    for (const review of branch.reviews) {
      const peer = branch.branchId === "a" ? run.branchB : run.branchA;
      tasks.push({
        id: `${review.slot}-review-${branch.branchId}`,
        ...review,
        slot: review.slot === "self" ? branch.authorSlot : peer.authorSlot,
        turnId: review.pinnedTurnId,
        messageId: review.pinnedAssistantMessageId,
      });
    }
  }
  const pass = run.readerPass;
  tasks.push({
    id: "merge",
    threadId: run.merge.threadId,
    slot: run.merge.mergeSlot,
    status: run.merge.status,
    turnId: pass?.draftTurnId ?? run.merge.turnId,
    planId: pass?.draftPlanId ?? run.merge.approvedPlanId,
  });
  if (pass && run.readerSlot && pass.status !== "skipped") {
    tasks.push(
      {
        id: "reader-review",
        threadId: pass.readerThreadId,
        slot: run.readerSlot,
        status: pass.pinnedTurnId ? "completed" : pass.status,
        turnId: pass.pinnedTurnId,
        messageId: pass.pinnedAssistantMessageId,
      },
      {
        id: "polish",
        threadId: run.merge.threadId,
        slot: run.merge.mergeSlot,
        status: pass.status,
        turnId: pass.polishTurnId,
        planId: pass.polishTurnId ? run.merge.approvedPlanId : null,
      },
    );
  }
  const implementation = run.implementation;
  if (implementation) {
    tasks.push(
      {
        id: "implementation",
        threadId: implementation.threadId,
        slot: implementation.implementationSlot,
        status: implementation.implementationTurnId ? "completed" : implementation.status,
        turnId: implementation.implementationTurnId,
      },
      {
        id: "apply-feedback",
        threadId: implementation.threadId,
        slot: implementation.implementationSlot,
        status: implementation.revisionTurnId
          ? "completed"
          : implementation.status === "applying_reviews"
            ? "running"
            : "not_started",
        turnId: implementation.revisionTurnId,
        commandId: implementation.revisionDispatchCommandId,
      },
      ...implementation.codeReviews.map((review, index) => ({
        id: index === 0 ? "implementation-review-a" : "implementation-review-b",
        threadId: review.threadId,
        slot: review.reviewerSlot,
        status: review.status,
        turnId: review.pinnedTurnId,
        messageId: review.pinnedAssistantMessageId,
      })),
    );
  }
  return tasks;
}
