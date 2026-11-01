import { makeShutdownSourceScope, registerShutdown } from "../../shutdown.ts";
/**
 * Deletes a Claude session's local transcript once its F5 thread is deleted.
 *
 * `thread.deleted` is final (F5 has no undelete; snoozed and archived threads
 * never emit it). The binding is read as soon as the event arrives because
 * storage maintenance purges `provider_session_runtime` for deleted threads
 * shortly after. The transcript is removed from the bound instance's own
 * config dir, and skipped when any other live F5 thread still binds the same
 * Claude session id (a fork or import that resumes it). Claude sessions parked
 * by a provider switch are cleaned up the same way, one job per session. Every
 * failure is logged and swallowed: cleanup never blocks or fails the deletion.
 *
 * @module NativeSessionCleanupReactor
 */
import {
  defaultInstanceIdForDriver,
  ProviderDriverKind,
  type ProviderInstanceId,
  type ThreadId,
} from "@t3tools/contracts";
import { makeBackgroundWorker } from "../../backgroundWorker.ts";
import { providerRuntimeCapabilities } from "@t3tools/shared/providerRuntimeCapabilities";
import { Cause, Effect, Layer, Option, Scope, Stream } from "effect";

import { readClaudeResumeState } from "../../provider/claudeResumeState.ts";
import {
  ProviderHandoffStateRepository,
  type ProviderHandoffState,
} from "../../persistence/Services/ProviderHandoffState.ts";
import { ProviderInstanceRegistry } from "../../provider/Services/ProviderInstanceRegistry.ts";
import {
  ProviderSessionDirectory,
  type ProviderRuntimeBinding,
} from "../../provider/Services/ProviderSessionDirectory.ts";
import {
  NativeSessionCleanupReactor,
  type NativeSessionCleanupReactorShape,
} from "../Services/NativeSessionCleanupReactor.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";

const CLAUDE_DRIVER = ProviderDriverKind.make("claudeAgent");

interface CleanupJob {
  readonly threadId: ThreadId;
  readonly sessionId: string;
  readonly instanceId: ProviderInstanceId;
}

/** The Claude session a binding resumes, if it is a Claude binding. */
export function claudeSessionIdOfBinding(
  binding: Pick<ProviderRuntimeBinding, "provider" | "resumeCursor">,
): string | undefined {
  if (binding.provider !== "claudeAgent") return undefined;
  return readClaudeResumeState(binding.resumeCursor)?.resume;
}

/** The thread's active Claude session plus every Claude session parked by a provider switch. */
export function claudeSessionsForThread(
  binding: Pick<ProviderRuntimeBinding, "provider" | "resumeCursor" | "providerInstanceId"> | null,
  handoffState: Pick<ProviderHandoffState, "parked"> | null,
): ReadonlyArray<{ readonly sessionId: string; readonly instanceId: ProviderInstanceId }> {
  const sessions = new Map<string, ProviderInstanceId>();
  const active = binding ? claudeSessionIdOfBinding(binding) : undefined;
  if (binding && active)
    sessions.set(active, binding.providerInstanceId ?? defaultInstanceIdForDriver(CLAUDE_DRIVER));
  for (const parked of Object.values(handoffState?.parked ?? {})) {
    if (parked.provider !== "claudeAgent") continue;
    const sessionId = readClaudeResumeState(parked.resumeCursor)?.resume;
    if (sessionId && !sessions.has(sessionId)) sessions.set(sessionId, parked.providerInstanceId);
  }
  return [...sessions].map(([sessionId, instanceId]) => ({ sessionId, instanceId }));
}

