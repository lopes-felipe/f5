import { ServerShutdown, ShutdownRegistry } from "../../shutdown.ts";
import * as FS from "node:fs/promises";
import * as OS from "node:os";
import * as Path from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  Queue,
  Effect,
  FileSystem,
  Layer,
  ManagedRuntime,
  PubSub,
  Scope,
  Stream,
  Exit,
} from "effect";
import {
  ProjectId,
  type OrchestrationCommand,
  type OrchestrationEvent,
  type OrchestrationReadModel,
  type OrchestrationProject,
} from "@t3tools/contracts";
import { afterEach, expect, it, vi } from "vitest";
import { ProjectSkillSyncServiceLive } from "./ProjectSkillSyncService.ts";
import { ProjectSkillSyncService } from "../Services/ProjectSkillSyncService.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { OrchestrationCommandInvariantError } from "../Errors.ts";
import * as scanner from "../projectSkills.ts";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
  vi.restoreAllMocks();
});

async function fixture(failFirst = false, scratch = false) {
  const directory = await FS.mkdtemp(Path.join(OS.tmpdir(), "f5-skills-incremental-"));
  const roots = [Path.join(directory, "one"), Path.join(directory, "two")];
  for (const root of roots) {
    await FS.mkdir(Path.join(root, ".claude", "skills", "demo"), { recursive: true });
    await FS.writeFile(
      Path.join(root, ".claude", "skills", "demo", "SKILL.md"),
      "---\nname: Demo\ndescription: Test\n---\nInstructions.",
    );
  }
  const projects = roots.map((root, i) => ({
    id: ProjectId.makeUnsafe(`project-${i}`),
    title: `Project ${i}`,
    workspaceRoot: root,
    deletedAt: null,
    kind: scratch && i === 0 ? "scratch" : "standard",
    skills: [],
  })) as unknown as OrchestrationProject[];
  const events = Effect.runSync(PubSub.unbounded<OrchestrationEvent>());
  const endings = new Map<string, () => Effect.Effect<boolean>>();
  const registrations = new Map<string, number>();
  const closed = new Set<string>();
  const shutdown = new ShutdownRegistry();
  const scan = vi.spyOn(scanner, "scanProjectSkills");
  let failures = failFirst ? 1 : 0;
  let modelReads = 0;
  const runtime = ManagedRuntime.make(
    ProjectSkillSyncServiceLive.pipe(
      Layer.provide(Layer.succeed(ServerShutdown, shutdown)),
      Layer.provide(
        Layer.succeed(OrchestrationEngineService, {
          getReadModel: () =>
            Effect.sync(() => {
              modelReads++;
              return { projects } as unknown as OrchestrationReadModel;
            }),
          dispatch: (command: OrchestrationCommand) =>
            Effect.suspend(() => {
              if (command.type === "project.skills.replace") {
                if (command.projectId === projects[0]?.id && failures-- > 0)
                  return Effect.fail(
                    new OrchestrationCommandInvariantError({
                      commandType: command.type,
                      detail: "Injected failure",
                    }),
                  );
                const index = projects.findIndex((project) => project.id === command.projectId);
                projects[index] = { ...projects[index]!, skills: command.skills };
              }
              return Effect.succeed({ sequence: 1 });
            }),
          streamDomainEvents: Stream.fromPubSub(events),
        } as unknown as import("../Services/OrchestrationEngine.ts").OrchestrationEngineShape),
      ),
      Layer.provide(
        Layer.effect(
          FileSystem.FileSystem,
          Effect.gen(function* () {
            const fs = yield* FileSystem.FileSystem;
            return {
              ...fs,
              watch: (path: string) => {
                registrations.set(path, (registrations.get(path) ?? 0) + 1);
                return Stream.callback<FileSystem.WatchEvent>((queue) =>
                  Effect.sync(() => {
                    endings.set(path, () => Queue.end(queue));
                  }),
                ).pipe(
                  Stream.ensuring(
                    Effect.sync(() => {
                      closed.add(path);
                    }),
                  ),
                );
              },
            } satisfies FileSystem.FileSystem;
          }),
        ).pipe(Layer.provide(NodeServices.layer)),
      ),
      Layer.provide(NodeServices.layer),
    ),
  );
  const scope = await Effect.runPromise(Scope.make("sequential"));
  cleanups.push(async () => {
    await Effect.runPromise(Scope.close(scope, Exit.void));
    await runtime.dispose();
    await FS.rm(directory, { recursive: true, force: true });
  });
  const service = await runtime.runPromise(Effect.service(ProjectSkillSyncService));
  await runtime.runPromise(service.start.pipe(Scope.provide(scope)));
  const drain = () => runtime.runPromise(service.drain);
  const change = async (index: number) => {
    const calls = scan.mock.calls.length;
    const reads = modelReads;
    Effect.runSync(
      PubSub.publish(events, {
        type: "project.meta-updated",
        aggregateId: projects[index]!.id,
      } as OrchestrationEvent),
    );
    await vi.waitFor(() =>
      projects[index]!.deletedAt
        ? expect(modelReads).toBeGreaterThan(reads)
        : expect(scan.mock.calls.length).toBeGreaterThan(calls),
    );
    await drain();
  };
  return {
    roots,
    projects,
    shutdown,
    closed,
    publish: () =>
      Effect.runPromise(
        PubSub.publish(events, {
          type: "project.meta-updated",
          aggregateId: projects[0]!.id,
        } as OrchestrationEvent),
      ),
    scan,
    registrations,
    endings,
    drain,
    change,
    warnings: (id: ProjectId) => runtime.runPromise(service.getWarnings(id)),
  };
}

