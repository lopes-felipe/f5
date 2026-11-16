import * as Path from "node:path";
import { ProjectId, ThreadId, WORKTREE_SETUP_TAIL_LINES } from "@t3tools/contracts";
import { Deferred, Effect, Fiber, Layer } from "effect";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { GitCore } from "../../git/Services/GitCore.ts";
import { makeFakeGitCore } from "../../git/testDoubles.ts";
import { OrchestrationEngineService } from "../../orchestration/Services/OrchestrationEngine.ts";
import {
  WorktreePreparations,
  type PreparationPhase,
} from "../../persistence/Services/WorktreePreparations.ts";
import {
  automationLayer,
  makeWorld,
  project,
  thread,
} from "../../storage/storageAutomation.testHarness.ts";
import { startOwnedSetupScript } from "../ownedSetupScript.ts";
import { WorktreeSetupGateLive } from "../Services/WorktreeSetupGate.ts";
import { makeWorktreePreparationService } from "./WorktreePreparation.ts";

vi.mock("../ownedSetupScript.ts", () => ({ startOwnedSetupScript: vi.fn() }));
beforeEach(() => {
  vi.mocked(startOwnedSetupScript).mockReset();
});
const projectRoot = Path.resolve("/missing-f5-test");
const input = {
  threadId: ThreadId.makeUnsafe("thread"),
  projectId: ProjectId.makeUnsafe("project"),
  worktreePath: Path.join(projectRoot, "wt"),
  branch: "feature",
};

const fixture = (
  options: {
    async?: boolean;
    phase?: PreparationPhase;
    identity?: string;
    ignoredTruncated?: boolean;
    owner?: string;
    branchExists?: boolean;
    resolvedBase?: string;
  } = {},
) => {
  const world = makeWorld();
  world.projects.push({
    ...project("project", projectRoot),
    scripts: [
      {
        id: "setup",
        name: "Setup",
        command: "new setup",
        icon: "play",
        runOnWorktreeCreate: true,
        ...(options.async !== undefined ? { async: options.async } : {}),
      },
    ],
  });
  world.threads.push(
    thread({
      id: "thread",
      projectId: "project",
      worktreePath: input.worktreePath,
      branch: input.branch,
    }),
  );
  const inspect = vi.fn((path: string) =>
    makeFakeGitCore()
      .service.inspectCheckout(path)
      .pipe(
        Effect.map((status) => ({
          ...status,
          canonicalRoot: input.worktreePath,
          commonDir: Path.join(projectRoot, ".git"),
          branch: input.branch,
          headSha: "base",
          ignoredTruncated: options.ignoredTruncated ?? false,
          registration: {
            path,
            canonicalPath: path,
            branch: input.branch,
            headSha: "base",
            isMain: false,
            detached: false,
            bare: false,
            locked: null,
            prunable: null,
          },
        })),
      ),
  );
  const git = makeFakeGitCore({
    inspectCheckout: inspect,
    initializeWorktreeSubmodules: () => Effect.void,
    branchExists: () => Effect.succeed(options.branchExists ?? false),
    resolveCommit: () => Effect.succeed(options.resolvedBase ?? "base"),
    listWorktrees: () => Effect.succeed([]),
  }).service;
  const activity = vi.fn();
  const killed = vi.fn();
  const run = <A, E>(
    test: (context: {
      service: Effect.Success<typeof makeWorktreePreparationService>;
      receipts: typeof WorktreePreparations.Service;
      exited: Deferred.Deferred<number | null>;
      inspect: typeof inspect;
    }) => Effect.Effect<A, E>,
  ) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const receipts = yield* WorktreePreparations;
        const engine = yield* OrchestrationEngineService;
        const exited = yield* Deferred.make<number | null>();
        vi.mocked(startOwnedSetupScript).mockImplementation(({ onLine }) => {
          for (let i = 0; i < WORKTREE_SETUP_TAIL_LINES + 3; i++) onLine(`diagnostic ${i}`);
          return Effect.succeed({
            exit: Deferred.await(exited),
            kill: Effect.sync(() => {
              killed();
            }).pipe(Effect.andThen(Deferred.succeed(exited, null)), Effect.asVoid),
          });
        });
        const allocated = yield* receipts.allocate({
          operationId: "operation",
          repositoryIdentity: Path.join(projectRoot, ".git"),
          projectIdentity: projectRoot,
          owner: options.owner ?? "thread:thread",
          requestedBase: "main",
          baseOid: "base",
          path: input.worktreePath,
          branch: input.branch,
          namingIntent: "existing",
          setupIdentity: options.identity ?? "new setup",
          runSetupScript: true,
        });
        yield* receipts.update(allocated, {
          phase: options.phase ?? "checkout_created",
          createdCheckout: true,
        });
        const service = yield* makeWorktreePreparationService.pipe(
          Effect.provideService(OrchestrationEngineService, {
            ...engine,
            dispatch: (command) => {
              activity(command);
              return engine.dispatch(command);
            },
          }),
        );
        return yield* test({ service, receipts, exited, inspect });
      }).pipe(
        Effect.provideService(GitCore, git),
        Effect.provide(
          Layer.mergeAll(WorktreeSetupGateLive, automationLayer(world, {}, "f5-preparation-unit-")),
        ),
        Effect.scoped,
      ),
    );
  return { run, activity, killed, world };
};

