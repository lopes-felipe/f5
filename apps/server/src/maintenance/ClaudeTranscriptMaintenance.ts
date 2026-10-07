import { ProviderInstanceId, type ThreadId } from "@t3tools/contracts";
import { Effect, Option, Schema } from "effect";
import {
  readClaudeRecoveryMetadata,
  readClaudeResumeState,
} from "../provider/claudeResumeState.ts";
import {
  beginClaudeTranscriptMaintenance,
  findClaudeTranscript,
} from "../provider/claudeTranscript.ts";
import { resolveClaudeConfigDir } from "../provider/Layers/ClaudeAdapter.ts";
import { readPersistedCwd } from "../provider/runtimePayload.ts";
import { withProviderThreadAccess } from "../provider/providerThreadAccess.ts";
import type { ProviderSessionDirectoryShape } from "../provider/Services/ProviderSessionDirectory.ts";
import type { ProviderServiceShape } from "../provider/Services/ProviderService.ts";
import {
  canUndoClaudeResumeRepair,
  inspectClaudeResumePoint,
  recoverClaudeTranscriptCursor,
  repairClaudeResumePoint,
  undoClaudeResumeRepair,
} from "./ClaudeTranscriptRepair.ts";

class ClaudeTranscriptMaintenanceError extends Schema.TaggedErrorClass<ClaudeTranscriptMaintenanceError>()(
  "ClaudeTranscriptMaintenanceError",
  { message: Schema.String },
) {}

interface MaintenanceInput {
  threadId: ThreadId;
  directory: Pick<ProviderSessionDirectoryShape, "getBinding" | "upsert">;
  service: Pick<ProviderServiceShape, "listSessions" | "stopSession">;
  resolveAccount: (instanceId: ProviderInstanceId) => Promise<{ environment: NodeJS.ProcessEnv }>;
  providerLogsDir: string;
}

/** Resolve the actual CLI store and reconcile interrupted commits under the provider admission lock. */
const resolveTranscript = Effect.fn(function* (input: MaintenanceInput) {
  const option = yield* input.directory.getBinding(input.threadId);
  if (Option.isNone(option) || option.value.provider !== "claudeAgent")
    throw new Error("No Claude session is available for this thread.");
  const binding = option.value;
  const state = readClaudeResumeState(binding.resumeCursor);
  if (!state?.resume) throw new Error("No Claude resume session is available.");
  const account = yield* Effect.tryPromise({
    try: () =>
      input.resolveAccount(
        binding.providerInstanceId ?? ProviderInstanceId.makeUnsafe("claudeAgent"),
      ),
    catch: () =>
      new ClaudeTranscriptMaintenanceError({
        message: "Could not resolve the Claude provider account. Check its configuration.",
      }),
  });
  const file = yield* Effect.tryPromise(() =>
    findClaudeTranscript(
      resolveClaudeConfigDir(account.environment, readPersistedCwd(binding.runtimePayload)),
      state.resume!,
    ),
  );
  const cursor = yield* Effect.tryPromise(() =>
    recoverClaudeTranscriptCursor(file, binding.resumeCursor),
  );
  if (cursor !== binding.resumeCursor)
    yield* input.directory.upsert({
      threadId: input.threadId,
      provider: "claudeAgent",
      resumeCursor: cursor,
    });
  return { file, cursor, state: readClaudeResumeState(cursor)! };
});

