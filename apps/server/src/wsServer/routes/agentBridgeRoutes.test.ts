import { AGENT_BRIDGE_WS_METHODS as METHODS } from "@t3tools/contracts";
import { Effect } from "effect";
import { expect, it } from "vitest";
import type { WebSocket } from "ws";

import type { AgentBridgeServiceShape } from "../../agentBridge/AgentBridgeService.ts";
import { agentBridgeRoutes } from "./agentBridgeRoutes.ts";
import { answerFromTable, tableAnswers, type RouteBody } from "./routeTable.ts";

const socket = {} as unknown as WebSocket;
type Name = keyof typeof METHODS;

const makeRoutes = (refuses?: string) => {
  const calls: Array<ReadonlyArray<unknown>> = [];
  const member =
    (name: string) =>
    (...args: ReadonlyArray<unknown>) => {
      calls.push([name, ...args]);
      return refuses === name
        ? Effect.fail({ message: `${name} was refused` })
        : Effect.succeed({ answeredBy: name });
    };
  // The routes pass answers on unread, so the fakes answer with their name.
  const bridge = {
    getState: Effect.suspend(() => member("getState")()),
    setSchedulingGrant: member("setSchedulingGrant"),
    tasks: {
      getTasks: member("getTasks"),
      getTask: member("getTask"),
      getTaskActivities: member("getTaskActivities"),
      createTask: member("createTask"),
      replyToTask: member("replyToTask"),
      controlTask: member("controlTask"),
    },
  } as unknown as AgentBridgeServiceShape;
  const routes = agentBridgeRoutes(bridge);
  // A request reaches the service as it came, so one field stands in for a valid one.
  const answer = (name: Name, fields: Record<string, unknown> = {}) => {
    const body = { _tag: METHODS[name], ...fields } as RouteBody;
    if (!tableAnswers(routes, body)) throw new Error(`${body._tag} is not an Agent Bridge route`);
    return Effect.runPromise(
      answerFromTable(routes, body, socket).pipe(
        Effect.match({ onFailure: (error) => ({ error }), onSuccess: (value) => ({ value }) }),
      ),
    );
  };
  return { calls, answer };
};

const task = { taskId: "task-1" };

it.each<[Name, ReadonlyArray<unknown>]>([
  ["getState", ["getState"]],
  ["setSchedulingGrant", ["setSchedulingGrant", task]],
  ["getTasks", ["getTasks", task]],
  ["getTask", ["getTask", "task-1"]],
  ["getTaskActivities", ["getTaskActivities", task]],
  ["createTask", ["createTask", task]],
  ["replyToTask", ["replyToTask", task]],
  ["pauseTask", ["controlTask", "pause", task]],
  ["resumeTask", ["controlTask", "resume", task]],
  ["cancelTask", ["controlTask", "cancel", task]],
])("%s reaches the service as %j", async (name, call) => {
  const { calls, answer } = makeRoutes();
  await expect(answer(name, task)).resolves.toEqual({ value: { answeredBy: call[0] } });
  expect(calls).toEqual([call]);
});

it.each<[Name, string]>([
  ["setSchedulingGrant", "setSchedulingGrant"],
  ["cancelTask", "controlTask"],
])("answers a refused %s with the service's message", async (name, member) => {
  const { answer } = makeRoutes(member);
  await expect(answer(name, task)).resolves.toMatchObject({
    error: { _tag: "RouteRequestError", message: `${member} was refused` },
  });
});
