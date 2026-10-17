import * as fs from "node:fs/promises";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Effect } from "effect";
import { ServerConfig } from "../config.ts";
import {
  automationLayer,
  makeWorld,
  makeClonedRepo,
  git,
  project,
  thread,
} from "../storage/storageAutomation.testHarness.ts";
import { evaluateWorktreeRemoval, readWorktreeClaims } from "./worktreeClaims.ts";

describe("effective workspace claims and removal gate", () => {
  const cleanups: Array<() => Promise<unknown>> = [];
  afterEach(async () => {
    for (const cleanup of cleanups.splice(0)) await cleanup();
  });
  it("includes local and archived conversations, and treats canonicalization failure as unknown", async () => {
    const repo = await makeClonedRepo("f5-claims-");
    cleanups.push(repo.cleanup);
    const world = makeWorld();
    world.projects.push(project("p", repo.root));
    world.threads.push(thread({ id: "local", projectId: "p", worktreePath: null }));
    world.threads.push({
      ...thread({ id: "archived", projectId: "p", worktreePath: null }),
      archivedAt: new Date().toISOString(),
    });
    await Effect.runPromise(
      Effect.gen(function* () {
        const claims = yield* readWorktreeClaims(repo.root);
        expect(claims.threadIds).toEqual(["local", "archived"]);
        expect(claims.unknown).toBe(false);
        expect((yield* readWorktreeClaims("/bad\0path")).unknown).toBe(true);
        world.threads.push(thread({ id: "unknown", projectId: "p", worktreePath: "/bad\0path" }));
        expect((yield* readWorktreeClaims(repo.root)).unknown).toBe(true);
      }).pipe(Effect.provide(automationLayer(world, {}, "f5-claims-state-")), Effect.scoped),
    );
  });
  it("allows idle links but blocks ignored secrets, queued work, and live orphan processes", async () => {
    const repo = await makeClonedRepo("f5-removal-");
    cleanups.push(repo.cleanup);
    const world = makeWorld();
    world.projects.push(project("p", repo.root));
    await Effect.runPromise(
      Effect.gen(function* () {
        const config = yield* ServerConfig;
        const target = path.join(config.worktreesDir, "repo", "feature");
        yield* Effect.promise(() => fs.mkdir(path.dirname(target), { recursive: true }));
        git(repo.root, "worktree", "add", "-q", "-b", "feature", target, "main");
        world.threads.push(
          thread({ id: "idle", projectId: "p", worktreePath: target, branch: "feature" }),
        );
        const inspect = () =>
          evaluateWorktreeRemoval({
            projectCwd: repo.root,
            path: target,
            policy: { kind: "manual", ownThreadId: null },
          });
        expect((yield* inspect()).blockedReasons).toEqual([]);
        expect((yield* inspect()).linkedThreads).toEqual(["idle"]);
        yield* Effect.promise(() => fs.writeFile(path.join(target, ".env"), "SECRET=value\n"));
        expect((yield* inspect()).blockedReasons.join(" ")).toContain("ignored");
        yield* Effect.promise(() => fs.rm(path.join(target, ".env")));
        yield* Effect.promise(() =>
          fs.mkdir(path.join(target, "node_modules", "dep"), { recursive: true }),
        );
        expect((yield* inspect()).blockedReasons).toEqual([]);
        world.queuedThreadIds.add("idle");
        expect((yield* inspect()).blockedReasons.join(" ")).toContain("queued");
        world.queuedThreadIds.clear();
        world.terminals.push({
          threadId: "orphan",
          terminalId: "shell",
          cwd: target,
          status: "running",
        });
        expect((yield* inspect()).blockedReasons.join(" ")).toContain("terminal");
        world.terminals.length = 0;
        world.projects.push(project("other", target));
        expect((yield* inspect()).blockedReasons.join(" ")).toContain("project checkout");
      }).pipe(Effect.provide(automationLayer(world, {}, "f5-removal-state-")), Effect.scoped),
    );
  });
});
