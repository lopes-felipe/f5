import { UPSTREAM_PORTS_WS_METHODS as METHODS } from "@t3tools/contracts";
import { Effect } from "effect";
import { expect, it } from "vitest";
import type { WebSocket } from "ws";

import { UpstreamPortsError } from "../../upstreamPorts/service.ts";
import { answerFromTable, tableAnswers, type RouteBody } from "./routeTable.ts";
import { upstreamPortRoutes, type UpstreamPortRouteService } from "./upstreamPortRoutes.ts";

const socket = {} as unknown as WebSocket;
type Name = keyof typeof METHODS;

const makeService = (refuses?: Name) => {
  const calls: Array<ReadonlyArray<unknown>> = [];
  const answerAs = (name: Name) =>
    refuses === name
      ? Effect.fail(new UpstreamPortsError({ code: "read-only", message: `${name} was refused` }))
      : Effect.succeed({ answeredBy: name });
  const member =
    (name: Name) =>
    (...args: ReadonlyArray<unknown>) => {
      calls.push([name, ...args]);
      return answerAs(name);
    };
  const service: UpstreamPortRouteService = {
    listProjects: Effect.suspend(() => {
      calls.push(["listProjects"]);
      return answerAs("listProjects");
    }),
    getOverview: member("getOverview"),
    listTopics: member("listTopics"),
    listTopicIds: member("listTopicIds"),
    getTopic: member("getTopic"),
    getTopicFiles: member("getTopicFiles"),
    decide: member("decide"),
    acceptSuggestions: member("acceptSuggestions"),
    undoDecisions: member("undoDecisions"),
    expireBacklog: member("expireBacklog"),
    run: member("run"),
    startPort: member("startPort"),
    previewPortGroups: member("previewPortGroups"),
    enqueuePort: member("enqueuePort"),
    getPortQueue: member("getPortQueue"),
    dequeuePort: member("dequeuePort"),
    controlPortQueue: member("controlPortQueue"),
    unlinkPort: member("unlinkPort"),
    retryPortReview: member("retryPortReview"),
    getPortPrompt: member("getPortPrompt"),
    resolvePublication: member("resolvePublication"),
    addRemote: member("addRemote"),
    takeOverWriter: member("takeOverWriter"),
  };
  return { calls, service };
};

// The routes hand the request to the service as it came, so what is in it
// does not matter here: a project id and a marker stand in for a valid one.
const answerFrom = (
  service: UpstreamPortRouteService | null,
  name: Name,
  fields: Record<string, unknown> = {},
) => {
  const routes = upstreamPortRoutes(service);
  const body = { _tag: METHODS[name], ...fields } as RouteBody;
  if (!tableAnswers(routes, body)) throw new Error(`${body._tag} is not an Upstream Ports route`);
  return Effect.runPromise(
    answerFromTable(routes, body, socket).pipe(
      Effect.match({ onFailure: (error) => ({ error }), onSuccess: (value) => ({ value }) }),
    ),
  );
};

const names = Object.keys(METHODS) as ReadonlyArray<Name>;
const byProject: ReadonlyArray<Name> = ["getOverview", "addRemote", "takeOverWriter"];

it.each(names)("%s is answered by the service member of the same name", async (name) => {
  const { calls, service } = makeService();
  const fields = { projectId: "project-1", marker: name };
  await expect(answerFrom(service, name, fields)).resolves.toEqual({
    value: { answeredBy: name },
  });
  expect(calls).toEqual([
    name === "listProjects"
      ? [name]
      : byProject.includes(name)
        ? [name, "project-1"]
        : [name, fields],
  ]);
});

it("answers a refusal with the service's message and code", async () => {
  const { service } = makeService("decide");
  await expect(answerFrom(service, "decide")).resolves.toMatchObject({
    error: { _tag: "RouteRequestError", message: "decide was refused", code: "read-only" },
  });
  const failingList = makeService("listProjects");
  await expect(answerFrom(failingList.service, "listProjects")).resolves.toMatchObject({
    error: { message: "listProjects was refused", code: "read-only" },
  });
});

it.each(names)("%s is refused on a server without Upstream Ports", async (name) => {
  const answered = await answerFrom(null, name, { projectId: "project-1" });
  expect(answered).toMatchObject({
    error: { _tag: "RouteRequestError", message: "Upstream Ports is unavailable." },
  });
  expect((answered as { error: { code?: string } }).error.code).toBeUndefined();
});