it("refreshes only dirty projects, preserves watchers, and exposes malformed/deleted skill roots", async () => {
  const h = await fixture();
  const baseline = [...h.registrations];
  h.scan.mockClear();
  await h.change(0);
  expect(h.scan.mock.calls.every(([input]) => input.projectId === h.projects[0]!.id)).toBe(true);
  expect([...h.registrations]).toEqual(baseline);
  await FS.writeFile(
    Path.join(h.roots[0]!, ".claude/skills/demo/SKILL.md"),
    "---\nname: [unterminated\n---\nBroken",
  );
  await h.change(0);
  expect((await h.warnings(h.projects[0]!.id))[0]).toMatchObject({
    path: expect.stringContaining("SKILL.md"),
    reason: expect.any(String),
  });
  await FS.rm(Path.join(h.roots[0]!, ".claude"), { recursive: true });
  await h.change(0);
  expect(h.projects[0]?.skills).toEqual([]);
  await FS.mkdir(Path.join(h.roots[0]!, ".claude/skills/restored"), { recursive: true });
  await FS.writeFile(
    Path.join(h.roots[0]!, ".claude/skills/restored/SKILL.md"),
    "---\nname: Restored\ndescription: Restored\n---\nInstructions.",
  );
  await h.change(0);
  expect(h.projects[0]?.skills?.map((skill) => skill.commandName)).toContain("restored");
});

it("never scans or watches the shared scratch root", async () => {
  const h = await fixture(false, true);
  expect(h.scan.mock.calls.every(([input]) => input.projectId !== h.projects[0]!.id)).toBe(true);
  expect([...h.registrations.keys()].some((path) => path.startsWith(h.roots[0]!))).toBe(false);
  expect(h.projects[0]?.skills).toEqual([]);
  expect(h.projects[1]?.skills).toHaveLength(1);
});

it("keeps later projects and watchers alive when the first dispatch fails, then retries it", async () => {
  const h = await fixture(true);
  expect(h.projects[0]?.skills).toEqual([]);
  expect(h.projects[1]?.skills).toHaveLength(1);
  for (const root of h.roots)
    expect([...h.registrations.keys()].some((path) => path.startsWith(root))).toBe(true);
  await h.drain();
  expect(h.projects[0]?.skills).toHaveLength(1);
});

it("replaces normally ended watch streams and forgets removed projects' watch paths", async () => {
  const h = await fixture();
  await vi.waitFor(() => expect(h.endings.size).toBeGreaterThan(0));
  const path = [...h.endings.keys()].find((path) => path.startsWith(h.roots[0]!))!;
  await Effect.runPromise(h.endings.get(path)!());
  await vi.waitFor(async () =>
    expect(
      (await h.warnings(h.projects[0]!.id)).some((warning) =>
        warning.reason.includes("Watch stream ended"),
      ),
    ).toBe(true),
  );
  await h.drain();
  expect(h.registrations.get(path)).toBe(2);
  h.projects[0] = { ...h.projects[0]!, deletedAt: new Date().toISOString() };
  await h.change(0);
  const baseline = [...h.registrations];
  await h.drain();
  expect([...h.registrations]).toEqual(baseline);
});

it("stops polling, watches and queued debounce admission before shutdown drains", async () => {
  const h = await fixture();
  await vi.waitFor(() => expect(h.endings.size).toBe(h.registrations.size));
  const results = await h.shutdown.run();
  expect(results.map((result) => result.name).sort()).toEqual([
    "project-skill-sources",
    "project-skill-work",
  ]);
  expect(results.every((result) => result.outcome === "complete")).toBe(true);
  expect([...h.registrations.keys()].every((path) => h.closed.has(path))).toBe(true);
  const scans = h.scan.mock.calls.length;
  await h.publish();
  await h.drain();
  expect(h.scan.mock.calls).toHaveLength(scans);
});
