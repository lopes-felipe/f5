import { ProviderDriverKind, ThreadId, type WorkflowModelSlot } from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import {
  deriveFallbackTasksFromPlan,
  extendReplacementRangeForTrailingSpace,
  isEventInDialogKeybindingContext,
  providerKindForDriver,
  resolveCodeReviewWorkflowThreadSlot,
  resolveInvestigationWorkflowThreadSlot,
  resolvePlanningWorkflowThreadSlot,
  summarizeTaskCounts,
} from "./chatViewHelpers";

const slot = (model: string): WorkflowModelSlot => ({
  provider: "codex",
  model,
});

describe("chatViewHelpers", () => {
  it("extends replacement range over a single trailing space and maps drivers to provider kinds", () => {
    expect(extendReplacementRangeForTrailingSpace("hello world", 5, "@file ")).toBe(6);
    expect(extendReplacementRangeForTrailingSpace("hello", 5, "@file ")).toBe(5);
    expect(extendReplacementRangeForTrailingSpace("hello world", 5, "@file")).toBe(5);
    expect(providerKindForDriver(ProviderDriverKind.make("codex"))).toBe("codex");
    expect(providerKindForDriver(ProviderDriverKind.make("claudeAgent"))).toBe("claudeAgent");
    expect(providerKindForDriver(ProviderDriverKind.make("acp"))).toBeNull();
  });

  it("summarizes task counts and derives fallback tasks from active plan steps", () => {
    const tasks = deriveFallbackTasksFromPlan({
      createdAt: "2026-01-01T00:00:00.000Z",
      turnId: null,
      explanation: null,
      steps: [
        { step: "Done step", status: "completed" },
        { step: "Working step", status: "inProgress" },
        { step: "Pending step", status: "pending" },
      ],
    });
    expect(tasks).toHaveLength(3);
    expect(summarizeTaskCounts(tasks)).toBe("1 active · 1 pending · 1 done");
  });

  it("resolves model slots for planning, code review, and investigation workflow threads", () => {
    const authorASlot = slot("model-a");
    const authorBSlot = slot("model-b");
    const mergeSlot = slot("model-merge");
    const implSlot = slot("model-impl");
    const reviewSlot = slot("model-review");
    const readerSlot = slot("model-reader");

    const planningWorkflow = {
      branchA: {
        branchId: "a",
        authorThreadId: ThreadId.make("t-author-a"),
        authorSlot: authorASlot,
        reviews: [
          {
            slot: "cross",
            threadId: ThreadId.make("t-cross-a"),
            reviewerBranchId: "b",
          },
        ],
      },
      branchB: {
        branchId: "b",
        authorThreadId: ThreadId.make("t-author-b"),
        authorSlot: authorBSlot,
        reviews: [],
      },
      merge: {
        threadId: ThreadId.make("t-merge"),
        mergeSlot,
      },
      implementation: {
        threadId: ThreadId.make("t-impl"),
        implementationSlot: implSlot,
        codeReviews: [{ threadId: ThreadId.make("t-cr"), reviewerSlot: reviewSlot }],
      },
      readerSlot,
      readerPass: {
        readerThreadId: ThreadId.make("t-reader"),
        previousReaderThreadIds: [ThreadId.make("t-reader-prev")],
      },
    } as never;

    expect(resolvePlanningWorkflowThreadSlot(planningWorkflow, ThreadId.make("t-author-a"))).toBe(
      authorASlot,
    );
    expect(resolvePlanningWorkflowThreadSlot(planningWorkflow, ThreadId.make("t-cross-a"))).toBe(
      authorBSlot,
    );
    expect(resolvePlanningWorkflowThreadSlot(planningWorkflow, ThreadId.make("t-merge"))).toBe(
      mergeSlot,
    );
    expect(resolvePlanningWorkflowThreadSlot(planningWorkflow, ThreadId.make("t-impl"))).toBe(
      implSlot,
    );
    expect(resolvePlanningWorkflowThreadSlot(planningWorkflow, ThreadId.make("t-cr"))).toBe(
      reviewSlot,
    );
    expect(resolvePlanningWorkflowThreadSlot(planningWorkflow, ThreadId.make("t-reader"))).toBe(
      readerSlot,
    );
    expect(
      resolvePlanningWorkflowThreadSlot(planningWorkflow, ThreadId.make("t-reader-prev")),
    ).toBe(readerSlot);
    expect(
      resolvePlanningWorkflowThreadSlot(planningWorkflow, ThreadId.make("t-unknown")),
    ).toBeNull();

    const codeReviewWorkflow = {
      reviewerA: { threadId: ThreadId.make("cr-a"), slot: authorASlot },
      reviewerB: { threadId: ThreadId.make("cr-b"), slot: authorBSlot },
      consolidation: { threadId: ThreadId.make("cr-cons"), slot: mergeSlot },
    } as never;
    expect(resolveCodeReviewWorkflowThreadSlot(codeReviewWorkflow, ThreadId.make("cr-a"))).toBe(
      authorASlot,
    );
    expect(resolveCodeReviewWorkflowThreadSlot(codeReviewWorkflow, ThreadId.make("cr-cons"))).toBe(
      mergeSlot,
    );
    expect(
      resolveCodeReviewWorkflowThreadSlot(codeReviewWorkflow, ThreadId.make("cr-other")),
    ).toBeNull();

    const investigationWorkflow = {
      investigatorA: {
        investigationThreadId: ThreadId.make("inv-a"),
        selfReviewThreadId: ThreadId.make("inv-a-self"),
        crossReviewThreadId: ThreadId.make("inv-a-on-b"),
        slot: authorASlot,
      },
      investigatorB: {
        investigationThreadId: ThreadId.make("inv-b"),
        selfReviewThreadId: ThreadId.make("inv-b-self"),
        crossReviewThreadId: ThreadId.make("inv-b-on-a"),
        slot: authorBSlot,
      },
      synthesis: { threadId: ThreadId.make("inv-synth"), slot: mergeSlot },
    } as never;
    expect(
      resolveInvestigationWorkflowThreadSlot(investigationWorkflow, ThreadId.make("inv-a-self")),
    ).toBe(authorASlot);
    expect(
      resolveInvestigationWorkflowThreadSlot(investigationWorkflow, ThreadId.make("inv-b-on-a")),
    ).toBe(authorBSlot);
    expect(
      resolveInvestigationWorkflowThreadSlot(investigationWorkflow, ThreadId.make("inv-synth")),
    ).toBe(mergeSlot);
    expect(
      resolveInvestigationWorkflowThreadSlot(investigationWorkflow, ThreadId.make("inv-unknown")),
    ).toBeNull();
  });

  it("detects keyboard events inside dialog popups and portaled popups", () => {
    const prevNode = globalThis.Node;
    const prevElement = globalThis.Element;
    const prevDocument = globalThis.document;
    class FakeNode {
      parentElement: FakeElement | null = null;
    }
    class FakeElement extends FakeNode {
      constructor(private readonly matchedSelector: string | null) {
        super();
      }
      closest(selector: string): FakeElement | null {
        if (!this.matchedSelector) return null;
        return selector.includes(this.matchedSelector) ? this : null;
      }
    }

    let dialogOpen = false;
    globalThis.Node = FakeNode as unknown as typeof Node;
    globalThis.Element = FakeElement as unknown as typeof Element;
    globalThis.document = {
      querySelector: (selector: string) =>
        dialogOpen && selector.includes("dialog-popup") ? {} : null,
    } as unknown as Document;

    try {
      const insideDialog = new FakeElement('[data-slot="dialog-popup"]');
      const insidePopover = new FakeElement('[data-slot="popover-popup"]');
      const plainTarget = new FakeElement(null);

      expect(isEventInDialogKeybindingContext({ target: insideDialog } as never)).toBe(true);
      expect(isEventInDialogKeybindingContext({ target: insidePopover } as never)).toBe(false);
      expect(isEventInDialogKeybindingContext({ target: plainTarget } as never)).toBe(false);

      dialogOpen = true;
      expect(isEventInDialogKeybindingContext({ target: insidePopover } as never)).toBe(true);
      expect(isEventInDialogKeybindingContext({ target: plainTarget } as never)).toBe(false);
    } finally {
      globalThis.Node = prevNode;
      globalThis.Element = prevElement;
      globalThis.document = prevDocument;
    }
  });
});
