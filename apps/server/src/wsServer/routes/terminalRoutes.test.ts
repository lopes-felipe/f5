import { WS_METHODS } from "@t3tools/contracts";
import { Effect } from "effect";
import { expect, it } from "vitest";
import type { WebSocket } from "ws";

import { TerminalError } from "../../terminal/Services/Manager.ts";
import { RouteRequestError } from "../../turnSubmissionErrors.ts";
import { answerFromTable, tableAnswers, type RouteBody } from "./routeTable.ts";
import { terminalRoutes, type TerminalRouteDependencies } from "./terminalRoutes.ts";

const socket = {} as unknown as WebSocket;

const makeRoutes = (options: { fails?: string; refusesThread?: string } = {}) => {
  const calls: Array<ReadonlyArray<unknown>> = [];
  const failure = new TerminalError({ message: "The shell could not start." });
  const member =
    (name: string) =>
    (input: unknown): Effect.Effect<never, TerminalError> =>
      // Suspended, so a call is recorded when the action runs, not when it is built.
      Effect.suspend(() => {
        calls.push([name, input]);
        return options.fails === name
          ? Effect.fail(failure)
          : (Effect.succeed({ answeredBy: name }) as Effect.Effect<never>);
      });
  const terminals: TerminalRouteDependencies<never, RouteRequestError>["terminals"] = {
    snapshot: member("snapshot"),
    open: member("open"),
    write: member("write"),
    resize: member("resize"),
    clear: member("clear"),
    restart: member("restart"),
    close: member("close"),
  };
  const routes = terminalRoutes<never, RouteRequestError>({
    terminals,
    startingShellFor: (threadId, action) =>
      Effect.gen(function* () {
        calls.push(["startingShellFor", threadId]);
        if (options.refusesThread === threadId)
          return yield* new RouteRequestError({ message: "This conversation has been deleted." });
        return yield* action;
      }),
  });
  // A request reaches the manager as it came, so a thread id stands in for a valid one.
  const answer = (method: string, fields: Record<string, unknown> = {}) => {
    const body = { _tag: method, ...fields } as RouteBody;
    if (!tableAnswers(routes, body)) throw new Error(`${method} is not a terminal route`);
    return Effect.runPromise(
      answerFromTable(routes, body, socket).pipe(
        Effect.match({ onFailure: (error) => ({ error }), onSuccess: (value) => ({ value }) }),
      ),
    );
  };
  return { calls, answer, failure };
};

const thread = { threadId: "thread-1" };

it.each([
  [WS_METHODS.terminalSnapshot, "snapshot"],
  [WS_METHODS.terminalWrite, "write"],
  [WS_METHODS.terminalResize, "resize"],
  [WS_METHODS.terminalClear, "clear"],
  [WS_METHODS.terminalClose, "close"],
])("%s goes straight to the manager's %s", async (method, name) => {
  const { calls, answer } = makeRoutes();
  await expect(answer(method, thread)).resolves.toEqual({ value: { answeredBy: name } });
  expect(calls).toEqual([[name, thread]]);
});

it.each([
  [WS_METHODS.terminalOpen, "open"],
  [WS_METHODS.terminalRestart, "restart"],
])("%s starts a shell under the thread's access check", async (method, name) => {
  const { calls, answer } = makeRoutes();
  await expect(answer(method, thread)).resolves.toEqual({ value: { answeredBy: name } });
  expect(calls).toEqual([
    ["startingShellFor", "thread-1"],
    [name, thread],
  ]);
});

it.each([WS_METHODS.terminalOpen, WS_METHODS.terminalRestart])(
  "%s does not start a shell for a thread the server refuses",
  async (method) => {
    const { calls, answer } = makeRoutes({ refusesThread: "thread-1" });
    await expect(answer(method, thread)).resolves.toMatchObject({
      error: { _tag: "RouteRequestError", message: "This conversation has been deleted." },
    });
    expect(calls).toEqual([["startingShellFor", "thread-1"]]);
  },
);

it("passes the manager's own error on, not a route error made from it", async () => {
  for (const [method, name] of [
    [WS_METHODS.terminalWrite, "write"],
    [WS_METHODS.terminalOpen, "open"],
  ] as const) {
    const { answer, failure } = makeRoutes({ fails: name });
    const answered = await answer(method, thread);
    expect((answered as { error: unknown }).error).toBe(failure);
  }
});