export const makeNativeSessionCleanupReactor = Effect.gen(function* () {
  const sources = yield* makeShutdownSourceScope("native-session-cleanup-sources");
  const orchestrationEngine = yield* OrchestrationEngineService;
  const directory = yield* ProviderSessionDirectory;
  const instances = yield* ProviderInstanceRegistry;
  const handoffStates = yield* Effect.serviceOption(ProviderHandoffStateRepository);

  const isSharedWithLiveThread = (job: CleanupJob) =>
    Effect.gen(function* () {
      const [bindings, readModel, parkedStates] = yield* Effect.all([
        directory.listBindings(),
        orchestrationEngine.getReadModel(),
        Option.isSome(handoffStates) ? handoffStates.value.listAll : Effect.succeed([]),
      ]);
      const deleted = new Set(
        readModel.threads.filter((thread) => thread.deletedAt !== null).map((thread) => thread.id),
      );
      // A binding whose thread is missing from the read model counts as live.
      return (
        bindings.some(
          (binding) =>
            binding.threadId !== job.threadId &&
            !deleted.has(binding.threadId) &&
            claudeSessionIdOfBinding(binding) === job.sessionId,
        ) ||
        parkedStates.some(
          (state) =>
            state.threadId !== job.threadId &&
            !deleted.has(state.threadId) &&
            claudeSessionsForThread(null, state).some(
              (session) => session.sessionId === job.sessionId,
            ),
        )
      );
    });

  const cleanup = (job: CleanupJob) =>
    Effect.gen(function* () {
      if (yield* isSharedWithLiveThread(job)) {
        yield* Effect.logInfo(
          "native session cleanup skipped: session shared with another thread",
          {
            threadId: job.threadId,
            sessionId: job.sessionId,
          },
        );
        return;
      }
      const instance = yield* instances.getInstance(job.instanceId);
      if (!instance?.deleteNativeSession) {
        // Unavailable, or its transcripts live in a store shared with the user's CLI.
        yield* Effect.logInfo("native session cleanup skipped: no isolated transcript store", {
          threadId: job.threadId,
          instanceId: job.instanceId,
        });
        return;
      }
      // The browser's stop request is asynchronous and may have failed; never
      // unlink a transcript the CLI is still writing.
      if (yield* instance.adapter.hasSession(job.threadId)) {
        yield* instance.adapter.stopSession(job.threadId);
        if (yield* instance.adapter.hasSession(job.threadId)) {
          yield* Effect.logWarning("native session cleanup skipped: session still running", {
            threadId: job.threadId,
            instanceId: job.instanceId,
          });
          return;
        }
      }
      const result = yield* instance.deleteNativeSession(job.sessionId);
      yield* Effect.logInfo("native session transcript deleted", {
        threadId: job.threadId,
        instanceId: job.instanceId,
        sessionId: job.sessionId,
        removed: result.removed.length,
      });
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("native session cleanup failed", {
          threadId: job.threadId,
          instanceId: job.instanceId,
          cause: Cause.pretty(cause),
        }),
      ),
    );

  const worker = yield* makeBackgroundWorker(cleanup, { name: "NativeSessionCleanupReactor" });

  /** Captures the jobs synchronously with the event, before storage purges the binding. */
  const captureJobs = (threadId: ThreadId) =>
    Effect.gen(function* () {
      if (!providerRuntimeCapabilities(CLAUDE_DRIVER).nativeSessionCleanup) return [];
      const binding = Option.getOrNull(yield* directory.getBinding(threadId));
      const handoffState = Option.isSome(handoffStates)
        ? yield* handoffStates.value.get(threadId)
        : null;
      return claudeSessionsForThread(binding, handoffState).map(
        (session): CleanupJob => ({ threadId, ...session }),
      );
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("native session cleanup could not read the thread binding", {
          threadId,
          cause: Cause.pretty(cause),
        }).pipe(Effect.as<ReadonlyArray<CleanupJob>>([])),
      ),
    );

  const start: NativeSessionCleanupReactorShape["start"] = Effect.gen(function* () {
    if (sources.stopped) return;
    yield* Effect.addFinalizer(() => sources.stop);
    yield* Stream.runForEach(orchestrationEngine.streamDomainEvents, (event) =>
      event.type === "thread.deleted"
        ? captureJobs(event.payload.threadId).pipe(
            Effect.flatMap((jobs) => Effect.forEach(jobs, worker.enqueue, { discard: true })),
          )
        : Effect.void,
    ).pipe(
      Scope.provide(sources.scope),
      Effect.forkIn(sources.scope, { startImmediately: true }),
      Effect.asVoid,
    );
  });

  yield* registerShutdown("native-session-cleanup", "drain", () => worker.drain, [
    "provider-ingestion",
  ]);
  yield* Effect.addFinalizer(() => sources.stop);

  return { start, drain: worker.drain } satisfies NativeSessionCleanupReactorShape;
});

export const NativeSessionCleanupReactorLive = Layer.effect(
  NativeSessionCleanupReactor,
  makeNativeSessionCleanupReactor,
);
