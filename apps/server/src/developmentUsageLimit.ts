import { CommandId, ThreadId, TurnId } from "@t3tools/contracts";
import { isProtectedAppStateDir } from "@t3tools/shared/appStatePaths";
import { Effect } from "effect";
import type { OrchestrationEngineShape } from "./orchestration/Services/OrchestrationEngine.ts";

/** Explicitly opted-in sandbox simulation, applied after startup reconciliation. */
export const simulateDevelopmentUsageLimit = (
  engine: OrchestrationEngineShape,
  config: { stateDir: string; devUrl: URL | undefined },
) =>
  Effect.gen(function* () {
    const id = process.env.F5_DEV_USAGE_LIMIT_THREAD;
    if (!id) return;
    if (!config.devUrl || isProtectedAppStateDir(config.stateDir))
      return yield* Effect.logWarning("Usage-limit simulation requires an isolated dev server.");
    const thread = (yield* engine.getReadModel()).threads.find((entry) => entry.id === id);
    if (!thread || thread.title !== "Simulated subscription limit" || thread.session?.activeTurnId)
      return yield* Effect.logWarning(
        "Usage-limit simulation target is not an idle sandbox thread.",
      );
    const providerInstanceId =
      thread.session?.providerInstanceId ?? thread.modelSelection?.instanceId;
    if (!providerInstanceId) return;
    const at = new Date().toISOString();
    const resetsAt = new Date(Date.now() + 120000).toISOString();
    const turnId = TurnId.makeUnsafe(`simulated-${crypto.randomUUID()}`);
    yield* engine.dispatch({
      type: "thread.session.set",
      commandId: CommandId.makeUnsafe(crypto.randomUUID()),
      threadId: ThreadId.makeUnsafe(id),
      createdAt: at,
      session: {
        ...thread.session,
        threadId: thread.id,
        providerName: "codex",
        providerInstanceId,
        status: "error",
        runtimeMode: "approval-required",
        activeTurnId: null,
        updatedAt: at,
        lastError: `SIMULATED: Codex usage limit reached. Resets at ${resetsAt}.`,
        lastErrorId: `simulated:${turnId}`,
        lastErrorOccurredAt: at,
        lastErrorRetryability: "retryable",
        usageLimit: {
          windows: [{ id: "primary", label: "5-hour", resetsAt }],
          resetsAt,
          resetSource: "provider",
          evidence: "typed",
          providerInstanceId,
          turnId,
          deliveryId: null,
        },
      },
    });
  });
