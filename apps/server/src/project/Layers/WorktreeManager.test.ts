import { fallbackDefaultProfile } from "@t3tools/shared/profileIdentity";
import { profileStateDir } from "@t3tools/shared/profilePaths";
import * as fs from "node:fs/promises";
import { WorktreePreparations } from "../../persistence/Services/WorktreePreparations.ts";
import { WorktreePreparation } from "../Services/WorktreePreparation.ts";
import { makeWorktreePreparationService } from "./WorktreePreparation.ts";
import { OrchestrationEngineService } from "../../orchestration/Services/OrchestrationEngine.ts";
import { ProviderService } from "../../provider/Services/ProviderService.ts";
import { NextTurnQueueStore } from "../../nextTurnQueue/Services/NextTurnQueueStore.ts";
import { NextTurnQueueStorageError } from "../../nextTurnQueue/Errors.ts";
import type { OrchestrationCommand } from "@t3tools/contracts";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Effect } from "effect";
import { ProjectId, ProfileId, ThreadId } from "@t3tools/contracts";
import { ServerConfig } from "../../config.ts";
import { NextTurnQueueDispatcher } from "../../nextTurnQueue/Services/NextTurnQueueDispatcher.ts";
import {
  automationLayer,
  makeWorld,
  makeClonedRepo,
  git,
  project,
  thread,
} from "../../storage/storageAutomation.testHarness.ts";
import { GitCore, type GitCoreShape } from "../../git/Services/GitCore.ts";
import { WorktreeSetupGate, WorktreeSetupGateLive } from "../Services/WorktreeSetupGate.ts";
import { makeWorktreeManager } from "./WorktreeManager.ts";
import { holdsWorktreeLifecycleLock } from "./WorktreeLifecycleCoordinator.ts";

