import { Cause, Data, Effect, Exit } from "effect";
import { expect, it } from "vitest";

import { TerminalError } from "../terminal/Services/Manager.ts";
import { routeFailureMessage } from "./routeFailureMessage.ts";

class Unnamed extends Data.TaggedError("WorktreeBusy")<{ readonly path: string }> {}

const causeOf = async <E>(effect: Effect.Effect<never, E>): Promise<Cause.Cause<E>> => {
  const exit = await Effect.runPromiseExit(effect);
  if (!Exit.isFailure(exit)) throw new Error("expected a failure");
  return exit.cause;
};

it("gives a typed failure's message and none of its stack", async () => {
  const cause = await causeOf(
    Effect.fail(new TerminalError({ message: "Unknown terminal thread: thread-1" })),
  );
  // What the client was sent before: the same text, then where it was raised.
  expect(Cause.pretty(cause)).toMatch(/^Error: Unknown terminal thread: thread-1\n\s+at /);
  expect(routeFailureMessage(cause)).toBe("Unknown terminal thread: thread-1");
});

it("gives a defect's message and none of its stack", async () => {
  const cause = await causeOf(Effect.die(new TypeError("Cannot read properties of undefined")));
  expect(routeFailureMessage(cause)).toBe("Cannot read properties of undefined");
  expect(routeFailureMessage(await causeOf(Effect.die("boom")))).toBe("boom");
});

it("names an error that has no message, and says so when it has neither", async () => {
  expect(routeFailureMessage(await causeOf(Effect.fail(new Unnamed({ path: "/repo" }))))).toBe(
    "WorktreeBusy",
  );
  expect(routeFailureMessage(await causeOf(Effect.fail(new Error(""))))).toBe(
    "The request failed.",
  );
});

it("keeps a message that spans lines, and says when a request was interrupted", async () => {
  const cause = await causeOf(Effect.fail(new Error("git failed:\nfatal: not a git repository")));
  expect(routeFailureMessage(cause)).toBe("git failed:\nfatal: not a git repository");
  expect(routeFailureMessage(await causeOf(Effect.interrupt))).toBe(
    "The request was interrupted before it finished.",
  );
});