const waitForPhase = (receipts: typeof WorktreePreparations.Service, phase: PreparationPhase) =>
  Effect.gen(function* () {
    for (let attempt = 0; attempt < 200; attempt++) {
      if ((yield* receipts.latest(input.worktreePath))?.phase === phase) return;
      yield* Effect.sleep("1 millis");
    }
    throw new Error(`Preparation did not reach ${phase}`);
  });

describe("durable thread worktree preparation", () => {
  it("starts default async scripts without waiting, deduplicates subsequent sends, and records completion", async () => {
    const { run, activity } = fixture();
    await run(({ service, receipts, exited, inspect }) =>
      Effect.gen(function* () {
        yield* service.prepare(input);
        expect((yield* receipts.latest(input.worktreePath))?.phase).toBe("setup_running");
        yield* service.prepare(input);
        expect(startOwnedSetupScript).toHaveBeenCalledTimes(1);
        expect(inspect).toHaveBeenCalledTimes(1);
        yield* Deferred.succeed(exited, 0);
        yield* waitForPhase(receipts, "completed");
        yield* service.prepare(input);
        expect(inspect).toHaveBeenCalledTimes(1);
      }),
    );
    expect(activity).toHaveBeenCalledWith(
      expect.objectContaining({
        activity: expect.objectContaining({
          payload: expect.objectContaining({
            outputTail: expect.arrayContaining([`diagnostic ${WORKTREE_SETUP_TAIL_LINES + 2}`]),
          }),
        }),
      }),
    );
  });
  it("kills a spawned async script if persisting its handoff activity fails", async () => {
    const { run, activity, killed } = fixture();
    activity.mockImplementationOnce(() => {
      throw new Error("Activity storage unavailable");
    });
    await run(({ service, receipts }) =>
      Effect.gen(function* () {
        expect((yield* service.prepare(input).pipe(Effect.exit))._tag).toBe("Failure");
        expect(killed).toHaveBeenCalledTimes(1);
        expect((yield* receipts.latest(input.worktreePath))?.phase).toBe("setup_indeterminate");
      }),
    );
  });
  it("waits for scripts with Agent waits enabled and reports failure output without blocking the turn", async () => {
    const { run } = fixture({ async: false });
    await run(({ service, receipts, exited }) =>
      Effect.gen(function* () {
        const preparing = yield* service.prepare(input).pipe(Effect.forkChild);
        yield* waitForPhase(receipts, "setup_running");
        expect(yield* Deferred.isDone(exited)).toBe(false);
        yield* Deferred.succeed(exited, 7);
        yield* Fiber.join(preparing);
        const receipt = (yield* receipts.latest(input.worktreePath))!;
        expect(receipt.phase).toBe("setup_failed");
        expect(receipt.error).toContain("diagnostic");
        expect(JSON.parse(receipt.result!).outputTail).toHaveLength(WORKTREE_SETUP_TAIL_LINES);
      }),
    );
  });
  it("runs blocking recreation setup behind a durable background token and clears it before notifying", async () => {
    const { run, world } = fixture({ async: false });
    let notified = false;
    await run(({ service, receipts, exited }) =>
      Effect.gen(function* () {
        yield* service.startBackground(input, () =>
          Effect.sync(() => {
            expect(world.queueStates.get(input.threadId)?.worktreeBlockToken).toBeNull();
            notified = true;
          }),
        );
        expect(world.queueStates.get(input.threadId)?.worktreeBlockToken).toMatch(/^preparation:/);
        expect(notified).toBe(false);
        yield* Deferred.succeed(exited, 0);
        yield* waitForPhase(receipts, "completed");
        for (let attempt = 0; attempt < 200 && !notified; attempt++)
          yield* Effect.sleep("1 millis");
        expect(notified).toBe(true);
      }),
    );
  });
  it.each(["completed", "skipped"] as const)(
    "does not inspect finished %s receipts",
    async (phase) => {
      await fixture({ phase }).run(({ service, inspect }) =>
        Effect.gen(function* () {
          inspect.mockImplementation(() => Effect.die("Finished preparation must not scan status"));
          yield* service.prepare(input);
          expect(inspect).not.toHaveBeenCalled();
        }),
      );
    },
  );
  it("adopts an edited setup command only on explicit retry", async () => {
    await fixture({ async: false, identity: "old setup" }).run(({ service, receipts, exited }) =>
      Effect.gen(function* () {
        expect((yield* service.prepare(input).pipe(Effect.exit))._tag).toBe("Failure");
        expect(startOwnedSetupScript).not.toHaveBeenCalled();
        yield* Deferred.succeed(exited, 0);
        yield* service.prepare({ ...input, retry: true });
        expect((yield* receipts.latest(input.worktreePath))?.setupIdentity).toBe("new setup");
        expect((yield* receipts.latest(input.worktreePath))?.phase).toBe("completed");
      }),
    );
  });
  it("requires acknowledgment after restart during an async script", async () => {
    await fixture({ phase: "setup_running", async: false }).run(({ service, receipts, exited }) =>
      Effect.gen(function* () {
        yield* service.startup;
        expect((yield* receipts.latest(input.worktreePath))?.phase).toBe("setup_indeterminate");
        expect((yield* service.prepare(input).pipe(Effect.exit))._tag).toBe("Failure");
        yield* Deferred.succeed(exited, 0);
        yield* service.prepare({ ...input, retry: true });
        expect((yield* receipts.latest(input.worktreePath))?.phase).toBe("completed");
      }),
    );
  });
  it("rejects interrupted checkout adoption when ignored inspection was truncated", async () => {
    await fixture({ phase: "allocated", ignoredTruncated: true }).run(({ service }) =>
      Effect.gen(function* () {
        expect((yield* service.prepare({ ...input, retry: true }).pipe(Effect.exit))._tag).toBe(
          "Failure",
        );
        expect(startOwnedSetupScript).not.toHaveBeenCalled();
      }),
    );
  });
  it("reclaims an unused reservation for a surviving idle thread, but retains queued ownership", async () => {
    const { run, world } = fixture({ phase: "allocated" });
    world.queuedThreadIds.add(input.threadId);
    await run(({ service, receipts }) =>
      Effect.gen(function* () {
        const receipt = (yield* receipts.latest(input.worktreePath))!;
        yield* receipts.update(receipt, { createdCheckout: false });
        yield* service.startup;
        expect((yield* receipts.latest(input.worktreePath))?.phase).toBe("allocated");
        world.queuedThreadIds.clear();
        yield* service.startup;
        expect((yield* receipts.latest(input.worktreePath))?.phase).toBe("skipped");
      }),
    );
  });
  it.each(["base", "moved"])(
    "reconciles an unused existing-branch reservation only at its recorded commit (%s)",
    async (resolvedBase) => {
      const { run } = fixture({
        phase: "allocated",
        branchExists: true,
        resolvedBase,
        owner: "pr:pending",
      });
      await run(({ service, receipts }) =>
        Effect.gen(function* () {
          const receipt = (yield* receipts.latest(input.worktreePath))!;
          yield* receipts.update(receipt, { createdCheckout: false });
          yield* service.startup;
          expect((yield* receipts.latest(input.worktreePath))?.phase).toBe(
            resolvedBase === "base" ? "skipped" : "allocated",
          );
        }),
      );
    },
  );
  it.each(["thread:thread", "pr:pending", "workflow:implementation", "raw:pending"])(
    "releases an abandoned %s reservation only when no checkout or branch exists",
    async (owner) => {
      const { run, world } = fixture({ phase: "allocated", owner });
      world.threads.length = 0;
      await run(({ service, receipts }) =>
        Effect.gen(function* () {
          yield* service.startup;
          expect((yield* receipts.latest(input.worktreePath))?.phase).toBe("allocated"); // createdCheckout is proof of a possible partial creation.
          const receipt = (yield* receipts.latest(input.worktreePath))!;
          yield* receipts.update(receipt, { createdCheckout: false });
          yield* service.startup;
          expect((yield* receipts.latest(input.worktreePath))?.phase).toBe("skipped");
        }),
      );
    },
  );
});
