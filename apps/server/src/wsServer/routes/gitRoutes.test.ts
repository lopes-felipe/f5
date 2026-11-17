import { WS_METHODS } from "@t3tools/contracts";
import { Effect } from "effect";
import { expect, it } from "vitest";
import type { WebSocket } from "ws";

import { GitWorkspaceSwitch } from "../../git/workspaceSwitch.ts";
import { RouteRequestError } from "../../turnSubmissionErrors.ts";
import { gitRoutes, type GitRouteDependencies } from "./gitRoutes.ts";
import { answerFromTable, tableAnswers, type RouteBody } from "./routeTable.ts";

const socket = { socket: "the client that asked" } as unknown as WebSocket;

interface Options {
  /** The member, by name, that fails. */
  readonly fails?: string;
  readonly serverStarting?: boolean;
  readonly projects?: ReadonlyArray<{
    readonly id: string;
    readonly workspaceRoot: string;
    readonly scripts: ReadonlyArray<{ command: string; runOnWorktreeCreate: boolean }>;
  }>;
  readonly removal?: { removed: boolean; blockedReasons: ReadonlyArray<string> };
}

const makeRoutes = (options: Options = {}) => {
  const calls: Array<ReadonlyArray<unknown>> = [];
  const failure = new Error("git said no");
  const member =
    (name: string, result: unknown = { answeredBy: name }) =>
    (...input: ReadonlyArray<unknown>) =>
      // Suspended, so a call is recorded when the action runs, not when it is built.
      Effect.suspend(() => {
        calls.push([name, ...input]);
        return options.fails === name ? Effect.fail(failure) : Effect.succeed(result);
      });
  // The manager's workflows reach the workspace switch through the service the route provides.
  const switching =
    (name: string) =>
    (...input: ReadonlyArray<unknown>) =>
      Effect.gen(function* () {
        const handler = yield* GitWorkspaceSwitch;
        if (handler) yield* handler({ cwd: "/repo", branch: "feature", create: true });
        return yield* member(name)(...input);
      });
  const dependencies = {
    git: {
      pullCurrentBranch: member("pullCurrentBranch"),
      listBranches: member("listBranches"),
      createBranch: member("createBranch"),
      initRepo: member("initRepo"),
      allocateWorktreePath: member("allocateWorktreePath", "/worktrees/allocated"),
    },
    gitManager: {
      status: member("status"),
      resolvePullRequest: member("resolvePullRequest"),
      preparePullRequestThread: switching("preparePullRequestThread"),
      runStackedAction: switching("runStackedAction"),
    },
    switchWorkspace: (threadId: unknown, operationId: unknown) => (input: unknown) =>
      member("switchWorkspace")(threadId, operationId, input),
    publishActionProgress: (ws: unknown, event: { kind: string }) =>
      Effect.sync(() => {
        expect(ws).toBe(socket);
        calls.push(["progress", event]);
      }),
    createWorktree: member("createWorktree"),
    prepareWorktree: member("prepareWorktree"),
    runtime: Effect.suspend(() =>
      options.serverStarting
        ? Effect.fail(new RouteRequestError({ message: "The server is still starting." }))
        : Effect.succeed({
            liveProjects: Effect.succeed(options.projects ?? []),
            worktrees: {
              inspect: member("inspect", { headSha: "abc123" }),
              remove: member("remove", options.removal ?? { removed: true, blockedReasons: [] }),
            },
          }),
    ),
  } as unknown as GitRouteDependencies;
  const routes = gitRoutes(dependencies);
  // A request reaches Git as it came, so plain strings stand in for validated ids and paths.
  const answer = (method: string, fields: Record<string, unknown> = {}) => {
    const body = { _tag: method, ...fields } as RouteBody;
    if (!tableAnswers(routes, body)) throw new Error(`${method} is not a Git route`);
    return Effect.runPromise(
      answerFromTable(routes, body, socket).pipe(
        Effect.match({ onFailure: (error) => ({ error }), onSuccess: (value) => ({ value }) }),
      ),
    );
  };
  return { calls, answer, failure };
};

const repo = { cwd: "/repo" };

