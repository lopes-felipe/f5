import { randomUUID, createHash } from "node:crypto";
import { realpath } from "node:fs/promises";
import { Data, Effect, Option, Schema } from "effect";
import {
  ClaudeSettings,
  CodexSettings,
  CommandId,
  DEFAULT_MODEL_BY_PROVIDER,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type AgentSessionImportInput,
  type AgentSessionImportResult,
  type ServerSettings,
} from "@t3tools/contracts";
import { deriveProviderInstanceConfigMap } from "../provider/Layers/ProviderInstanceRegistryHydration";
import { buildAccountExecutionEnvironment } from "../providerProcessEnv";
import { resolveCodexHomeLayout } from "../provider/Drivers/CodexHomeLayout";
import { makeClaudeEnvironment, resolveClaudeConfigDir } from "../provider/Drivers/ClaudeHome";
import type { ServerConfigShape } from "../config";
import type { OrchestrationEngineShape } from "../orchestration/Services/OrchestrationEngine";
import type { ProviderSessionDirectoryShape } from "../provider/Services/ProviderSessionDirectory";
import { AgentSessionScanner, type AgentSessionHome } from "./AgentSessionScanner";
import { readClaudeResumeCandidate } from "../provider/claudeResumeState";
import { readResumeCursorThreadId } from "../codexAppServerManager";

export const resolveAgentSessionHomes = Effect.fn("resolveAgentSessionHomes")(function* (
  settings: ServerSettings,
  config: Pick<ServerConfigShape, "profile" | "stateDir">,
) {
  const sources: AgentSessionHome[] = [];
  for (const [id, entry] of Object.entries(deriveProviderInstanceConfigMap(settings))) {
    if (entry.driver !== "codex" && entry.driver !== "claudeAgent") continue;
    const environment = buildAccountExecutionEnvironment({
      purpose: "provider",
      profile: config.profile,
      stateDir: config.stateDir,
      baseEnv: process.env,
      instance: entry.environment,
    });
    if (entry.driver === "codex") {
      const decoded = Schema.decodeUnknownOption(CodexSettings)(entry.config ?? {});
      if (Option.isNone(decoded)) continue;
      // Managed instances without an assigned home cannot launch. Do not fall
      // through to the operating-system account's ambient Codex history.
      if (config.profile?.isDefault === false && !decoded.value.homePath.trim()) continue;
      const layout = yield* resolveCodexHomeLayout(
        decoded.value,
        config.profile?.isDefault === false,
        environment.CODEX_HOME,
      );
      sources.push({
        provider: "codex",
        instanceId: ProviderInstanceId.make(id),
        home: layout.effectiveHomePath ?? layout.sharedHomePath,
      });
    } else {
      const decoded = Schema.decodeUnknownOption(ClaudeSettings)(entry.config ?? {});
      if (Option.isNone(decoded)) continue;
      const env = yield* makeClaudeEnvironment(decoded.value, environment);
      sources.push({
        provider: "claudeAgent",
        instanceId: ProviderInstanceId.make(id),
        home: resolveClaudeConfigDir(env),
      });
    }
  }
  return sources;
});

