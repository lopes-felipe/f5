import type {
  ClientThreadTurnStartCommand,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  TurnSubmissionResult,
} from "@t3tools/contracts";

/**
 * Multi-model fan-out: a new thread's first message, sent to several models at
 * once. Each model gets its own thread, worktree and queue submission, so the
 * agents never share a checkout.
 */
export const MAX_FAN_OUT_MODELS = 6;
export const FAN_OUT_CONCURRENCY = 3;

export interface FanOutModel {
  readonly instanceId: ProviderInstanceId;
  readonly driver: ProviderDriverKind;
  readonly model: string;
}

export const sameFanOutModel = (left: FanOutModel, right: FanOutModel) =>
  left.instanceId === right.instanceId && left.model === right.model;

/**
 * Shift-click toggles a model. The first toggle seeds the selection with the
 * composer's current model, and the selection is capped. A single remaining
 * model is just a normal selection, which the caller applies.
 */
export function toggleFanOutModel(
  selection: ReadonlyArray<FanOutModel>,
  current: FanOutModel,
  toggled: FanOutModel,
): ReadonlyArray<FanOutModel> {
  const seeded = selection.length === 0 ? [current] : selection;
  if (seeded.some((entry) => sameFanOutModel(entry, toggled))) {
    return seeded.filter((entry) => !sameFanOutModel(entry, toggled));
  }
  if (seeded.length >= MAX_FAN_OUT_MODELS) return seeded;
  return [...seeded, toggled];
}

/** Guards a retry from starting a second thread for a model that already started. */
export const fanOutGuardKey = (draftThreadId: ThreadId, target: FanOutModel) =>
  `${draftThreadId}\u0000${target.instanceId}\u0000${target.model}`;

export interface FanOutOutcome {
  readonly started: ReadonlyArray<{ readonly target: FanOutModel; readonly threadId: ThreadId }>;
  readonly failed: ReadonlyArray<{ readonly target: FanOutModel; readonly message: string }>;
  readonly skipped: ReadonlyArray<FanOutModel>;
}

/** A submission whose outcome is unknown, kept so a retry resends the same one. */
export interface FanOutAttempt {
  readonly threadId: ThreadId;
  readonly command: ClientThreadTurnStartCommand;
}

export async function runFanOut(input: {
  readonly draftThreadId: ThreadId;
  readonly targets: ReadonlyArray<FanOutModel>;
  /** Keys of models that already started for this draft; updated in place on success. */
  readonly guard: Set<string>;
  /**
   * Submissions sent but not confirmed, by guard key; updated in place. When a
   * response is lost the server may still have started the thread, so a retry
   * resends the identical command (same thread and submission id), which the
   * server replays instead of starting a second agent.
   */
  readonly attempts: Map<string, FanOutAttempt>;
  /** True when `error` proves the submission did not start a thread. */
  readonly isDefinitelyNotStarted: (error: unknown) => boolean;
  readonly newThreadId: () => ThreadId;
  readonly buildCommand: (
    target: FanOutModel,
    threadId: ThreadId,
  ) => Promise<ClientThreadTurnStartCommand>;
  readonly submit: (command: ClientThreadTurnStartCommand) => Promise<TurnSubmissionResult>;
  readonly concurrency?: number;
}): Promise<FanOutOutcome> {
  const started: Array<{ target: FanOutModel; threadId: ThreadId }> = [];
  const failed: Array<{ target: FanOutModel; message: string }> = [];
  const skipped: FanOutModel[] = [];
  const pending = input.targets.filter((target) => {
    if (input.guard.has(fanOutGuardKey(input.draftThreadId, target))) {
      skipped.push(target);
      return false;
    }
    return true;
  });
  let next = 0;
  const worker = async () => {
    while (next < pending.length) {
      const target = pending[next++]!;
      const key = fanOutGuardKey(input.draftThreadId, target);
      let attempt = input.attempts.get(key);
      try {
        if (!attempt) {
          const threadId = input.newThreadId();
          attempt = { threadId, command: await input.buildCommand(target, threadId) };
          input.attempts.set(key, attempt);
        }
        let result: TurnSubmissionResult;
        try {
          result = await input.submit(attempt.command);
        } catch (error) {
          // Keep the attempt unless the server proved nothing started.
          if (input.isDefinitelyNotStarted(error)) input.attempts.delete(key);
          throw error;
        }
        if (
          result.disposition === "canceled" ||
          result.disposition === "cleared" ||
          result.disposition === "rejected"
        ) {
          input.attempts.delete(key);
          throw new Error(result.detail ?? `The ${target.model} thread was not started.`);
        }
        input.attempts.delete(key);
        input.guard.add(key);
        started.push({ target, threadId: attempt.threadId });
      } catch (error) {
        failed.push({
          target,
          message: error instanceof Error ? error.message : "The thread was not started.",
        });
      }
    }
  };
  await Promise.all(
    Array.from(
      { length: Math.max(1, Math.min(input.concurrency ?? FAN_OUT_CONCURRENCY, pending.length)) },
      worker,
    ),
  );
  return { started, failed, skipped };
}
