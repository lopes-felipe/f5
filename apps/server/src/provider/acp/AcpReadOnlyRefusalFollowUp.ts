import { Effect } from "effect";

/**
 * An agent that ends its turn when a permission request is refused (Antigravity) leaves a
 * read-only workflow stage with no reply: ACP's `reject_once` carries no reason, so the model
 * never learns what was wrong with the command. F5 then tells it, in a follow-up prompt inside
 * the same turn, and asks it to finish.
 */

/** Follow-up prompts sent per turn before the turn is failed instead. */
export const MAX_READ_ONLY_REFUSAL_FOLLOW_UPS = 2;
/** Refusals named in one follow-up; a turn that ends on a refusal rarely has more than one. */
const MAX_REFUSALS_LISTED = 5;
const MAX_REFUSAL_CHARS = 600;

const clip = (text: string) =>
  text.length > MAX_REFUSAL_CHARS ? `${text.slice(0, MAX_REFUSAL_CHARS)}…` : text;

/** What F5 refused since a prompt was sent, and whether the agent wrote anything afterwards. */
export interface ReadOnlyRefusalState {
  /** Each refusal as recorded in the thread: the operation, then the reason in parentheses. */
  readonly refusals: ReadonlyArray<string>;
  readonly repliedSinceRefusal: boolean;
}

/** The follow-up prompt: what was refused and why, and what to do instead. */
export function readOnlyRefusalFollowUpText(refusals: ReadonlyArray<string>): string {
  const listed = refusals.slice(-MAX_REFUSALS_LISTED);
  return [
    refusals.length === 1
      ? "F5 refused this operation, so nothing ran. This stage is read-only:"
      : `F5 refused ${refusals.length} operations, so none of them ran. This stage is read-only:`,
    ...listed.map((refusal) => `- ${clip(refusal)}`),
    "Do not retry them or ask again. The reason in parentheses says what to change: use a command that only reads (see the read-only shell rules in your instructions), or go on without that result. Then finish the stage and give your reply.",
  ].join("\n");
}

/** The turn failure when the agent still gives no reply after the follow-ups. */
export function readOnlyRefusalFailureText(providerLabel: string, refusal: string): string {
  return `${providerLabel} stopped without a reply after F5 refused an operation in this read-only stage: ${clip(refusal)}. F5 explained the refusal ${MAX_READ_ONLY_REFUSAL_FOLLOW_UPS} times and the agent ended on a refused operation again each time.`;
}

/**
 * Sends `first`, then up to MAX_READ_ONLY_REFUSAL_FOLLOW_UPS follow-ups while the agent keeps
 * ending its turn on a refusal without replying. `take` returns what happened since the last
 * prompt was sent and starts a new count; `settle` waits for the events of the prompt that just
 * returned to be applied. Fails with `fail`'s error when the last follow-up ends the same way.
 */
export const promptWithReadOnlyRefusalFollowUps = <Part, Result, E>(input: {
  readonly first: ReadonlyArray<Part>;
  readonly send: (parts: ReadonlyArray<Part>) => Effect.Effect<Result, E>;
  readonly followUp: (text: string) => ReadonlyArray<Part>;
  readonly endedTurn: (result: Result) => boolean;
  readonly settle: Effect.Effect<void>;
  readonly take: () => ReadOnlyRefusalState;
  readonly fail: (lastRefusal: string) => E;
}): Effect.Effect<Result, E> =>
  Effect.gen(function* () {
    input.take();
    let result = yield* input.send(input.first);
    for (let followUps = 0; ; followUps += 1) {
      yield* input.settle;
      const state = input.take();
      const lastRefusal = state.refusals.at(-1);
      if (lastRefusal === undefined || state.repliedSinceRefusal || !input.endedTurn(result))
        return result;
      if (followUps >= MAX_READ_ONLY_REFUSAL_FOLLOW_UPS)
        return yield* Effect.fail(input.fail(lastRefusal));
      result = yield* input.send(input.followUp(readOnlyRefusalFollowUpText(state.refusals)));
    }
  });