const digest = (value: string) => createHash("sha256").update(value).digest("hex");
class AgentSessionImportError extends Data.TaggedError("AgentSessionImportError")<{
  readonly message: string;
}> {}
export const importAgentSessionProject = Effect.fn("importAgentSessionProject")(function* (input: {
  request: AgentSessionImportInput;
  scanner: AgentSessionScanner;
  homes: ReadonlyArray<AgentSessionHome>;
  engine: Pick<OrchestrationEngineShape, "getReadModel" | "dispatch">;
  directory: Pick<ProviderSessionDirectoryShape, "upsert" | "listBindings" | "removePendingImport">;
}) {
  const candidate = yield* Effect.try({
    try: () => input.scanner.get(input.request.candidateId, input.request.expectedWorkspaceRoot),
    catch: () =>
      new AgentSessionImportError({
        message: "Scan for projects again before importing this history.",
      }),
  });
  const cwd = candidate.summary.path;
  yield* Effect.tryPromise({
    try: async () => {
      if ((await realpath(cwd)) !== cwd) throw new Error("Project path changed.");
    },
    catch: () =>
      new AgentSessionImportError({
        message: "The project directory changed. Scan for projects again.",
      }),
  });
  const model = yield* input.engine.getReadModel();
  const projects = model.projects.filter((project) => project.deletedAt === null);
  const roots = yield* Effect.promise(() =>
    Promise.all(
      projects.map((project) => realpath(project.workspaceRoot).catch(() => project.workspaceRoot)),
    ),
  );
  const existing = projects[roots.indexOf(cwd)];
  const projectId = existing?.id ?? ProjectId.makeUnsafe(randomUUID());
  if (!existing)
    yield* input.engine.dispatch({
      type: "project.create",
      commandId: CommandId.make(randomUUID()),
      projectId,
      title: candidate.summary.title,
      workspaceRoot: cwd,
      createdAt: new Date().toISOString(),
    });
  const threadIds: ThreadId[] = [];
  let skippedCount = 0;
  let bytes = 0;
  let truncated = false;
  if (input.request.includeHistory) {
    const knownBindings = yield* input.directory.listBindings();
    for (const source of candidate.transcripts) {
      if (threadIds.length + skippedCount >= 100 || bytes + source.size > 64 * 1024 * 1024) {
        truncated = true;
        break;
      }
      bytes += source.size;
      const home = input.homes.find(
        (home) =>
          home.provider === source.source.provider &&
          home.instanceId === source.source.instanceId &&
          home.home === source.source.home,
      );
      if (!home) {
        skippedCount++;
        continue;
      }
      const result = yield* Effect.gen(function* () {
        const history = yield* Effect.tryPromise({
          try: (signal) => input.scanner.read(source, cwd, signal),
          catch: () =>
            new AgentSessionImportError({
              message: "The session could not be imported. Scan again before retrying.",
            }),
        });
        if (!history || history.messages.length === 0) return null;
        const threadId = ThreadId.makeUnsafe(
          "import:" + digest(projectId + ":" + home.instanceId + ":" + history.providerSessionId),
        );
        const current = yield* input.engine.getReadModel();
        const known = knownBindings.find(
          (binding) =>
            binding.provider === history.source &&
            (binding.providerInstanceId ?? binding.provider) === home.instanceId &&
            (history.source === "codex"
              ? readResumeCursorThreadId(binding.resumeCursor)
              : readClaudeResumeCandidate(binding.resumeCursor)) === history.providerSessionId,
        );
        if (known) {
          const existingThread = current.threads.find((thread) => thread.id === known.threadId);
          if (existingThread) return existingThread.deletedAt === null ? existingThread.id : null;
        }
        const prior = current.threads.find((thread) => thread.id === threadId);
        if (prior) return prior.deletedAt === null ? threadId : null;
        const resumeCursor =
          history.source === "codex"
            ? { threadId: history.providerSessionId }
            : { threadId, resume: history.providerSessionId };
        const historyImportId = randomUUID();
        // Publish the binding first. The directory's shared thread lock and
        // insert-if-absent rule prevent a retry from replacing a live session.
        yield* input.directory.upsert(
          {
            threadId,
            projectId,
            provider: history.source,
            providerInstanceId: home.instanceId,
            status: "stopped",
            runtimeMode: "approval-required",
            resumeCursor,
            runtimePayload: { cwd, historyImportId },
          },
          { onConflict: "ignore" },
        );
        const selectedModel = history.model ?? DEFAULT_MODEL_BY_PROVIDER[history.source];
        yield* input.engine
          .dispatch({
            type: "thread.import",
            commandId: CommandId.make(randomUUID()),
            threadId,
            projectId,
            title: history.title,
            model: selectedModel,
            modelSelection: { instanceId: home.instanceId, model: selectedModel },
            runtimeMode: "approval-required",
            interactionMode: "default",
            branch: null,
            worktreePath: null,
            createdAt: history.createdAt,
            expectedWorkspaceRoot: existing?.workspaceRoot ?? cwd,
            messages: history.messages,
          })
          .pipe(
            Effect.tapError((error) => {
              // These errors prove the command was rejected before persistence.
              // Retain the staging binding when delivery/persistence is uncertain.
              if (
                error._tag !== "OrchestrationCommandInvariantError" &&
                error._tag !== "OrchestrationCommandPreviouslyRejectedError" &&
                error._tag !== "OrchestrationOverloadError"
              )
                return Effect.void;
              return Effect.gen(function* () {
                const latest = yield* input.engine.getReadModel();
                if (!latest.threads.some((thread) => thread.id === threadId))
                  yield* input.directory.removePendingImport(threadId, historyImportId);
              }).pipe(Effect.ignore);
            }),
          );
        return threadId;
      }).pipe(Effect.catch(() => Effect.succeed(null)));
      if (result) threadIds.push(result);
      else skippedCount++;
    }
  }
  return { projectId, threadIds, skippedCount, truncated } satisfies AgentSessionImportResult;
});