describe("WorktreeManager safety and recovery", { timeout: 60_000 }, () => {
  const cleanups: Array<() => Promise<unknown>> = [];
  afterEach(async () => {
    for (const cleanup of cleanups.splice(0)) await cleanup();
  });
  async function fixture() {
    const repo = await makeClonedRepo("f5-manager-");
    cleanups.push(repo.cleanup);
    const world = makeWorld();
    world.projects.push(project("p", repo.root));
    const projectId = ProjectId.makeUnsafe("p");
    const notified: string[] = [];
    const run = <A, E>(
      effect: (
        manager: Effect.Success<typeof makeWorktreeManager>,
        root: string,
        gate: typeof WorktreeSetupGate.Service,
      ) => Effect.Effect<A, E, GitCore | WorktreePreparations | ServerConfig>,
      overrides: Partial<GitCoreShape> = {},
      hooks: {
        beforeStop?: () => Effect.Effect<void>;
        onDispatch?: (command: OrchestrationCommand) => void;
        failTokenClear?: () => boolean;
      } = {},
    ) =>
      Effect.runPromise(
        Effect.gen(function* () {
          const originalGit = yield* GitCore;
          const providers = yield* ProviderService;
          const engine = yield* OrchestrationEngineService;
          const queue = yield* NextTurnQueueStore;
          const preparation = yield* makeWorktreePreparationService.pipe(
            Effect.provideService(GitCore, { ...originalGit, ...overrides }),
          );
          const manager = yield* makeWorktreeManager.pipe(
            Effect.provideService(WorktreePreparation, preparation),
            Effect.provideService(ProviderService, {
              ...providers,
              stopSession: (input) =>
                (hooks.beforeStop?.() ?? Effect.void).pipe(
                  Effect.andThen(providers.stopSession(input)),
                ),
            }),
            Effect.provideService(OrchestrationEngineService, {
              ...engine,
              dispatch: (command) =>
                engine
                  .dispatch(command)
                  .pipe(Effect.tap(() => Effect.sync(() => hooks.onDispatch?.(command)))),
            }),
            Effect.provideService(NextTurnQueueStore, {
              ...queue,
              setWorktreeBlockToken: (input) =>
                input.token === null && hooks.failTokenClear?.()
                  ? Effect.fail(
                      new NextTurnQueueStorageError({
                        message: "interrupted token clear",
                      }),
                    )
                  : queue.setWorktreeBlockToken(input),
            }),
            Effect.provideService(GitCore, { ...originalGit, ...overrides }),
          );
          const config = yield* ServerConfig;
          yield* Effect.promise(async () => {
            await fs.mkdir(config.profilesRoot!, { recursive: true });
            await fs.writeFile(
              path.join(config.profilesRoot!, "profiles.json"),
              JSON.stringify({ version: 1, retiredPorts: [], profiles: [config.profile] }),
            );
          });
          return yield* effect(manager, config.worktreesDir, yield* WorktreeSetupGate);
        }).pipe(
          Effect.provide(WorktreeSetupGateLive),
          Effect.provideService(NextTurnQueueDispatcher, {
            notify: (id: string) =>
              Effect.sync(() => {
                notified.push(id);
              }),
            setWorkspaceRestorer: () => Effect.void,
          } as never),
          Effect.provide(automationLayer(world, {}, "f5-manager-state-")),
          Effect.scoped,
        ),
      );
    return { repo, world, projectId, run, notified };
  }
  it("lists project, referenced, unreferenced, missing and external checkouts without changing files", async () => {
    const { repo, world, projectId, run } = await fixture();
    await run((manager, root) =>
      Effect.gen(function* () {
        const target = path.join(
          root,
          process.platform === "win32" ? "referenced space" : "referenced ",
        );
        const unused = path.join(root, "unused");
        const missing = path.join(root, "recorded-only");
        const external = path.join(repo.dir, "external");
        git(repo.root, "worktree", "add", "-q", "-b", "referenced", target, "main");
        git(repo.root, "worktree", "add", "-q", "-b", "unused", unused, "main");
        git(repo.root, "worktree", "add", "-q", "-b", "external", external, "main");
        yield* Effect.promise(() => fs.writeFile(path.join(target, "local.txt"), "keep me"));
        world.threads.push(
          thread({ id: "local", projectId, branch: "main", worktreePath: null }),
          {
            ...thread({ id: "linked", projectId, branch: "referenced", worktreePath: target }),
            archivedAt: new Date().toISOString(),
          },
          thread({ id: "missing", projectId, branch: "missing", worktreePath: missing }),
          thread({
            id: "deleted",
            projectId,
            branch: "unused",
            worktreePath: unused,
            deletedAt: new Date().toISOString(),
          }),
        );
        const result = yield* manager.list({ projectId });
        const entries = result.projects[0]!.entries;
        expect(result.projects[0]!.error).toBeNull();
        expect(entries[0]).toMatchObject({
          classification: "projectCheckout",
          path: repo.root,
          hasChanges: false,
          linkedThreads: [{ threadId: "local" }],
        });
        expect(entries.find((e) => e.branch === "referenced")).toMatchObject({
          classification: "managed",
          hasChanges: true,
          linkedThreads: [{ threadId: "linked", archived: true }],
        });
        expect(entries.find((e) => e.path === missing)).toMatchObject({
          registration: null,
          missing: true,
          hasChanges: null,
          branch: "missing",
        });
        expect(entries.find((e) => e.path === external)?.classification).toBe("external");
        expect(entries.find((e) => e.branch === "unused")?.linkedThreads).toEqual([]);
        const referencedEnd = entries.findIndex((e) => e.linkedThreads.length === 0);
        expect(entries.slice(referencedEnd).every((e) => e.linkedThreads.length === 0)).toBe(true);
        expect(
          yield* Effect.promise(() => fs.readFile(path.join(target, "local.txt"), "utf8")),
        ).toBe("keep me");
      }),
    );
  });
  it("reports nested project folders without fabricating an attachable checkout", async () => {
    const { repo, world, projectId, run } = await fixture();
    const nested = path.join(repo.root, "subproject");
    await fs.mkdir(nested);
    world.projects[0] = project("p", nested);
    world.threads.push(thread({ id: "nested", projectId, branch: null, worktreePath: null }));
    await run((manager) =>
      Effect.gen(function* () {
        const result = yield* manager.list({ projectId });
        expect(result.projects[0]!.entries).toEqual([]);
        expect(result.projects[0]!.error).toContain(`checkout root: ${repo.root}`);
      }),
    );
  });

  it("isolates project failures, skips non-Git/deleted projects, and reports unknown dirty status", async () => {
    const { repo, world, projectId, run } = await fixture();
    world.projects.push(
      project("missing", path.join(repo.dir, "absent")),
      project("plain", repo.dir),
      { ...project("deleted", repo.root), deletedAt: new Date().toISOString() },
    );
    await run(
      (manager) =>
        Effect.gen(function* () {
          const result = yield* manager.list({});
          expect(result.projects.map((p) => p.projectId)).toEqual([projectId, "missing"]);
          expect(result.projects[0]!.entries[0]!.hasChanges).toBeNull();
          expect(result.projects[1]!.error).toBeTruthy();
          expect((yield* manager.list({ projectId })).projects).toHaveLength(1);
        }),
      { isDirty: () => Effect.succeed(null) },
    );
  });

  it("bounds dirty inspections to four across all projects in a request", async () => {
    const { repo, world, run } = await fixture();
    world.projects.push(project("alias", repo.root));
    let active = 0;
    let peak = 0;
    await run(
      (manager, root) =>
        Effect.gen(function* () {
          for (let i = 0; i < 6; i++)
            git(
              repo.root,
              "worktree",
              "add",
              "-q",
              "-b",
              `parallel-${i}`,
              path.join(root, `parallel-${i}`),
              "main",
            );
          const result = yield* manager.list({});
          expect(result.projects).toHaveLength(2);
          expect(result.projects.every((p) => p.error === null)).toBe(true);
          expect(peak).toBe(4);
          expect(active).toBe(0);
        }),
      {
        isDirty: () =>
          Effect.gen(function* () {
            active++;
            peak = Math.max(peak, active);
            yield* Effect.sleep("10 millis");
            active--;
            return false;
          }),
      },
    );
  });

  it("classifies other profiles and preserves locked and detached registrations for inspection", async () => {
    const { repo, projectId, run } = await fixture();
    await run((manager, root) =>
      Effect.gen(function* () {
        const config = yield* ServerConfig;
        const current = fallbackDefaultProfile(config.defaultStateDir!);
        const other = {
          ...current,
          id: ProfileId.makeUnsafe("a".repeat(32)),
          slug: "other",
          name: "Other",
          isDefault: false,
          port: current.port + 1,
        };
        yield* Effect.promise(() =>
          fs.writeFile(
            path.join(config.profilesRoot!, "profiles.json"),
            JSON.stringify({ version: 1, retiredPorts: [], profiles: [config.profile, other] }),
          ),
        );
        const otherPath = path.join(
          profileStateDir(config.defaultStateDir!, other),
          "worktrees",
          "other",
        );
        const lockedPath = path.join(root, "locked");
        const detachedPath = path.join(root, "detached");
        git(repo.root, "worktree", "add", "-q", "-b", "other", otherPath, "main");
        git(repo.root, "worktree", "add", "-q", "-b", "locked", lockedPath, "main");
        git(repo.root, "worktree", "lock", "--reason", "keep this registration", lockedPath);
        git(repo.root, "worktree", "add", "-q", "--detach", detachedPath, "main");
        const entries = (yield* manager.list({ projectId })).projects[0]!.entries;
        expect(entries.find((e) => e.branch === "other")?.classification).toBe("otherProfile");
        expect(entries.find((e) => e.branch === "locked")).toMatchObject({
          locked: true,
          registration: { locked: "keep this registration" },
        });
        expect(entries.find((e) => e.branch === null)).toMatchObject({
          detached: true,
          classification: "managed",
        });
      }),
    );
  });

  it("rechecks HEAD and claims, then deletes only an unreferenced merged branch", async () => {
    const { repo, world, projectId, run } = await fixture();
    await run((manager, root) =>
      Effect.gen(function* () {
        const target = path.join(root, "feature");
        git(repo.root, "worktree", "add", "-q", "-b", "feature", target, "main");
        const preview = yield* manager.inspect({ projectId, path: target });
        expect(preview.branchMerged).toBe(true);
        expect(preview.branchDeletable).toBe(true);
        expect(
          (yield* manager.remove({
            projectId,
            path: target,
            deleteBranch: true,
            expectedHead: "wrong",
          })).removed,
        ).toBe(false);
        world.threads.push(
          thread({ id: "linked", projectId, worktreePath: target, branch: "feature" }),
        );
        world.queuedThreadIds.add("linked");
        expect(
          (yield* manager.remove({
            projectId,
            path: target,
            deleteBranch: true,
            expectedHead: preview.headSha,
          })).removed,
        ).toBe(false);
        world.queuedThreadIds.clear();
        const kept = yield* manager.remove({
          projectId,
          path: target,
          deleteBranch: true,
          expectedHead: preview.headSha,
        });
        expect(kept.removed).toBe(true);
        expect(kept.branchDeleted).toBe(false);
        expect(world.threads[0]?.worktreePath).toBe(target);
        git(repo.root, "worktree", "add", "-q", "-b", "unlinked", target, "main");
        world.threads.length = 0;
        const fresh = yield* manager.inspect({ projectId, path: target });
        expect(
          yield* manager.remove({
            projectId,
            path: target,
            deleteBranch: true,
            expectedHead: fresh.headSha,
          }),
        ).toEqual({ removed: true, branchDeleted: true, blockedReasons: [] });
      }),
    );
  });
  it("lists every ignored path and removes only after explicit approval while keeping the branch", async () => {
    const { repo, projectId, run } = await fixture();
    await run((manager, root) =>
      Effect.gen(function* () {
        const target = path.join(root, "ignored-review");
        git(repo.root, "worktree", "add", "-q", "-b", "ignored-review", target, "main");
        git(target, "config", "core.excludesFile", path.join(repo.root, "no-global-ignore"));
        yield* Effect.promise(() =>
          fs.writeFile(
            path.join(target, ".gitignore"),
            "dist/\n.env\n.cache/\nnode_modules/\nsecret.txt\n",
          ),
        );
        git(target, "add", ".gitignore");
        git(target, "commit", "-qm", "Ignore local content");
        for (const directory of ["dist", ".cache", "node_modules"]) {
          yield* Effect.promise(() => fs.mkdir(path.join(target, directory)));
          yield* Effect.promise(() =>
            fs.writeFile(path.join(target, directory, "local"), "local content"),
          );
        }
        yield* Effect.promise(() => fs.writeFile(path.join(target, ".env"), "local config"));
        yield* Effect.promise(() => fs.writeFile(path.join(target, "secret.txt"), "local content"));
        const preview = yield* manager.inspect({ projectId, path: target });
        expect(preview.ignoredFiles?.entries.toSorted()).toEqual([
          ".cache/",
          ".env",
          "dist/",
          "node_modules/",
          "secret.txt",
        ]);
        expect(preview.ignoredFiles?.truncated).toBe(false);
        expect(preview.ignoredFiles?.requiresApproval).toBe(true);
        expect(preview.ignoredFiles?.canRemoveAfterApproval).toBe(true);
        expect(preview.blockedReasons).toHaveLength(1);
        const input = {
          projectId,
          path: target,
          deleteBranch: false,
          expectedHead: preview.headSha,
        };
        expect((yield* manager.remove(input)).removed).toBe(false);
        expect(
          (yield* manager.remove({ ...input, approvedIgnoredEntries: ["dist/"] })).removed,
        ).toBe(false);
        expect(
          yield* manager.remove({
            ...input,
            approvedIgnoredEntries: preview.ignoredFiles!.entries,
          }),
        ).toEqual({ removed: true, branchDeleted: false, blockedReasons: [] });
        expect(git(repo.root, "rev-parse", "refs/heads/ignored-review")).toBe(preview.headSha);
      }),
    );
  });

  describe("removal without asking", () => {
    /** A worktree whose ignore rules cover build output and local configuration. */
    const makeWorktree = (repoRoot: string, root: string, branch: string) =>
      Effect.promise(async () => {
        const target = path.join(root, branch);
        git(repoRoot, "worktree", "add", "-q", "-b", branch, target, "main");
        git(target, "config", "core.excludesFile", path.join(repoRoot, "no-global-ignore"));
        await fs.writeFile(path.join(target, ".gitignore"), "node_modules/\ndist/\n.env\n");
        git(target, "add", ".gitignore");
        git(target, "commit", "-qm", "Ignore local content");
        return target;
      });
    const build = (target: string) =>
      Effect.promise(async () => {
        for (const directory of ["node_modules", "dist"]) {
          await fs.mkdir(path.join(target, directory));
          await fs.writeFile(path.join(target, directory, "output"), "rebuilt by a build");
        }
      });

    it("removes a clean worktree whose only ignored content is build output, and keeps the branch", async () => {
      const { repo, world, projectId, run } = await fixture();
      await run((manager, root) =>
        Effect.gen(function* () {
          const target = yield* makeWorktree(repo.root, root, "built");
          yield* build(target);
          // The thread that used it is deleted; nobody else does.
          world.threads.push(
            thread({
              id: "gone",
              projectId,
              worktreePath: target,
              branch: "built",
              deletedAt: "2026-11-27T00:00:00.000Z",
            }),
          );
          const preview = yield* manager.inspect({ projectId, path: target });
          expect(preview.ignoredFiles?.entries.toSorted()).toEqual(["dist/", "node_modules/"]);
          expect(preview.ignoredFiles?.disposableOnly).toBe(true);
          expect(preview.safeToRemoveSilently).toBe(true);
          expect(
            yield* manager.remove({
              projectId,
              path: target,
              deleteBranch: false,
              expectedHead: preview.headSha,
              disposableIgnoredOnly: true,
            }),
          ).toEqual({ removed: true, branchDeleted: false, blockedReasons: [] });
          expect(yield* Effect.promise(() => fs.stat(target).catch(() => null))).toBeNull();
          expect(git(repo.root, "rev-parse", "refs/heads/built")).toBe(preview.headSha);
        }),
      );
    });

    it("asks when a file a build does not bring back is ignored, and refuses to remove it unnamed", async () => {
      const { repo, projectId, run } = await fixture();
      await run((manager, root) =>
        Effect.gen(function* () {
          const target = yield* makeWorktree(repo.root, root, "configured");
          yield* build(target);
          yield* Effect.promise(() => fs.writeFile(path.join(target, ".env"), "TOKEN=local"));
          const preview = yield* manager.inspect({ projectId, path: target });
          expect(preview.ignoredFiles?.disposableOnly).toBe(false);
          expect(preview.safeToRemoveSilently).toBe(false);
          // A client that asks anyway is refused, under the same check.
          const refused = yield* manager.remove({
            projectId,
            path: target,
            deleteBranch: false,
            expectedHead: preview.headSha,
            disposableIgnoredOnly: true,
          });
          expect(refused.removed).toBe(false);
          expect(refused.blockedReasons.join(" ")).toContain(".env");
          expect(yield* Effect.promise(() => fs.readFile(path.join(target, ".env"), "utf8"))).toBe(
            "TOKEN=local",
          );
        }),
      );
    });

    it("asks about a dirty tree and about a worktree another thread still uses", async () => {
      const { repo, world, projectId, run } = await fixture();
      await run((manager, root) =>
        Effect.gen(function* () {
          const dirty = yield* makeWorktree(repo.root, root, "dirty");
          yield* Effect.promise(() => fs.writeFile(path.join(dirty, "notes.txt"), "not committed"));
          const dirtyPreview = yield* manager.inspect({ projectId, path: dirty });
          expect(dirtyPreview.safeToRemoveSilently).toBe(false);
          expect(
            (yield* manager.remove({
              projectId,
              path: dirty,
              deleteBranch: false,
              expectedHead: dirtyPreview.headSha,
              disposableIgnoredOnly: true,
            })).removed,
          ).toBe(false);

          const shared = yield* makeWorktree(repo.root, root, "shared");
          expect((yield* manager.inspect({ projectId, path: shared })).safeToRemoveSilently).toBe(
            true,
          );
          world.threads.push(
            thread({ id: "other", projectId, worktreePath: shared, branch: "shared" }),
          );
          expect((yield* manager.inspect({ projectId, path: shared })).safeToRemoveSilently).toBe(
            false,
          );
        }),
      );
    });

    it("refuses when a file that is not build output appears after the check", async () => {
      const { repo, projectId, run } = await fixture();
      let realCore: GitCoreShape;
      let target = "";
      let probes = 0;
      await run(
        (manager, root) =>
          Effect.gen(function* () {
            realCore = yield* GitCore;
            target = yield* makeWorktree(repo.root, root, "raced");
            yield* build(target);
            const preview = yield* manager.inspect({ projectId, path: target });
            expect(preview.safeToRemoveSilently).toBe(true);
            probes = 0;
            const result = yield* manager.remove({
              projectId,
              path: target,
              deleteBranch: false,
              expectedHead: preview.headSha,
              disposableIgnoredOnly: true,
            });
            expect(result.removed).toBe(false);
            expect(
              yield* Effect.promise(() => fs.readFile(path.join(target, ".env"), "utf8")),
            ).toBe("late");
          }),
        {
          // The file lands after both unlocked previews, just before the check
          // that runs under the locks.
          inspectCheckout: (cwd, options) =>
            Effect.gen(function* () {
              if (cwd === target && ++probes === 3)
                yield* Effect.promise(() => fs.writeFile(path.join(target, ".env"), "late"));
              return yield* realCore.inspectCheckout(cwd, options);
            }),
        },
      );
    });
  });

  it("blocks removal when the ignored-file listing is incomplete even with approval", async () => {
    const { repo, projectId, run } = await fixture();
    let realCore: GitCoreShape;
    await run(
      (manager, root) =>
        Effect.gen(function* () {
          realCore = yield* GitCore;
          const target = path.join(root, "ignored-incomplete");
          git(repo.root, "worktree", "add", "-q", "-b", "ignored-incomplete", target, "main");
          const preview = yield* manager.inspect({ projectId, path: target });
          expect(preview.ignoredFiles?.truncated).toBe(true);
          expect(
            (yield* manager.remove({
              projectId,
              path: target,
              deleteBranch: false,
              expectedHead: preview.headSha,
              approvedIgnoredEntries: [".env"],
            })).removed,
          ).toBe(false);
          expect((yield* Effect.promise(() => fs.stat(target))).isDirectory()).toBe(true);
        }),
      {
        inspectCheckout: (cwd, options) =>
          realCore.inspectCheckout(cwd, options).pipe(
            Effect.map((inspection) => ({
              ...inspection,
              ignoredEntries: [".env"],
              ignoredTruncated: true,
            })),
          ),
      },
    );
  });

  it("retains new ignored paths that appear during locked revalidation", async () => {
    const { repo, projectId, run } = await fixture();
    let realCore: GitCoreShape;
    let injected = false;
    await run(
      (manager, root) =>
        Effect.gen(function* () {
          realCore = yield* GitCore;
          const target = path.join(root, "ignored-race");
          git(repo.root, "worktree", "add", "-q", "-b", "ignored-race", target, "main");
          yield* Effect.promise(() =>
            fs.writeFile(path.join(target, ".gitignore"), ".env\n.env.local\n"),
          );
          git(target, "add", ".gitignore");
          git(target, "commit", "-qm", "Ignore config");
          yield* Effect.promise(() => fs.writeFile(path.join(target, ".env"), "original"));
          const preview = yield* manager.inspect({ projectId, path: target });
          const result = yield* manager.remove({
            projectId,
            path: target,
            deleteBranch: false,
            expectedHead: preview.headSha,
            approvedIgnoredEntries: preview.ignoredFiles!.entries,
          });
          expect(result.removed).toBe(false);
          expect(result.blockedReasons.join(" ")).toContain("Ignored files changed since review");
          expect(
            yield* Effect.promise(() => fs.readFile(path.join(target, ".env.local"), "utf8")),
          ).toBe("new local config");
        }),
      {
        inspectCheckout: (cwd, options) =>
          Effect.gen(function* () {
            if (!injected && (yield* holdsWorktreeLifecycleLock(cwd).pipe(Effect.orDie))) {
              injected = true;
              yield* Effect.promise(() =>
                fs.writeFile(path.join(cwd, ".env.local"), "new local config"),
              );
            }
            return yield* realCore.inspectCheckout(cwd, options);
          }),
      },
    );
  });

  it("stops deleted owners but retains unmerged commits when the upstream is gone", async () => {
    const { repo, world, projectId, run } = await fixture();
    await run((manager, root) =>
      Effect.gen(function* () {
        const target = path.join(root, "upstream-gone");
        git(repo.root, "worktree", "add", "-q", "-b", "upstream-gone", target, "main");
        git(target, "commit", "--allow-empty", "-qm", "unique commit");
        git(target, "config", "branch.upstream-gone.remote", "origin");
        git(target, "config", "branch.upstream-gone.merge", "refs/heads/deleted-upstream");
        world.threads.push(
          thread({
            id: "deleted",
            projectId,
            worktreePath: null,
            deletedAt: new Date().toISOString(),
          }),
        );
        world.sessions.push({ threadId: "deleted", cwd: target, status: "ready" });
        world.terminals.push({
          threadId: "deleted",
          terminalId: "shell",
          cwd: target,
          status: "running",
        });
        const preview = yield* manager.inspect({ projectId, path: target });
        expect(preview.branchMerged).toBe(false);
        expect(preview.branchUpstreamGone).toBe(true);
        expect(preview.branchDeletable).toBe(false);
        expect(preview.deletedThreadClaims).toContain("deleted");
        expect(
          yield* manager.remove({
            projectId,
            path: target,
            deleteBranch: true,
            expectedHead: preview.headSha,
          }),
        ).toMatchObject({ removed: true, branchDeleted: false });
        expect(git(repo.root, "rev-parse", "refs/heads/upstream-gone")).toBe(preview.headSha);
        expect(world.sessions).toEqual([]);
        expect(world.terminals).toEqual([]);
      }),
    );
  });
  it("does not claim an equal branch name in a different repository", async () => {
    const { repo, world, projectId, run } = await fixture();
    const other = await makeClonedRepo("f5-manager-other-");
    cleanups.push(other.cleanup);
    world.projects.push(project("other", other.root));
    world.threads.push(
      thread({ id: "other", projectId: "other", branch: "feature", worktreePath: null }),
    );
    await run((manager, root) =>
      Effect.gen(function* () {
        const target = path.join(root, "feature");
        git(repo.root, "worktree", "add", "-q", "-b", "feature", target, "main");
        expect((yield* manager.inspect({ projectId, path: target })).branchDeletable).toBe(true);
        world.projects.push(project("alias", repo.root));
        world.threads.push(
          thread({ id: "same-repo", projectId: "alias", branch: "feature", worktreePath: null }),
        );
        expect((yield* manager.inspect({ projectId, path: target })).branchDeletable).toBe(false);
      }),
    );
  });

  it("reports a worktree as intact on another branch or a detached HEAD", async () => {
    const { repo, world, run } = await fixture();
    const threadId = ThreadId.makeUnsafe("moved-branch");
    await run((manager, root) =>
      Effect.gen(function* () {
        const target = path.join(root, "moved-branch");
        git(repo.root, "worktree", "add", "-q", "-b", "recorded", target, "main");
        world.threads.push(
          thread({ id: threadId, projectId: "p", branch: "recorded", worktreePath: target }),
        );
        const intact = { kind: "ready", location: "worktree", path: target, branch: "recorded" };
        git(target, "checkout", "-q", "-b", "agent-branch");
        expect(yield* manager.threadState({ threadId })).toEqual(intact);
        git(target, "checkout", "-q", "--detach");
        expect(yield* manager.threadState({ threadId })).toEqual(intact);
      }),
    );
  });

  it("reports what a thread's workspace needs, from Git and the queue", async () => {
    const { repo, world, run } = await fixture();
    const threadId = ThreadId.makeUnsafe("status");
    const local = ThreadId.makeUnsafe("status-local");
    await run((manager, root) =>
      Effect.gen(function* () {
        const target = path.join(root, "status");
        git(repo.root, "worktree", "add", "-q", "-b", "topic", target, "main");
        world.threads.push(
          thread({ id: threadId, projectId: "p", branch: "topic", worktreePath: target }),
          thread({ id: local, projectId: "p", branch: "main", worktreePath: null }),
        );
        const status = () => manager.threadState({ threadId });
        expect(yield* manager.threadState({ threadId: local })).toEqual({
          kind: "ready",
          location: "projectFolder",
          path: repo.root,
          branch: "main",
        });

        // Cleaned up: nothing to do until the next message, which restores it.
        git(repo.root, "worktree", "remove", "--force", target);
        expect(yield* status()).toEqual({ kind: "dormant", path: target, branch: "topic" });

        // A send that stopped on it already tried: now it is the user's.
        world.queueStates.set(threadId, {
          revision: 1,
          paused: true,
          pauseReasonCode: "worktree_missing",
          pauseDetail: "Git could not add the worktree.",
          worktreeBlockToken: null,
        });
        expect(yield* status()).toEqual({
          kind: "attention",
          reason: "restore_failed",
          message: "Git could not add the worktree.",
          actions: ["retry", "useProjectFolder"],
        });
        world.queueStates.delete(threadId);

        // Git allows one checkout per branch.
        git(repo.root, "checkout", "-q", "topic");
        expect(yield* status()).toEqual({
          kind: "attention",
          reason: "branch_in_use",
          message:
            "topic is checked out in the project folder, so this thread's worktree cannot be restored on it.",
          actions: ["attach", "newWorktree"],
        });
        git(repo.root, "checkout", "-q", "main");

        // The branch is gone too: it starts again from the default branch.
        git(repo.root, "branch", "-q", "-D", "topic");
        expect(yield* status()).toEqual({ kind: "dormant", path: target, branch: "topic" });

        // Something else took the folder; it is left alone and the thread moves.
        yield* Effect.promise(() => fs.mkdir(target, { recursive: true }));
        expect(yield* status()).toEqual({ kind: "dormant", path: target, branch: "topic" });

        // A first-send setup that failed holds its message.
        world.queueStates.set(threadId, {
          revision: 2,
          paused: true,
          pauseReasonCode: "worktree_setup_failed",
          pauseDetail: "The setup script exited with 1.",
          worktreeBlockToken: null,
        });
        expect(yield* status()).toEqual({
          kind: "attention",
          reason: "setup_failed",
          message: "The setup script exited with 1.",
          actions: ["retry", "useProjectFolder", "discard"],
        });
      }),
    );
  });

  it("requires the durable transition service for recovery and keeps queue pauses intact", async () => {
    const { world, run } = await fixture();
    const threadId = ThreadId.makeUnsafe("recovery-owner");
    world.threads.push(
      thread({ id: threadId, projectId: "p", branch: "main", worktreePath: null }),
    );
    world.queueStates.set(threadId, {
      revision: 7,
      paused: true,
      pauseReasonCode: "manual_pause",
      worktreeBlockToken: null,
    });
    await run((manager) =>
      Effect.gen(function* () {
        expect(
          (yield* manager.recover({ threadId, action: "useProjectFolder" }).pipe(Effect.exit))._tag,
        ).toBe("Failure");
        expect(world.queueStates.get(threadId)?.pauseReasonCode).toBe("manual_pause");
      }),
    );
  });
});
