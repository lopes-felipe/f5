import { Effect } from "effect";

/**
 * An agent that ends its turn when a permission request is refused (Antigravity) leaves a
 * read-only workflow stage with no reply: ACP's `reject_once` carries no reason, so the model
 * never learns what was wrong with the command. F5 then tells it, in a follow-up prompt inside
 * the same turn, and asks it to finish.
 */

/**
 * Follow-ups that may go unheeded before the turn is failed instead. A follow-up went unheeded
 * when the agent ended its next prompt on operations F5 had already explained.
 */
export const MAX_READ_ONLY_REFUSAL_FOLLOW_UPS = 2;
/**
 * Follow-ups sent in one turn, however different the refused operations are. The stage's own
 * limit of refused operations in a turn (`ProviderRuntimeIngestion`) is reached first.
 */
export const MAX_READ_ONLY_REFUSAL_FOLLOW_UPS_PER_TURN = 15;
/** Refusals named in one follow-up; a turn that ends on a refusal rarely has more than one. */
const MAX_REFUSALS_LISTED = 5;
const MAX_REFUSAL_CHARS = 600;

const clip = (text: string) =>
  text.length > MAX_REFUSAL_CHARS ? `${text.slice(0, MAX_REFUSAL_CHARS)}…` : text;

/** One refused operation: what was asked, as recorded in the thread, and why F5 refused it. */
export interface ReadOnlyRefusal {
  /** The command or tool call. It can carry anything the model wrote, a credential included. */
  readonly operation: string | undefined;
  /** F5's own reason. It names programs, flags and variables, never their values. */
  readonly reason: string;
}

/** A refusal as the thread shows it: the operation, then the reason in parentheses. */
export const readOnlyRefusalText = (refusal: ReadOnlyRefusal) =>
  refusal.operation ? `${refusal.operation} (${refusal.reason})` : refusal.reason;

/** What F5 refused since a prompt was sent, and whether the agent wrote anything afterwards. */
export interface ReadOnlyRefusalState {
  readonly refusals: ReadonlyArray<ReadOnlyRefusal>;
  readonly repliedSinceRefusal: boolean;
}

/** The follow-up prompt: what was refused and why, and what to do instead. */
export function readOnlyRefusalFollowUpText(refusals: ReadonlyArray<ReadOnlyRefusal>): string {
  const listed = refusals.slice(-MAX_REFUSALS_LISTED);
  return [
    refusals.length === 1
      ? "F5 refused this operation, so nothing ran. This stage is read-only:"
      : `F5 refused ${refusals.length} operations, so none of them ran. This stage is read-only:`,
    // Each part is cut on its own: a long command must not push the reason out of the text.
    ...listed.map(
      (refusal) =>
        `- ${readOnlyRefusalText({
          operation: refusal.operation === undefined ? undefined : clip(refusal.operation),
          reason: clip(refusal.reason),
        })}`,
    ),
    "Do not retry them or ask again. The reason in parentheses says what to change: use a command that only reads (see the Read-Only Shell Rules sent with this stage's request), or go on without that result. Then finish the stage and give your reply.",
  ].join("\n");
}

/**
 * The turn failure when the agent still gives no reply after the follow-ups. It carries F5's
 * reason and not the refused operation: the error reaches the server log, which the model's own
 * command text must stay out of. The thread's activity has the operation.
 */
export function readOnlyRefusalFailureText(providerLabel: string, reason: string): string {
  return `${providerLabel} stopped without a reply after F5 refused an operation in this read-only stage (${clip(reason)}). F5 explained its refusals and the agent ended its turn on a refused operation again. The thread's activity lists the refused operations.`;
}

/**
 * Sends `first`, then a follow-up each time the agent ends its turn on a refusal without
 * replying. An agent that answers a follow-up by trying a different operation gets the next
 * refusal explained too; one that ends on operations F5 already explained has not heeded it,
 * and after MAX_READ_ONLY_REFUSAL_FOLLOW_UPS of those the turn fails with `fail`'s error.
 *
 * `take` returns what happened since the last prompt was sent and starts a new count; `settle`
 * waits for the events of the prompt that just returned to be applied.
 */
export const promptWithReadOnlyRefusalFollowUps = <Part, Result, E>(input: {
  readonly first: ReadonlyArray<Part>;
  readonly send: (parts: ReadonlyArray<Part>) => Effect.Effect<Result, E>;
  readonly followUp: (text: string) => ReadonlyArray<Part>;
  readonly endedTurn: (result: Result) => boolean;
  readonly settle: Effect.Effect<void>;
  readonly take: () => ReadOnlyRefusalState;
  readonly fail: (lastReason: string) => E;
}): Effect.Effect<Result, E> =>
  Effect.gen(function* () {
    input.take();
    let result = yield* input.send(input.first);
    const explained = new Set<string>();
    let unheeded = 0;
    for (let followUps = 0; ; followUps += 1) {
      yield* input.settle;
      const state = input.take();
      const last = state.refusals.at(-1);
      if (last === undefined || state.repliedSinceRefusal || !input.endedTurn(result))
        return result;
      const refused = state.refusals.map(readOnlyRefusalText);
      unheeded = refused.every((refusal) => explained.has(refusal)) ? unheeded + 1 : 0;
      if (
        unheeded >= MAX_READ_ONLY_REFUSAL_FOLLOW_UPS ||
        followUps >= MAX_READ_ONLY_REFUSAL_FOLLOW_UPS_PER_TURN
      )
        return yield* Effect.fail(input.fail(last.reason));
      for (const refusal of refused) explained.add(refusal);
      result = yield* input.send(input.followUp(readOnlyRefusalFollowUpText(state.refusals)));
    }
  });
