import { WS_METHODS } from "@t3tools/contracts";
import { Effect } from "effect";
import { expect, it } from "vitest";
import type { WebSocket } from "ws";

import { githubAccountRoutes, type GithubAccountRouteDependencies } from "./githubAccountRoutes.ts";
import { answerFromTable, tableAnswers, type RouteBody } from "./routeTable.ts";

const ws = {} as WebSocket;

/** The routes over fakes that record the order of what they were asked to do. */
const makeRoutes = (overrides: Partial<GithubAccountRouteDependencies["account"]> = {}) => {
  const calls: Array<string> = [];
  const routes = githubAccountRoutes({
    login: {
      start: async () => ({ available: true, state: "pending", handle: "attempt-1" }),
      status: (handle) => ({ available: true, state: handle ? "pending" : "idle" }),
      cancel: (handle) => void calls.push(`login.cancel(${handle ?? ""})`),
    },
    account: {
      set: async (host, token) => {
        calls.push(`account.set(${host},${token})`);
        return { login: "octocat" };
      },
      remove: async (host) => void calls.push(`account.remove(${host})`),
      status: async () => ({ login: "octocat" }),
      ...overrides,
    },
    cliImport: {
      candidates: async () => ({ ghAvailable: true, accounts: [] }),
      import: async ({ host, login }) => {
        calls.push(`cli.import(${host},${login})`);
        return { login, missingScopes: [] };
      },
    },
  });
  const answer = (body: RouteBody) => {
    if (!tableAnswers(routes, body)) throw new Error(`${body._tag} is not a GitHub account route`);
    return answerFromTable(routes, body, ws);
  };
  return { routes, calls, answer };
};

it("answers the GitHub account methods and leaves every other method to the caller", () => {
  const { routes } = makeRoutes();
  expect(Object.keys(routes).toSorted()).toEqual(
    [
      WS_METHODS.githubLoginStart,
      WS_METHODS.githubLoginStatus,
      WS_METHODS.githubLoginCancel,
      WS_METHODS.githubAccountSet,
      WS_METHODS.githubAccountRemove,
      WS_METHODS.githubAccountStatus,
      WS_METHODS.githubAccountCliCandidates,
      WS_METHODS.githubAccountCliImport,
    ].toSorted(),
  );
  expect(tableAnswers(routes, { _tag: WS_METHODS.githubAccountStatus, host: "github.com" })).toBe(
    true,
  );
  expect(tableAnswers(routes, { _tag: WS_METHODS.profilesList })).toBe(false);
});

it("cancels the browser sign-in before another change to the github.com account", async () => {
  const { calls, answer } = makeRoutes();
  await expect(
    Effect.runPromise(
      answer({ _tag: WS_METHODS.githubAccountSet, host: "github.com", token: "token-1" }),
    ),
  ).resolves.toEqual({ login: "octocat" });
  await Effect.runPromise(answer({ _tag: WS_METHODS.githubAccountRemove, host: "github.com" }));
  await Effect.runPromise(
    answer({ _tag: WS_METHODS.githubAccountCliImport, host: "github.com", login: "octocat" }),
  );
  expect(calls).toEqual([
    "login.cancel()",
    "account.set(github.com,token-1)",
    "login.cancel()",
    "account.remove(github.com)",
    "login.cancel()",
    "cli.import(github.com,octocat)",
  ]);
});

it("leaves the browser sign-in alone for other hosts", async () => {
  const { calls, answer } = makeRoutes();
  await Effect.runPromise(
    answer({ _tag: WS_METHODS.githubAccountSet, host: "ghe.example.com", token: "token-2" }),
  );
  await Effect.runPromise(
    answer({ _tag: WS_METHODS.githubAccountRemove, host: "ghe.example.com" }),
  );
  expect(calls).toEqual([
    "account.set(ghe.example.com,token-2)",
    "account.remove(ghe.example.com)",
  ]);
});

it("passes the sign-in handle through to status and cancel", async () => {
  const { calls, answer } = makeRoutes();
  await expect(
    Effect.runPromise(answer({ _tag: WS_METHODS.githubLoginStatus, handle: "attempt-1" })),
  ).resolves.toEqual({ available: true, state: "pending" });
  await Effect.runPromise(answer({ _tag: WS_METHODS.githubLoginCancel, handle: "attempt-1" }));
  expect(calls).toEqual(["login.cancel(attempt-1)"]);
});

it("turns a rejected operation into the route's error message", async () => {
  const { answer } = makeRoutes({
    status: async () => {
      throw new Error("GitHub did not accept this token.");
    },
  });
  const failure = await Effect.runPromise(
    answer({ _tag: WS_METHODS.githubAccountStatus, host: "github.com" }).pipe(
      Effect.match({ onFailure: (error) => error, onSuccess: () => null }),
    ),
  );
  expect(failure?._tag).toBe("RouteRequestError");
  expect(failure?.message).toBe("GitHub did not accept this token.");
});
