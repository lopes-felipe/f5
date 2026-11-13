import { WS_METHODS } from "@t3tools/contracts";
import { Effect } from "effect";
import { expect, it } from "vitest";
import type { WebSocket } from "ws";

import {
  answerFromTable,
  mergeRouteTables,
  tableAnswers,
  type RouteMethod,
  type RouteTable,
} from "./routeTable.ts";

const ws = {} as WebSocket;

const statusRoutes: RouteTable<typeof WS_METHODS.githubAccountStatus> = {
  [WS_METHODS.githubAccountStatus]: ({ host }) => Effect.succeed(`status of ${host}`),
};
const profileRoutes: RouteTable<typeof WS_METHODS.profilesList> = {
  [WS_METHODS.profilesList]: () => Effect.succeed("profiles"),
};

it("merges tables that own different methods", async () => {
  const merged = mergeRouteTables(statusRoutes, profileRoutes);
  expect(Object.keys(merged).toSorted()).toEqual(
    [WS_METHODS.githubAccountStatus, WS_METHODS.profilesList].toSorted(),
  );
  const body = { _tag: WS_METHODS.githubAccountStatus, host: "github.com" } as const;
  expect(tableAnswers(merged, body)).toBe(true);
  await expect(Effect.runPromise(answerFromTable(merged, body, ws))).resolves.toBe(
    "status of github.com",
  );
});

it("refuses two tables that answer the same method", () => {
  // @ts-expect-error a method both tables own does not compile either
  expect(() => mergeRouteTables(statusRoutes, statusRoutes)).toThrow(
    `Route tables both answer: ${WS_METHODS.githubAccountStatus}`,
  );
  // Tables whose methods are not known statically are caught when they are built.
  const untyped = statusRoutes as RouteTable<RouteMethod>;
  expect(() => mergeRouteTables(untyped as RouteTable<never>, untyped)).toThrow(
    "Route tables both answer",
  );
});