it.each([
  [WS_METHODS.gitStatus, "status"],
  [WS_METHODS.gitResolvePullRequest, "resolvePullRequest"],
  [WS_METHODS.gitListBranches, "listBranches"],
  [WS_METHODS.gitCreateBranch, "createBranch"],
  [WS_METHODS.gitInit, "initRepo"],
])("%s passes the request to %s and its failure back unchanged", async (method, name) => {
  const { calls, answer } = makeRoutes();
  await expect(answer(method, repo)).resolves.toEqual({ value: { answeredBy: name } });
  expect(calls).toEqual([[name, repo]]);

  const failing = makeRoutes({ fails: name });
  await expect(failing.answer(method, repo)).resolves.toEqual({ error: failing.failure });
});

it("pulls the branch checked out in the request's directory", async () => {
  const { calls, answer } = makeRoutes();
  await answer(WS_METHODS.gitPull, { cwd: "/repo", ignored: true });
  expect(calls).toEqual([["pullCurrentBranch", "/repo"]]);
});

it("checks a branch out through the thread's workspace switch, never creating it", async () => {
  const { calls, answer } = makeRoutes();
  await answer(WS_METHODS.gitCheckout, {
    cwd: "/repo",
    branch: "main",
    threadId: "thread-1",
    operationId: "operation-1",
  });
  expect(calls).toEqual([
    ["switchWorkspace", "thread-1", "operation-1", { cwd: "/repo", branch: "main", create: false }],
  ]);

  // The failure is the one `formatRouteFailure` inspects for a checkout conflict.
  const failing = makeRoutes({ fails: "switchWorkspace" });
  await expect(failing.answer(WS_METHODS.gitCheckout, repo)).resolves.toEqual({
    error: failing.failure,
  });
});

it("lets a pull request thread switch the workspace of the thread it prepares", async () => {
  const { calls, answer } = makeRoutes();
  const request = { cwd: "/repo", reference: "42", mode: "local", threadId: "thread-1" };
  await answer(WS_METHODS.gitPreparePullRequestThread, request);
  expect(calls).toEqual([
    ["switchWorkspace", "thread-1", undefined, { cwd: "/repo", branch: "feature", create: true }],
    ["preparePullRequestThread", request],
  ]);
});

const action = { cwd: "/repo", action: "commit_push", threadId: "thread-1", actionId: "action-1" };
const progress = { actionId: "action-1", cwd: "/repo", action: "commit_push" };

it("reports a stacked action's start and result to the client that asked", async () => {
  const { calls, answer } = makeRoutes();
  await expect(answer(WS_METHODS.gitRunStackedAction, action)).resolves.toEqual({
    value: { answeredBy: "runStackedAction" },
  });
  expect(calls).toEqual([
    [
      "progress",
      { ...progress, kind: "action_started", phases: ["branch", "commit", "push", "pr"] },
    ],
    // Branch switches made by the action are tracked under the action's id.
    [
      "switchWorkspace",
      "thread-1",
      "git-action:action-1",
      { cwd: "/repo", branch: "feature", create: true },
    ],
    ["runStackedAction", action, expect.objectContaining({ actionId: "action-1" })],
    [
      "progress",
      { ...progress, kind: "action_finished", result: { answeredBy: "runStackedAction" } },
    ],
  ]);
});

it("reports a failed stacked action and still fails the request", async () => {
  const { calls, answer, failure } = makeRoutes({ fails: "runStackedAction" });
  await expect(answer(WS_METHODS.gitRunStackedAction, action)).resolves.toEqual({
    error: failure,
  });
  expect(calls.at(-1)).toEqual([
    "progress",
    { ...progress, kind: "action_failed", phase: null, message: "git said no" },
  ]);
});

it("names a stacked action that came without an id", async () => {
  const { calls, answer } = makeRoutes();
  await answer(WS_METHODS.gitRunStackedAction, { cwd: "/repo", action: "commit" });
  const started = calls[0]![1] as { actionId: string };
  expect(started.actionId).toMatch(/^[0-9a-f-]{36}$/);
  expect(calls.at(-1)![1]).toMatchObject({ actionId: started.actionId, kind: "action_finished" });
});

it("allocates a worktree path for the new branch only when none was given", async () => {
  const allocating = makeRoutes();
  const request = { cwd: "/repo", branch: "main", newBranch: "feature" };
  await allocating.answer(WS_METHODS.gitCreateWorktree, request);
  expect(allocating.calls).toEqual([
    ["allocateWorktreePath", { cwd: "/repo", branch: "feature" }],
    ["createWorktree", { ...request, path: "/worktrees/allocated" }],
  ]);

  const given = makeRoutes();
  await given.answer(WS_METHODS.gitCreateWorktree, { ...request, path: "/worktrees/mine" });
  expect(given.calls).toEqual([["createWorktree", { ...request, path: "/worktrees/mine" }]]);
});

