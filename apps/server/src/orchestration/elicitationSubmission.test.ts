import {
  ApprovalRequestId,
  type OrchestrationCommand,
  type OrchestrationReadModel,
  type PendingUserInput,
  ThreadId,
} from "@t3tools/contracts";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import {
  reconcileElicitationsOnStartup,
  submitElicitation,
  type ElicitationSubmissionDeps,
} from "./elicitationSubmission.ts";

const SENTINEL = "sentinel-answer-91c2";
const threadId = ThreadId.makeUnsafe("thread-1");
const requestId = ApprovalRequestId.makeUnsafe("req-1");

function pendingInput(overrides: Partial<PendingUserInput> = {}): PendingUserInput {
  return {
    requestId,
    turnId: null,
    createdAt: "2026-10-08T00:00:00.000Z",
    questions: [],
    elicitation: {
      mode: "form",
      message: "Token?",
      generation: 3,
      fields: [{ key: "token", title: "Token", required: true, type: "string" }],
    },
    ...overrides,
  };
}

function harness(input: PendingUserInput | undefined, respond?: () => Effect.Effect<"submitted">) {
  const dispatched: OrchestrationCommand[] = [];
  const responses: unknown[] = [];
  const deps: ElicitationSubmissionDeps = {
    orchestrationEngine: {
      getReadModel: () =>
        Effect.succeed({
          threads: [{ id: threadId, deletedAt: null, pendingUserInputs: input ? [input] : [] }],
        } as unknown as OrchestrationReadModel),
      dispatch: (command) =>
        Effect.sync(() => {
          dispatched.push(command);
          return { sequence: dispatched.length };
        }),
    },
    providerService: {
      respondToElicitation: (submission) =>
        Effect.suspend(() => {
          responses.push(submission);
          return respond ? respond() : Effect.succeed("submitted" as const);
        }),
    },
    inFlight: new Set(),
  };
  return { deps, dispatched, responses };
}

const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(Effect.result(effect));

describe("private elicitation submission", () => {
  it("delivers values to the provider and records only a value-free receipt", async () => {
    const { deps, dispatched, responses } = harness(pendingInput());
    const result = await run(
      submitElicitation(deps, {
        threadId,
        requestId,
        generation: 3,
        action: "accept",
        content: { token: SENTINEL },
      }),
    );
    expect(result._tag).toBe("Success");
    expect(responses).toHaveLength(1);
    expect(dispatched).toHaveLength(1);
    expect(JSON.stringify(dispatched)).not.toContain(SENTINEL);
    expect(dispatched[0]).toMatchObject({
      type: "thread.activity.append",
      activity: { kind: "elicitation.submitted", payload: { requestId } },
    });
  });

  it("refuses stale generations, invalid content and already-submitted requests", async () => {
    const stale = harness(pendingInput());
    const staleResult = await run(
      submitElicitation(stale.deps, {
        threadId,
        requestId,
        generation: 2,
        action: "accept",
        content: { token: "x" },
      }),
    );
    expect(staleResult._tag).toBe("Failure");
    expect(stale.responses).toEqual([]);

    const invalid = harness(pendingInput());
    const invalidResult = await run(
      submitElicitation(invalid.deps, {
        threadId,
        requestId,
        generation: 3,
        action: "accept",
        content: { other: SENTINEL },
      }),
    );
    expect(invalidResult._tag).toBe("Failure");
    if (invalidResult._tag === "Failure")
      expect(invalidResult.failure.message).not.toContain(SENTINEL);
    expect(invalid.responses).toEqual([]);

    const submitted = harness(pendingInput({ receipt: "submitted" }));
    const again = await run(
      submitElicitation(submitted.deps, { threadId, requestId, generation: 3, action: "cancel" }),
    );
    expect(again._tag).toBe("Failure");
    expect(submitted.responses).toEqual([]);
  });

  it("serializes concurrent submissions for one request", async () => {
    let release: (() => void) | undefined;
    const { deps, responses } = harness(pendingInput(), () =>
      Effect.callback<"submitted">((resume) => {
        release = () => resume(Effect.succeed("submitted"));
      }),
    );
    const first = run(
      submitElicitation(deps, {
        threadId,
        requestId,
        generation: 3,
        action: "accept",
        content: { token: "a" },
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    const second = await run(
      submitElicitation(deps, { threadId, requestId, generation: 3, action: "decline" }),
    );
    expect(second._tag).toBe("Failure");
    release?.();
    expect((await first)._tag).toBe("Success");
    expect(responses).toHaveLength(1);
  });

  it("only lets an indeterminate request be dismissed, without contacting the provider", async () => {
    const { deps, dispatched, responses } = harness(pendingInput({ receipt: "indeterminate" }));
    const resend = await run(
      submitElicitation(deps, {
        threadId,
        requestId,
        generation: 3,
        action: "accept",
        content: { token: "x" },
      }),
    );
    expect(resend._tag).toBe("Failure");
    const dismissed = await run(
      submitElicitation(deps, { threadId, requestId, generation: 3, action: "cancel" }),
    );
    expect(dismissed._tag).toBe("Success");
    if (dismissed._tag === "Success") expect(dismissed.success).toEqual({ state: "cancelled" });
    expect(responses).toEqual([]);
    expect(dispatched[0]).toMatchObject({
      activity: { kind: "user-input.resolved", payload: { requestId, receipt: "cancelled" } },
    });
  });

  it("settles requests from before a restart with value-free outcomes", async () => {
    const pending = harness(pendingInput());
    await Effect.runPromise(reconcileElicitationsOnStartup(pending.deps.orchestrationEngine));
    expect(pending.dispatched[0]).toMatchObject({
      activity: { payload: { receipt: "cancelled" } },
    });
    const submitted = harness(pendingInput({ receipt: "submitted" }));
    await Effect.runPromise(reconcileElicitationsOnStartup(submitted.deps.orchestrationEngine));
    expect(submitted.dispatched[0]).toMatchObject({
      activity: { payload: { receipt: "indeterminate" } },
    });
  });
});
