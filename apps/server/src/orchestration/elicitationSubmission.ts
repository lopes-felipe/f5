/**
 * Private delivery of provider form/URL answers ("elicitations").
 *
 * Answers never use the event-sourced user-input command: values live only in
 * this request's memory and in the provider adapter's native response. What
 * is persisted is a value-free receipt trail on the thread:
 *
 *   pending        the `user-input.requested` activity (descriptor only)
 *   submitted      `elicitation.submitted`, once the provider transport took it
 *   resolved       `user-input.resolved` + receipt, on correlated native completion
 *   cancelled      `user-input.resolved` + receipt (declined, cancelled, restart)
 *   indeterminate  transport lost after submit; never resent, the user dismisses
 *
 * @module elicitationSubmission
 */
import {
  ApprovalRequestId,
  CommandId,
  EventId,
  type ElicitationSubmitInput,
  type ElicitationSubmitResult,
  type OrchestrationReadModel,
  type ThreadId,
  type TurnId,
} from "@t3tools/contracts";
import { validateElicitationContent } from "@t3tools/shared/elicitationForm";
import { ELICITATION_SUBMITTED_ACTIVITY_KIND } from "@t3tools/shared/pendingUserInputs";
import { Effect, Schema } from "effect";

import type { ProviderServiceShape } from "../provider/Services/ProviderService.ts";
import type { OrchestrationEngineShape } from "./Services/OrchestrationEngine.ts";

export class ElicitationSubmitError extends Schema.TaggedErrorClass<ElicitationSubmitError>()(
  "ElicitationSubmitError",
  { message: Schema.String },
) {}

export interface ElicitationSubmissionDeps {
  readonly orchestrationEngine: Pick<OrchestrationEngineShape, "getReadModel" | "dispatch">;
  readonly providerService: Pick<ProviderServiceShape, "respondToElicitation">;
  /** Request ids with a submission in flight; one per process. */
  readonly inFlight: Set<string>;
}

const refuse = (message: string) => Effect.fail(new ElicitationSubmitError({ message }));

function findPending(readModel: OrchestrationReadModel, threadId: ThreadId, requestId: string) {
  const thread = readModel.threads.find((candidate) => candidate.id === threadId);
  if (!thread || thread.deletedAt) return { thread: undefined, pending: undefined } as const;
  return {
    thread,
    pending: thread.pendingUserInputs?.find((input) => input.requestId === requestId),
  } as const;
}

/** Appends one value-free receipt activity to the thread. */
export const recordElicitationReceipt = (
  orchestrationEngine: Pick<OrchestrationEngineShape, "dispatch">,
  input: {
    readonly threadId: ThreadId;
    readonly requestId: ApprovalRequestId;
    readonly turnId: TurnId | null;
    readonly kind: "submitted" | "cancelled" | "indeterminate";
    readonly reason?: string;
  },
) =>
  Effect.gen(function* () {
    const createdAt = new Date().toISOString();
    const key = `elicitation:${input.kind}:${input.requestId}`;
    yield* orchestrationEngine.dispatch({
      type: "thread.activity.append",
      commandId: CommandId.makeUnsafe(`server:${key}`),
      threadId: input.threadId,
      activity: {
        id: EventId.makeUnsafe(key),
        createdAt,
        tone: input.kind === "indeterminate" ? "error" : "info",
        kind:
          input.kind === "submitted" ? ELICITATION_SUBMITTED_ACTIVITY_KIND : "user-input.resolved",
        summary:
          input.kind === "submitted"
            ? "Input sent to the provider"
            : input.kind === "cancelled"
              ? (input.reason ?? "Input request cancelled")
              : (input.reason ?? "Input delivery could not be confirmed"),
        payload:
          input.kind === "submitted"
            ? { requestId: input.requestId }
            : { requestId: input.requestId, receipt: input.kind },
        turnId: input.turnId,
      },
      createdAt,
    });
  });

export const submitElicitation = (
  deps: ElicitationSubmissionDeps,
  input: ElicitationSubmitInput,
): Effect.Effect<ElicitationSubmitResult, ElicitationSubmitError> =>
  Effect.gen(function* () {
    // Serialize per request: a second click or tab cannot race the first.
    if (deps.inFlight.has(input.requestId))
      return yield* refuse("This answer is already being sent.");
    deps.inFlight.add(input.requestId);
    return yield* Effect.gen(function* () {
      const readModel = yield* deps.orchestrationEngine.getReadModel();
      const { thread, pending } = findPending(readModel, input.threadId, input.requestId);
      if (!thread) return yield* refuse("This conversation no longer exists.");
      if (!pending?.elicitation)
        return yield* refuse("This request was already answered or is no longer open.");
      const descriptor = pending.elicitation;
      const record = (kind: "submitted" | "cancelled" | "indeterminate", reason?: string) =>
        recordElicitationReceipt(deps.orchestrationEngine, {
          threadId: thread.id,
          requestId: pending.requestId,
          turnId: pending.turnId,
          kind,
          ...(reason ? { reason } : {}),
        }).pipe(Effect.orDie);

      if (pending.receipt === "indeterminate") {
        // The provider may or may not have the earlier answer; never resend.
        if (input.action !== "cancel")
          return yield* refuse(
            "F5 could not confirm the earlier answer and will not send it again. Dismiss this request.",
          );
        yield* record("cancelled", "Dismissed after an unconfirmed delivery");
        return { state: "cancelled" as const };
      }
      if (pending.receipt === "submitted")
        return yield* refuse("This answer was already sent; waiting for the provider.");
      if (descriptor.generation === undefined || descriptor.generation !== input.generation)
        return yield* refuse(
          "This request belongs to an earlier provider session and can no longer be answered.",
        );
      if (input.action === "accept" && descriptor.mode === "form") {
        const validated = validateElicitationContent(descriptor.fields ?? [], input.content);
        if (!validated.ok) return yield* refuse(validated.reason);
      } else if (input.content !== undefined && Object.keys(input.content).length > 0) {
        return yield* refuse("This response does not take form values.");
      }

      yield* deps.providerService.respondToElicitation(input).pipe(
        // Provider errors name the request and the failure, never the values.
        Effect.mapError(
          (error) =>
            new ElicitationSubmitError({
              message:
                "detail" in error && typeof error.detail === "string"
                  ? error.detail
                  : "issue" in error && typeof error.issue === "string"
                    ? error.issue
                    : "The provider did not accept the answer.",
            }),
        ),
      );
      yield* record("submitted");
      return { state: "submitted" as const };
    }).pipe(Effect.ensuring(Effect.sync(() => deps.inFlight.delete(input.requestId))));
  });

/**
 * Server start: no provider session from before the restart survives, so
 * unanswered requests are cancelled and sent-but-unconfirmed answers become
 * indeterminate. Both outcomes are value-free.
 */
export const reconcileElicitationsOnStartup = (
  orchestrationEngine: Pick<OrchestrationEngineShape, "getReadModel" | "dispatch">,
) =>
  Effect.gen(function* () {
    const readModel = yield* orchestrationEngine.getReadModel();
    for (const thread of readModel.threads) {
      for (const pending of thread.pendingUserInputs ?? []) {
        if (!pending.elicitation || pending.receipt === "indeterminate") continue;
        yield* recordElicitationReceipt(orchestrationEngine, {
          threadId: thread.id,
          requestId: pending.requestId,
          turnId: pending.turnId,
          kind: pending.receipt === "submitted" ? "indeterminate" : "cancelled",
          reason:
            pending.receipt === "submitted"
              ? "F5 restarted before the provider confirmed this answer"
              : "Cancelled because F5 restarted",
        });
      }
    }
  });