const prepare = { cwd: "/repo", projectCwd: "/repo", branch: "main", newBranch: "feature" };
const project = (scripts: ReadonlyArray<{ command: string; runOnWorktreeCreate: boolean }>) => ({
  id: "project-1",
  workspaceRoot: "/repo/",
  scripts,
});

it("runs the project's setup script when preparing a worktree, unless told not to", async () => {
  const projects = [
    { id: "other", workspaceRoot: "/elsewhere", scripts: [] },
    project([
      { command: "bun lint", runOnWorktreeCreate: false },
      { command: "bun install", runOnWorktreeCreate: true },
    ]),
  ];
  const withSetup = makeRoutes({ projects });
  await withSetup.answer(WS_METHODS.gitPrepareWorktree, prepare);
  expect(withSetup.calls).toEqual([
    ["prepareWorktree", { ...prepare, runSetupScript: true, setupIdentity: "bun install" }],
  ]);

  const declined = makeRoutes({ projects });
  await declined.answer(WS_METHODS.gitPrepareWorktree, { ...prepare, runSetupScript: false });
  expect(declined.calls).toEqual([
    ["prepareWorktree", { ...prepare, runSetupScript: false, setupIdentity: "bun install" }],
  ]);
});

it("prepares a worktree without setup when the project has no setup script", async () => {
  for (const projects of [[project([{ command: "bun lint", runOnWorktreeCreate: false }])], []]) {
    const { calls, answer } = makeRoutes({ projects });
    await answer(WS_METHODS.gitPrepareWorktree, prepare);
    expect(calls).toEqual([
      ["prepareWorktree", { ...prepare, runSetupScript: false, setupIdentity: null }],
    ]);
  }
});

it.each([WS_METHODS.gitPrepareWorktree, WS_METHODS.gitRemoveWorktree])(
  "%s answers that the server is starting before it touches anything",
  async (method) => {
    const { calls, answer } = makeRoutes({ serverStarting: true });
    await expect(answer(method, { ...prepare, path: "/worktrees/feature" })).resolves.toEqual({
      error: new RouteRequestError({ message: "The server is still starting." }),
    });
    expect(calls).toEqual([]);
  },
);

const removal = { cwd: "/repo", path: "/worktrees/feature" };

it("removes a worktree at the head it was inspected at and keeps its branch", async () => {
  const { calls, answer } = makeRoutes({ projects: [project([])] });
  await expect(answer(WS_METHODS.gitRemoveWorktree, removal)).resolves.toEqual({
    value: undefined,
  });
  expect(calls).toEqual([
    ["inspect", { projectId: "project-1", path: "/worktrees/feature" }],
    [
      "remove",
      {
        projectId: "project-1",
        path: "/worktrees/feature",
        deleteBranch: false,
        expectedHead: "abc123",
      },
    ],
  ]);
});

it("refuses to remove a worktree of a directory that is not a project", async () => {
  const { calls, answer } = makeRoutes({ projects: [project([])] });
  await expect(
    answer(WS_METHODS.gitRemoveWorktree, { ...removal, cwd: "/not-a-project" }),
  ).resolves.toEqual({ error: new RouteRequestError({ message: "Unknown project" }) });
  expect(calls).toEqual([]);
});

it.each(["inspect", "remove"])(
  "answers with the worktree manager's message when %s fails",
  async (name) => {
    const { answer } = makeRoutes({ projects: [project([])], fails: name });
    await expect(answer(WS_METHODS.gitRemoveWorktree, removal)).resolves.toEqual({
      error: new RouteRequestError({ message: "git said no" }),
    });
  },
);

it.each([
  [["A turn is running", "It has unpushed commits"], "A turn is running; It has unpushed commits"],
  [[], "Worktree was not removed."],
])("says why a worktree was not removed: %j", async (blockedReasons, message) => {
  const { answer } = makeRoutes({
    projects: [project([])],
    removal: { removed: false, blockedReasons },
  });
  await expect(answer(WS_METHODS.gitRemoveWorktree, removal)).resolves.toEqual({
    error: new RouteRequestError({ message }),
  });
});