/** Report repair independently of error text, and undo only when its receipt still matches. */
export function getClaudeTranscriptMaintenance(input: MaintenanceInput) {
  return withProviderThreadAccess(
    input.threadId,
    Effect.gen(function* () {
      const option = yield* input.directory.getBinding(input.threadId);
      if (
        Option.isNone(option) ||
        option.value.provider !== "claudeAgent" ||
        !readClaudeResumeState(option.value.resumeCursor)?.resume
      )
        return null;
      const resolved = yield* resolveTranscript(input);
      const metadata = readClaudeRecoveryMetadata(resolved.cursor);
      const target =
        metadata.missingResumePoint ??
        resolved.state.resumeSessionAt ??
        resolved.state.turnBoundaries?.at(-1)?.assistantUuid;
      if (!target) return null;
      const inspection = yield* Effect.tryPromise(() =>
        inspectClaudeResumePoint(resolved.file, target),
      );
      const backupId = metadata.transcriptRepairBackupId;
      const undoAvailable = backupId
        ? yield* Effect.tryPromise(() => canUndoClaudeResumeRepair(resolved.file, backupId))
        : false;
      return {
        canRepair:
          metadata.missingResumePoint !== undefined || inspection.reason === "missing_resume_point",
        ...(undoAvailable ? { backupId } : {}),
      };
    }),
  ).pipe(
    Effect.catchIf(
      (error) => {
        let value: unknown = error;
        while (value && typeof value === "object") {
          if ((value as { code?: unknown }).code === "ENOENT") return true;
          const cause = (value as { cause?: unknown }).cause;
          if (cause === value) break;
          value = cause;
        }
        return false;
      },
      () => Effect.succeed(null),
    ),
  );
}

/** Stop the latest admitted process before editing; never overwrite its stopped binding fields. */
export function runClaudeTranscriptMaintenance(input: MaintenanceInput, backupId?: string) {
  return withProviderThreadAccess(
    input.threadId,
    Effect.gen(function* () {
      const sessions = yield* input.service.listSessions();
      const live = sessions.find((session) => session.threadId === input.threadId);
      if (live?.status === "running")
        throw new Error("Stop the active turn before repairing its transcript.");
      if (live) yield* input.service.stopSession({ threadId: input.threadId });
      const { file, cursor, state } = yield* resolveTranscript(input);
      const target =
        readClaudeRecoveryMetadata(cursor).missingResumePoint ??
        state.resumeSessionAt ??
        state.turnBoundaries?.at(-1)?.assistantUuid;
      if (!target) throw new Error("No Claude resume point is available.");
      const release = yield* Effect.try({
        try: () => beginClaudeTranscriptMaintenance(state.resume!),
        catch: () =>
          new ClaudeTranscriptMaintenanceError({
            message: "Claude transcript repair is already in progress.",
          }),
      });
      return yield* Effect.gen(function* () {
        if (backupId) {
          const recovered = yield* Effect.tryPromise(() =>
            undoClaudeResumeRepair(file, backupId, cursor),
          );
          yield* input.directory.upsert({
            threadId: input.threadId,
            provider: "claudeAgent",
            resumeCursor: recovered,
          });
          return;
        }
        const result = yield* Effect.tryPromise(() =>
          repairClaudeResumePoint({
            file,
            target,
            sessionId: state.resume!,
            threadId: input.threadId,
            providerLogsDir: input.providerLogsDir,
            resumeCursor: cursor,
          }),
        );
        const recovered: Record<string, unknown> = { ...result.resumeCursor };
        delete recovered.missingResumePoint;
        yield* input.directory.upsert({
          threadId: input.threadId,
          provider: "claudeAgent",
          resumeCursor: recovered,
        });
        return {
          ...("backupId" in result ? { backupId: result.backupId } : {}),
          restoredMessages: result.restoredMessages,
          status: result.status,
        };
      }).pipe(Effect.ensuring(Effect.sync(release)));
    }),
  );
}

/** Filesystem failures are logged server-side; client messages do not expose home paths. */
export function claudeMaintenanceErrorMessage(error: unknown): string {
  const value = error as { code?: unknown; cause?: unknown; message?: unknown } | null;
  if (value?.code !== undefined)
    return "Could not read or update the Claude transcript. Check storage availability and permissions.";
  if (value?.cause !== undefined) return claudeMaintenanceErrorMessage(value.cause);
  return typeof value?.message === "string"
    ? value.message
    : "Claude transcript maintenance failed. Check the server log for details.";
}
