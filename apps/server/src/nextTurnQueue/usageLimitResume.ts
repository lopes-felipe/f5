import {
  CommandId,
  MessageId,
  type OrchestrationSession,
  type OrchestrationThread,
  type ThreadId,
} from "@t3tools/contracts";
import { holdsAutomaticResume } from "@t3tools/shared/pendingUserInputs";
import { usageLimitFailureKey } from "@t3tools/shared/usageLimit";
import { ServerSettingsService } from "../serverSettings.ts";
import { executionProviderFingerprintFor } from "../provider/providerConfigurationFingerprint.ts";
import { Effect, Option } from "effect";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { NextTurnQueueStore } from "./Services/NextTurnQueueStore.ts";
import { toNextTurnQueueStorageError } from "./Errors.ts";
import { canonicalRequestHash } from "./canonicalRequestHash.ts";

export const BUFFER_MS = 60_000;
export const MAX_HORIZON_MS = 8 * 24 * 60 * 60_000;
export const MAX_CONSECUTIVE_AUTO_RESUMES = 3;
export const BACKOFF_MS = [60_000, 300_000] as const;
export const MESSAGE = "continue";
export const SCAN_EVERY_SWEEPS = 12;
export const LEDGER_RETENTION_MS = 30 * 24 * 60 * 60_000;

export function usageLimitKey(
  session: Pick<OrchestrationSession, "usageLimit"> | null | undefined,
): string | null {
  return usageLimitFailureKey(session?.usageLimit);
}

export function normalizeTarget(ms: number): string | null {
  return Number.isFinite(ms) && Math.abs(ms) < 8.64e15 ? new Date(ms).toISOString() : null;
}

export const scheduleUsageLimitResumeFor = (input: {
  threadId: ThreadId;
  source: "manual" | "auto";
  notBefore?: string | undefined;
  expectedLimitKey?: string | undefined;
  thread?: OrchestrationThread | undefined;
}) =>
  Effect.gen(function* () {
    const engine = yield* OrchestrationEngineService;
    const store = yield* NextTurnQueueStore;
    const thread =
      input.thread ??
      (yield* engine.getReadModel()).threads.find((entry) => entry.id === input.threadId);
    const limit = thread?.session?.usageLimit;
    const key = usageLimitKey(thread?.session);
    if (!thread || thread.deletedAt || thread.archivedAt || !limit || !key || limit.deliveryId)
      return {
        kind: "ineligible" as const,
        reason: "No interrupted usage-limited turn to continue.",
      };
    if (input.expectedLimitKey && key !== input.expectedLimitKey)
      return {
        kind: "ineligible" as const,
        reason: "The usage limit changed. Refresh and try again.",
      };
    if (
      thread.session?.activeTurnId ||
      thread.session?.status === "running" ||
      thread.session?.status === "starting" ||
      thread.pendingUserInputs?.some(holdsAutomaticResume)
    )
      return { kind: "transient" as const, reason: "The thread is still busy." };
    const now = Date.now();
    const ledger = yield* store.getUsageResumeLedger(input.threadId);
    let target = input.notBefore
      ? Date.parse(input.notBefore)
      : limit.resetsAt
        ? Math.max(now, Date.parse(limit.resetsAt)) + BUFFER_MS
        : NaN;
    const previousTarget = ledger?.previousTarget ?? ledger?.notBefore;
    if (
      !input.notBefore &&
      previousTarget &&
      limit.resetsAt &&
      Date.parse(previousTarget) >= Date.parse(limit.resetsAt)
    )
      target = Math.max(target, now + BACKOFF_MS[(ledger?.autoCount ?? 0) > 1 ? 1 : 0]);
    const notBefore = normalizeTarget(target);
    if (!notBefore)
      return { kind: "ineligible" as const, reason: "Reset time unknown; pick a time." };
    if (target <= now || target > now + MAX_HORIZON_MS)
      return { kind: "ineligible" as const, reason: "Pick a time within the next 8 days." };
    const id = CommandId.makeUnsafe(`usage-resume:${thread.id}:${key}`);
    const command = {
      type: "thread.turn.start" as const,
      commandId: id,
      threadId: thread.id,
      message: {
        messageId: MessageId.makeUnsafe(id),
        role: "user" as const,
        text: MESSAGE,
        attachments: [],
      },
      model: thread.model,
      ...(thread.modelSelection ? { modelSelection: thread.modelSelection } : {}),
      runtimeMode: thread.runtimeMode,
      interactionMode: thread.interactionMode,
      presentation: "continuation" as const,
      createdAt: new Date(now).toISOString(),
    };
    const settingsOption = yield* Effect.serviceOption(ServerSettingsService);
    const settings = Option.isSome(settingsOption)
      ? yield* settingsOption.value.getSettings.pipe(Effect.orElseSucceed(() => null))
      : null;
    const config = settings?.providerInstances[limit.providerInstanceId];
    const result = yield* store.scheduleUsageLimitResume({
      command,
      itemId: id,
      submissionId: id,
      requestHash: canonicalRequestHash(command),
      limitKey: key,
      providerInstanceId: limit.providerInstanceId,
      source: input.source,
      notBefore,
      ...(config
        ? {
            providerFingerprint: yield* executionProviderFingerprintFor(config).pipe(
              Effect.mapError(toNextTurnQueueStorageError),
            ),
          }
        : {}),
    });
    return result === "busy"
      ? { kind: "transient" as const, reason: "The continue is already sending." }
      : { kind: result };
  });
