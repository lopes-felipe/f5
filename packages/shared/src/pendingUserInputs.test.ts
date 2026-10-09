import {
  ApprovalRequestId,
  type OrchestrationEvent,
  type PendingUserInput,
  ThreadId,
} from "@t3tools/contracts";
import { describe, expect, it } from "vitest";
import {
  ELICITATION_SUBMITTED_ACTIVITY_KIND,
  holdsAutomaticResume,
  isBlockingUserInput,
  projectPendingUserInputs,
} from "./pendingUserInputs";

const threadId = ThreadId.makeUnsafe("thread-1");

function input(
  requestId: string,
  extra: Partial<Pick<PendingUserInput, "responseMode" | "blocking">> = {},
): PendingUserInput {
  return {
    requestId: ApprovalRequestId.makeUnsafe(requestId),
    turnId: null,
    createdAt: "2026-10-08T00:00:00.000Z",
    questions: [],
    ...extra,
  };
}

function sessionSet(status: "ready" | "stopped" | "error"): OrchestrationEvent {
  return {
    type: "thread.session-set",
    payload: { threadId, session: { status, activeTurnId: null } },
  } as unknown as OrchestrationEvent;
}

function activity(kind: string, payload: Record<string, unknown>): OrchestrationEvent {
  return {
    type: "thread.activity-appended",
    payload: {
      threadId,
      activity: { kind, payload, turnId: null, createdAt: "2026-10-08T00:00:01.000Z" },
    },
  } as unknown as OrchestrationEvent;
}

describe("elicitation receipts", () => {
  const form = input("form", {});
  const elicitation = {
    ...form,
    elicitation: { mode: "form" as const, message: "Token?", generation: 1, fields: [] },
  };

  it("moves pending to submitted and resolves on the provider receipt", () => {
    const submitted = projectPendingUserInputs(
      [elicitation],
      activity(ELICITATION_SUBMITTED_ACTIVITY_KIND, { requestId: "form" }),
    );
    expect(submitted[0]?.receipt).toBe("submitted");
    expect(
      projectPendingUserInputs(
        submitted,
        activity("user-input.resolved", { requestId: "form", receipt: "resolved" }),
      ),
    ).toEqual([]);
  });

  it("keeps unconfirmed answers visible as indeterminate until explicitly dismissed", () => {
    const submitted = [{ ...elicitation, receipt: "submitted" as const }];
    const afterExit = projectPendingUserInputs(submitted, sessionSet("stopped"));
    expect(afterExit[0]?.receipt).toBe("indeterminate");
    expect(isBlockingUserInput(afterExit[0]!)).toBe(false);
    // A turn-end dismissal does not hide it; only an explicit receipt does.
    expect(
      projectPendingUserInputs(
        afterExit,
        activity("user-input.resolved", { requestId: "form", resolution: "dismissed" }),
      ),
    ).toHaveLength(1);
    expect(
      projectPendingUserInputs(
        afterExit,
        activity("user-input.resolved", { requestId: "form", receipt: "cancelled" }),
      ),
    ).toEqual([]);
    // Unanswered requests are dropped (cancelled) with the session.
    expect(projectPendingUserInputs([elicitation], sessionSet("stopped"))).toEqual([]);
  });
});

describe("pending user input blocking semantics", () => {
  it("treats message transport and explicit non-blocking requests as non-blocking", () => {
    expect(isBlockingUserInput(input("a"))).toBe(true);
    expect(isBlockingUserInput(input("b", { responseMode: "message" }))).toBe(false);
    expect(isBlockingUserInput(input("c", { blocking: false }))).toBe(false);
  });

  it("holds automatic resume for message-mode questions but not explicit non-blocking ones", () => {
    expect(holdsAutomaticResume(input("a"))).toBe(true);
    expect(holdsAutomaticResume(input("b", { responseMode: "message" }))).toBe(true);
    expect(holdsAutomaticResume(input("c", { blocking: false }))).toBe(false);
    expect(holdsAutomaticResume({ ...input("d"), receipt: "indeterminate" })).toBe(false);
  });

  it("keeps non-blocking requests past the turn end and drops them when the session ends", () => {
    const current = [
      input("blocking"),
      input("non-blocking", { blocking: false }),
      input("message", { responseMode: "message", blocking: false }),
    ];
    expect(
      projectPendingUserInputs(current, sessionSet("ready")).map((entry) => entry.requestId),
    ).toEqual(["non-blocking", "message"]);
    for (const status of ["stopped", "error"] as const)
      expect(
        projectPendingUserInputs(current, sessionSet(status)).map((entry) => entry.requestId),
      ).toEqual(["message"]);
  });
});
