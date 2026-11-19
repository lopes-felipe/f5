import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  DEFAULT_SERVER_SETTINGS,
  CommandId,
  ThreadId,
  ProviderInstanceId,
  type OrchestrationEvent,
} from "@t3tools/contracts";
import { fallbackDefaultProfile } from "@t3tools/shared/profileIdentity";
import { createEmptyReadModel, projectEvent } from "../orchestration/projector";
import { decideOrchestrationCommand } from "../orchestration/decider";
import type { OrchestrationEngineShape } from "../orchestration/Services/OrchestrationEngine";
import type {
  ProviderRuntimeBinding,
  ProviderSessionDirectoryShape,
} from "../provider/Services/ProviderSessionDirectory";
import { AgentSessionScanner } from "./AgentSessionScanner";
import { importAgentSessionProject, resolveAgentSessionHomes } from "./AgentSessionImporter";
import { OrchestrationCommandInvariantError } from "../orchestration/Errors";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
const now = "2026-11-19T10:00:00.000Z";
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "f5-history-import-")));
  roots.push(root);
  const home = join(root, "codex");
  const cwd = join(root, "project");
  await mkdir(join(home, "sessions"), { recursive: true });
  await mkdir(cwd);
  await writeFile(
    join(home, "sessions", "native.jsonl"),
    [
      { type: "session_meta", payload: { id: "11111111-1111-4111-8111-111111111111", cwd } },
      {
        type: "event_msg",
        timestamp: now,
        payload: { type: "user_message", message: "Original prompt" },
      },
      {
        type: "response_item",
        timestamp: now,
        payload: {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "Original answer" }],
        },
      },
    ]
      .map((record) => JSON.stringify(record))
      .join("\n") + "\n",
  );
  const homes = [
    { provider: "codex" as const, instanceId: ProviderInstanceId.make("codex-custom"), home },
  ];
  const scanner = new AgentSessionScanner();
  const scan = await scanner.scan(homes, [], join(root, "worktrees"), new AbortController().signal);
  const candidate = scan.candidates[0]!;
  let model = createEmptyReadModel(now);
  const events: OrchestrationEvent[] = [];
  const bindings = new Map<string, ProviderRuntimeBinding>();
  const directory: Pick<
    ProviderSessionDirectoryShape,
    "upsert" | "listBindings" | "removePendingImport"
  > = {
    removePendingImport: (threadId, importId) =>
      Effect.sync(() => {
        const payload = bindings.get(threadId)?.runtimePayload as
          | { historyImportId?: string }
          | undefined;
        return payload?.historyImportId === importId ? bindings.delete(threadId) : false;
      }),
    listBindings: () =>
      Effect.sync(() => [...bindings.values()].map((binding) => ({ ...binding, lastSeenAt: now }))),
    upsert: (binding, options) =>
      Effect.sync(() => {
        if (options?.onConflict === "ignore" && bindings.has(binding.threadId)) return;
        bindings.set(binding.threadId, binding);
      }),
  };
  const engine: Pick<OrchestrationEngineShape, "dispatch" | "getReadModel"> = {
    getReadModel: () => Effect.sync(() => model),
    dispatch: (command) =>
      Effect.gen(function* () {
        if (command.type === "thread.import") expect(bindings.has(command.threadId)).toBe(true);
        const result = yield* decideOrchestrationCommand({ command, readModel: model });
        for (const event of Array.isArray(result) ? result : [result]) {
          const sequenced = { ...event, sequence: events.length + 1 } as OrchestrationEvent;
          model = yield* projectEvent(model, sequenced);
          events.push(sequenced);
        }
        return { sequence: events.length };
      }),
  };
  const request = {
    candidateId: candidate.id,
    expectedWorkspaceRoot: candidate.path,
    includeHistory: true,
  };
  const run = (changes: Partial<typeof request> = {}) =>
    Effect.runPromise(
      importAgentSessionProject({
        request: { ...request, ...changes },
        scanner,
        homes,
        engine,
        directory,
      }),
    );
  return { run, request, scanner, homes, engine, directory, bindings, events, model: () => model };
}
describe("onboarding history import", () => {
  it("cleans its staging binding when dispatch rejects the imported thread", async () => {
    const f = await fixture();
    const dispatch = f.engine.dispatch;
    vi.spyOn(f.engine, "dispatch").mockImplementation((command) =>
      command.type === "thread.import"
        ? Effect.fail(
            new OrchestrationCommandInvariantError({
              commandType: command.type,
              detail: "The project directory changed.",
            }),
          )
        : dispatch(command),
    );
    expect(await f.run()).toMatchObject({ threadIds: [], skippedCount: 1 });
    expect(f.bindings.size).toBe(0);
  });
  it("does not discover the ambient Codex home for an unconfigured isolated profile", async () => {
    const stateDir = join(tmpdir(), "f5-import-profile");
    const sources = await Effect.runPromise(
      resolveAgentSessionHomes(DEFAULT_SERVER_SETTINGS, {
        stateDir,
        profile: { ...fallbackDefaultProfile(stateDir), isDefault: false },
      }).pipe(Effect.provide(NodeServices.layer)),
    );
    expect(sources.some((source) => source.provider === "codex")).toBe(false);
    expect(sources.find((source) => source.provider === "claudeAgent")?.home).toContain(stateDir);
  });
  it("imports resumable history with approvals, distinct events, and no turn, then retries without duplicates", async () => {
    const f = await fixture();
    const result = await f.run();
    expect(result.threadIds).toHaveLength(1);
    const thread = f.model().threads[0]!;
    expect(thread).toMatchObject({
      runtimeMode: "approval-required",
      branch: null,
      worktreePath: null,
      modelSelection: { instanceId: "codex-custom" },
    });
    expect(thread.messages.map((message) => message.text)).toEqual([
      "Original prompt",
      "Original answer",
    ]);
    expect(new Set(f.events.map((event) => event.eventId)).size).toBe(f.events.length);
    expect(f.events.map((event) => event.type)).toEqual([
      "project.created",
      "thread.created",
      "thread.message-sent",
      "thread.message-sent",
    ]);
    expect(f.bindings.get(thread.id)).toMatchObject({
      status: "stopped",
      runtimeMode: "approval-required",
      resumeCursor: { threadId: "11111111-1111-4111-8111-111111111111" },
    });
    const count = f.events.length;
    expect(await f.run()).toEqual(result);
    expect(f.events).toHaveLength(count);
    let replay = createEmptyReadModel(now);
    for (const event of f.events) replay = await Effect.runPromise(projectEvent(replay, event));
    expect(replay.threads).toEqual(f.model().threads);
  });
  it("imports only the project when history is unchecked and refuses stale selections", async () => {
    const f = await fixture();
    expect((await f.run({ includeHistory: false })).threadIds).toEqual([]);
    expect(f.model().projects).toHaveLength(1);
    expect(f.bindings.size).toBe(0);
    await expect(f.run({ expectedWorkspaceRoot: "/moved" })).rejects.toThrow(
      "Scan for projects again",
    );
  });
  it("reuses an existing F5 conversation bound to the discovered CLI session", async () => {
    const f = await fixture();
    const { projectId } = await f.run({ includeHistory: false });
    const threadId = ThreadId.make("already-in-f5");
    await Effect.runPromise(
      f.engine.dispatch({
        type: "thread.create",
        commandId: CommandId.make("existing-thread"),
        projectId,
        threadId,
        title: "My existing conversation",
        model: "gpt-5.4",
        runtimeMode: "approval-required",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        createdAt: now,
      }),
    );
    f.bindings.set(threadId, {
      threadId,
      projectId,
      provider: "codex",
      providerInstanceId: ProviderInstanceId.make("codex-custom"),
      resumeCursor: { threadId: "11111111-1111-4111-8111-111111111111" },
    });
    expect((await f.run()).threadIds).toEqual([threadId]);
    expect(f.model().threads).toHaveLength(1);
    expect(f.model().threads[0]?.title).toBe("My existing conversation");
    expect(f.events).toHaveLength(2);
  });
  it("skips history when its configured home or provider instance changed after discovery", async () => {
    const f = await fixture();
    const result = await Effect.runPromise(
      importAgentSessionProject({
        request: f.request,
        scanner: f.scanner,
        homes: [],
        engine: f.engine,
        directory: f.directory,
      }),
    );
    expect(result).toMatchObject({ threadIds: [], skippedCount: 1 });
    expect(f.bindings.size).toBe(0);
  });
});
