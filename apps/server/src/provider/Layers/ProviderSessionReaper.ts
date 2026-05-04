import { Clock, Duration, Effect, Layer, Option, Schedule } from "effect";

import { OrchestrationEngineService } from "../../orchestration/Services/OrchestrationEngine.ts";
import {
  ProviderSessionDirectory,
  type ProviderRuntimeBindingWithMetadata,
} from "../Services/ProviderSessionDirectory.ts";
import {
  ProviderSessionReaper,
  type ProviderSessionReaperShape,
} from "../Services/ProviderSessionReaper.ts";
import { ProviderService } from "../Services/ProviderService.ts";

const DEFAULT_INACTIVITY_THRESHOLD_MS = 30 * 60 * 1000;
const DEFAULT_SWEEP_INTERVAL_MS = 5 * 60 * 1000;
const DEFAULT_STOP_TIMEOUT_MS = 10 * 1000;

export interface ProviderSessionReaperLiveOptions {
  readonly inactivityThresholdMs?: number;
  readonly sweepIntervalMs?: number;
  readonly stopTimeoutMs?: number;
}

const makeProviderSessionReaper = (options?: ProviderSessionReaperLiveOptions) =>
  Effect.gen(function* () {
    const providerService = yield* ProviderService;
    const directory = yield* ProviderSessionDirectory;
    const orchestrationEngine = yield* OrchestrationEngineService;

    const inactivityThresholdMs = Math.max(
      1,
      options?.inactivityThresholdMs ?? DEFAULT_INACTIVITY_THRESHOLD_MS,
    );
    const sweepIntervalMs = Math.max(1, options?.sweepIntervalMs ?? DEFAULT_SWEEP_INTERVAL_MS);
    const stopTimeoutMs = Math.max(1, options?.stopTimeoutMs ?? DEFAULT_STOP_TIMEOUT_MS);

    const bindingMatches = (
      initial: ProviderRuntimeBindingWithMetadata,
      current: ProviderRuntimeBindingWithMetadata,
    ) =>
      current.provider === initial.provider &&
      current.status === initial.status &&
      current.lastSeenAt === initial.lastSeenAt;

    const isStillSafeToStop = (binding: ProviderRuntimeBindingWithMetadata) =>
      Effect.gen(function* () {
        const currentBinding = yield* directory.getBinding(binding.threadId);
        if (Option.isNone(currentBinding)) {
          return false;
        }

        if (!bindingMatches(binding, currentBinding.value)) {
          yield* Effect.logDebug("provider.session.reaper.skipped-changed-binding", {
            threadId: binding.threadId,
            provider: binding.provider,
            initialStatus: binding.status ?? null,
            currentStatus: currentBinding.value.status ?? null,
            initialLastSeenAt: binding.lastSeenAt,
            currentLastSeenAt: currentBinding.value.lastSeenAt,
          });
          return false;
        }

        const latestReadModel = yield* orchestrationEngine.getReadModel();
        const latestThread = latestReadModel.threads.find(
          (thread) => thread.id === binding.threadId,
        );
        if (latestThread?.session?.activeTurnId != null) {
          yield* Effect.logDebug("provider.session.reaper.skipped-active-turn", {
            threadId: binding.threadId,
            activeTurnId: latestThread.session.activeTurnId,
          });
          return false;
        }

        return true;
      });

    const sweep: ProviderSessionReaperShape["sweep"] = () =>
      Effect.gen(function* () {
        const readModel = yield* orchestrationEngine.getReadModel();
        const threadsById = new Map(readModel.threads.map((thread) => [thread.id, thread]));
        const bindings = yield* directory.listBindings();
        const now = yield* Clock.currentTimeMillis;
        let reapedCount = 0;

        for (const binding of bindings) {
          if (binding.status === "stopped") {
            continue;
          }

          const lastSeenMs = Date.parse(binding.lastSeenAt);
          if (Number.isNaN(lastSeenMs)) {
            yield* Effect.logWarning("provider.session.reaper.invalid-last-seen", {
              threadId: binding.threadId,
              provider: binding.provider,
              lastSeenAt: binding.lastSeenAt,
            });
            continue;
          }

          const idleDurationMs = now - lastSeenMs;
          if (idleDurationMs < inactivityThresholdMs) {
            continue;
          }

          const thread = threadsById.get(binding.threadId);
          if (thread?.session?.activeTurnId != null) {
            yield* Effect.logDebug("provider.session.reaper.skipped-active-turn", {
              threadId: binding.threadId,
              activeTurnId: thread.session.activeTurnId,
              idleDurationMs,
            });
            continue;
          }

          const stillSafeToStop = yield* isStillSafeToStop(binding);
          if (!stillSafeToStop) {
            continue;
          }

          const reaped = yield* providerService.stopSession({ threadId: binding.threadId }).pipe(
            Effect.timeoutOption(stopTimeoutMs),
            Effect.matchEffect({
              onFailure: (error) =>
                Effect.logWarning("provider.session.reaper.stop-failed", {
                  threadId: binding.threadId,
                  provider: binding.provider,
                  idleDurationMs,
                  error,
                }).pipe(Effect.as(false)),
              onSuccess: (result) =>
                Option.match(result, {
                  onNone: () =>
                    Effect.logWarning("provider.session.reaper.stop-timed-out", {
                      threadId: binding.threadId,
                      provider: binding.provider,
                      idleDurationMs,
                      stopTimeoutMs,
                    }).pipe(Effect.as(false)),
                  onSome: () =>
                    Effect.logInfo("provider.session.reaped", {
                      threadId: binding.threadId,
                      provider: binding.provider,
                      idleDurationMs,
                      reason: "inactivity_threshold",
                    }).pipe(Effect.as(true)),
                }),
            }),
          );

          if (reaped) {
            reapedCount += 1;
          }
        }

        if (reapedCount > 0) {
          yield* Effect.logInfo("provider.session.reaper.sweep-complete", {
            reapedCount,
            totalBindings: bindings.length,
          });
        }
      });

    const start: ProviderSessionReaperShape["start"] = () =>
      Effect.gen(function* () {
        yield* Effect.forkScoped(
          sweep().pipe(
            Effect.catch((error) =>
              Effect.logWarning("provider.session.reaper.sweep-failed", {
                error,
              }),
            ),
            Effect.catchDefect((defect: unknown) =>
              Effect.logWarning("provider.session.reaper.sweep-defect", {
                defect,
              }),
            ),
            Effect.repeat(Schedule.spaced(Duration.millis(sweepIntervalMs))),
          ),
        );

        yield* Effect.logInfo("provider.session.reaper.started", {
          inactivityThresholdMs,
          sweepIntervalMs,
          stopTimeoutMs,
        });
      });

    return {
      sweep,
      start,
    } satisfies ProviderSessionReaperShape;
  });

export const makeProviderSessionReaperLive = (options?: ProviderSessionReaperLiveOptions) =>
  Layer.effect(ProviderSessionReaper, makeProviderSessionReaper(options));

export const ProviderSessionReaperLive = makeProviderSessionReaperLive();
