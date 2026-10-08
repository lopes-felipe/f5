/**
 * Deletes a Claude session's local transcript once its F5 thread is deleted.
 *
 * `thread.deleted` is final (F5 has no undelete; snoozed and archived threads
 * never emit it). The binding is read as soon as the event arrives because
 * storage maintenance purges `provider_session_runtime` for deleted threads
 * shortly after. The transcript is removed from the bound instance's own
 * config dir, and skipped when any other live F5 thread still binds the same
 * Claude session id (a fork or import that resumes it). Every failure is
 * logged and swallowed: cleanup never blocks or fails the deletion.
 *
 * @module NativeSessionCleanupReactor
 */
import {
  defaultInstanceIdForDriver,
  ProviderDriverKind,
  type ProviderInstanceId,
  type ThreadId,
} from "@t3tools/contracts";
import { makeDrainableWorker } from "@t3tools/shared/DrainableWorker";
import { providerRuntimeCapabilities } from "@t3tools/shared/providerRuntimeCapabilities";
import { Cause, Effect, Layer, Option, Stream } from "effect";

import { readClaudeResumeState } from "../../provider/claudeResumeState.ts";
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

export const makeNativeSessionCleanupReactor = Effect.gen(function* () {
  const orchestrationEngine = yield* OrchestrationEngineService;
  const directory = yield* ProviderSessionDirectory;
  const instances = yield* ProviderInstanceRegistry;

  const isSharedWithLiveThread = (job: CleanupJob) =>
    Effect.gen(function* () {
      const [bindings, readModel] = yield* Effect.all([
        directory.listBindings(),
        orchestrationEngine.getReadModel(),
      ]);
      const deleted = new Set(
        readModel.threads.filter((thread) => thread.deletedAt !== null).map((thread) => thread.id),
      );
      // A binding whose thread is missing from the read model counts as live.
      return bindings.some(
        (binding) =>
          binding.threadId !== job.threadId &&
          !deleted.has(binding.threadId) &&
          claudeSessionIdOfBinding(binding) === job.sessionId,
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
        yield* Effect.logInfo("native session cleanup skipped: instance unavailable", {
          threadId: job.threadId,
          instanceId: job.instanceId,
        });
        return;
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

  const worker = yield* makeDrainableWorker(cleanup);

  /** Captures the job synchronously with the event, before storage purges the binding. */
  const captureJob = (threadId: ThreadId) =>
    directory.getBinding(threadId).pipe(
      Effect.map(
        Option.flatMap((binding) => {
          const sessionId = claudeSessionIdOfBinding(binding);
          if (!sessionId || !providerRuntimeCapabilities(CLAUDE_DRIVER).nativeSessionCleanup) {
            return Option.none();
          }
          return Option.some<CleanupJob>({
            threadId,
            sessionId,
            instanceId: binding.providerInstanceId ?? defaultInstanceIdForDriver(CLAUDE_DRIVER),
          });
        }),
      ),
      Effect.catchCause((cause) =>
        Effect.logWarning("native session cleanup could not read the thread binding", {
          threadId,
          cause: Cause.pretty(cause),
        }).pipe(Effect.as(Option.none<CleanupJob>())),
      ),
    );

  const start: NativeSessionCleanupReactorShape["start"] = Stream.runForEach(
    orchestrationEngine.streamDomainEvents,
    (event) =>
      event.type === "thread.deleted"
        ? captureJob(event.payload.threadId).pipe(
            Effect.flatMap(
              Option.match({ onNone: () => Effect.void, onSome: (job) => worker.enqueue(job) }),
            ),
          )
        : Effect.void,
  ).pipe(Effect.forkScoped, Effect.asVoid);

  return { start, drain: worker.drain } satisfies NativeSessionCleanupReactorShape;
});

export const NativeSessionCleanupReactorLive = Layer.effect(
  NativeSessionCleanupReactor,
  makeNativeSessionCleanupReactor,
);
