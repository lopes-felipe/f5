import { ProviderInstanceId, WS_METHODS } from "@t3tools/contracts";
import { Effect } from "effect";
import { expect, it } from "vitest";
import type { WebSocket } from "ws";

import { providerAccountRoutes } from "./providerAccountRoutes.ts";
import { answerFromTable, tableAnswers, type RouteBody } from "./routeTable.ts";

const socket = { name: "the socket that asked" } as unknown as WebSocket;
const instanceId = ProviderInstanceId.make("claude-work");

const makeRoutes = () => {
  const calls: Array<ReadonlyArray<unknown>> = [];
  const routes = providerAccountRoutes({
    start: async (...args) => {
      calls.push(["start", ...args]);
      return { handle: "sign-in-1" };
    },
    input: (...args) => void calls.push(["input", ...args]),
    cancel: async (...args) => void calls.push(["cancel", ...args]),
    status: async () => {
      throw new Error("That provider instance no longer exists.");
    },
  });
  const answer = (body: RouteBody) => {
    if (!tableAnswers(routes, body)) throw new Error(`${body._tag} is not an account route`);
    return Effect.runPromise(
      answerFromTable(routes, body, socket).pipe(
        Effect.match({ onFailure: (error) => ({ error }), onSuccess: (value) => ({ value }) }),
      ),
    );
  };
  return { calls, answer };
};

it("starts a sign-in or a sign-out owned by the socket that asked", async () => {
  const { calls, answer } = makeRoutes();
  await expect(
    answer({ _tag: WS_METHODS.providerAccountLoginStart, instanceId, method: "device-code" }),
  ).resolves.toEqual({ value: { handle: "sign-in-1" } });
  await answer({ _tag: WS_METHODS.providerAccountLogout, instanceId });
  expect(calls).toEqual([
    ["start", instanceId, false, socket, "device-code"],
    ["start", instanceId, true, socket],
  ]);
});

it("types into and cancels a sign-in as the socket that asked", async () => {
  const { calls, answer } = makeRoutes();
  await answer({ _tag: WS_METHODS.providerAccountInput, handle: "sign-in-1", data: "123456\n" });
  await answer({ _tag: WS_METHODS.providerAccountCancel, handle: "sign-in-1" });
  expect(calls).toEqual([
    ["input", "sign-in-1", "123456\n", socket],
    ["cancel", "sign-in-1", socket],
  ]);
});

it("answers a failed status read with its message", async () => {
  const { answer } = makeRoutes();
  const answered = await answer({ _tag: WS_METHODS.providerAccountStatus, instanceId });
  expect(answered).toMatchObject({
    error: { _tag: "RouteRequestError", message: "That provider instance no longer exists." },
  });
});
