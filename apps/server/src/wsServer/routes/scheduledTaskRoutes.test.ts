import { WS_METHODS } from "@t3tools/contracts";
import { Effect } from "effect";
import { expect, it } from "vitest";
import type { WebSocket } from "ws";

import { userScheduleActor } from "../../scheduledTasks/Service.ts";
import { answerFromTable, tableAnswers, type RouteBody } from "./routeTable.ts";
import { scheduledTaskRoutes, type ScheduledTaskRouteService } from "./scheduledTaskRoutes.ts";

const socket = {} as unknown as WebSocket;

const makeRoutes = (options: { desktopShowsNotifications?: boolean; refuses?: string } = {}) => {
  const calls: Array<ReadonlyArray<unknown>> = [];
  const serviceMethod =
    (name: string) =>
    (...args: ReadonlyArray<unknown>) => {
      calls.push([name, ...args]);
      return options.refuses === name
        ? Effect.fail({ message: `${name} was refused` })
        : Effect.succeed({ answeredBy: name });
    };
  const schedules: ScheduledTaskRouteService = {
    list: serviceMethod("list"),
    get: serviceMethod("get"),
    create: serviceMethod("create"),
    update: serviceMethod("update"),
    delete: serviceMethod("delete"),
    setEnabled: serviceMethod("setEnabled"),
    runNow: serviceMethod("runNow"),
    listRuns: serviceMethod("listRuns"),
    findRunForTurn: serviceMethod("findRunForTurn"),
    resolveRun: serviceMethod("resolveRun"),
    previewSchedule: serviceMethod("previewSchedule"),
    claimNotifications: serviceMethod("claimNotifications"),
    acknowledgeNotifications: serviceMethod("acknowledgeNotifications"),
  };
  const routes = scheduledTaskRoutes({
    schedules,
    desktopShowsNotifications: () => options.desktopShowsNotifications ?? false,
  });
  // The routes hand the request to the service as it came, so what is in it
  // does not matter here: one field stands in for a valid schedule or run.
  const answer = (method: string, fields: Record<string, unknown> = {}) => {
    const body = { _tag: method, ...fields } as RouteBody;
    if (!tableAnswers(routes, body)) throw new Error(`${method} is not a scheduled task route`);
    return Effect.runPromise(
      answerFromTable(routes, body, socket).pipe(
        Effect.match({ onFailure: (error) => ({ error }), onSuccess: (value) => ({ value }) }),
      ),
    );
  };
  return { calls, answer };
};

it.each([
  [WS_METHODS.scheduledTasksList, "list"],
  [WS_METHODS.scheduledTasksGet, "get"],
  [WS_METHODS.scheduledTasksCreate, "create"],
  [WS_METHODS.scheduledTasksUpdate, "update"],
  [WS_METHODS.scheduledTasksDelete, "delete"],
  [WS_METHODS.scheduledTasksSetEnabled, "setEnabled"],
  [WS_METHODS.scheduledTasksRunNow, "runNow"],
  [WS_METHODS.scheduledTasksListRuns, "listRuns"],
  [WS_METHODS.scheduledTasksFindRunForTurn, "findRunForTurn"],
  [WS_METHODS.scheduledTasksResolveRun, "resolveRun"],
])("%s asks the service to %s as the user", async (method, name) => {
  const { calls, answer } = makeRoutes();
  await expect(answer(method, { marker: method })).resolves.toEqual({
    value: { answeredBy: name },
  });
  expect(calls).toEqual([[name, { marker: method }, userScheduleActor]]);
});

it.each([
  [WS_METHODS.scheduledTasksPreviewSchedule, "previewSchedule"],
  [WS_METHODS.scheduledTasksClaimNotifications, "claimNotifications"],
  [WS_METHODS.scheduledTasksAcknowledgeNotifications, "acknowledgeNotifications"],
])("%s asks the service to %s without an actor", async (method, name) => {
  const { calls, answer } = makeRoutes();
  await expect(answer(method, { marker: method })).resolves.toEqual({
    value: { answeredBy: name },
  });
  expect(calls).toEqual([[name, { marker: method }]]);
});

it("claims nothing for a client while the desktop app shows the notifications", async () => {
  const { calls, answer } = makeRoutes({ desktopShowsNotifications: true });
  const before = Date.now();
  const answered = await answer(WS_METHODS.scheduledTasksClaimNotifications, { owner: "web" });
  expect(answered).toEqual({
    value: { notifications: [], leaseExpiresAt: expect.any(String), retryAt: null },
  });
  const { leaseExpiresAt } = (answered as { value: { leaseExpiresAt: string } }).value;
  expect(Date.parse(leaseExpiresAt)).toBeGreaterThanOrEqual(before);
  expect(calls).toEqual([]);
  // Acknowledging is not the desktop app's alone.
  await answer(WS_METHODS.scheduledTasksAcknowledgeNotifications, { owner: "web", ids: [] });
  expect(calls).toEqual([["acknowledgeNotifications", { owner: "web", ids: [] }]]);
});

it("answers a refusal from the service with its message", async () => {
  const { answer } = makeRoutes({ refuses: "runNow" });
  await expect(answer(WS_METHODS.scheduledTasksRunNow)).resolves.toMatchObject({
    error: { _tag: "RouteRequestError", message: "runNow was refused" },
  });
});
