/** Optional correctness scenarios after the production browser's measurements. */
import { Effect, Schema } from "effect";
import { OrchestrationEvent, ThreadId, TurnId } from "@t3tools/contracts";
import type { createBrowserFixture } from "../../../../scripts/lib/performance/browserFixture.ts";
import { SMALL_THREAD } from "../../../../scripts/lib/performance/browserFixture.ts";
import {
  isControlCommand,
  makeCommandAdmission,
} from "../../src/orchestration/commandAdmission.ts";

export const makeBrowserLifecycle = (
  fixture: ReturnType<typeof createBrowserFixture>,
  publish: (event: OrchestrationEvent) => Promise<void>,
) =>
  Effect.gen(function* () {
    const admission = yield* makeCommandAdmission<Record<string, unknown>>();
    const thread = fixture.threads.find((thread) => thread.id === SMALL_THREAD)!;
    let sequence = (
      fixture.rpc({ _tag: "orchestration.getLatestSequence" }) as { latestSequence: number }
    ).latestSequence;
    let turn = 0;
    const applied: Record<string, number> = {};
    const event = (type: string, payload: unknown) =>
      Schema.decodeUnknownSync(OrchestrationEvent)({
        sequence: (sequence = fixture.nextSequence()),
        eventId: `lifecycle-${sequence}`,
        aggregateKind: "thread",
        aggregateId: thread.id,
        occurredAt: new Date().toISOString(),
        commandId: null,
        causationEventId: null,
        correlationId: null,
        metadata: {},
        type,
        payload,
      });
    const session = async (status: "running" | "error" | "stopped") => {
      const now = new Date().toISOString();
      thread.session = {
        ...thread.session,
        status,
        activeTurnId: status === "running" ? `lifecycle-turn-${turn}` : null,
        lastError:
          status === "error" ? "Provider crashed during the turn. Retry when ready." : null,
        updatedAt: now,
      };
      if (status === "running")
        thread.latestTurn = {
          turnId: TurnId.make(`lifecycle-turn-${turn}`),
          state: "running",
          requestedAt: now,
          startedAt: now,
          completedAt: null,
          assistantMessageId: null,
        };
      else if (thread.latestTurn)
        thread.latestTurn = {
          ...thread.latestTurn,
          state: status === "error" ? "error" : "interrupted",
          completedAt: now,
        };
      await publish(event("thread.session-set", { threadId: thread.id, session: thread.session }));
    };
    const activity = async (resolved: boolean) => {
      const pushed = event("thread.activity-appended", {
        threadId: thread.id,
        activity: {
          id: `lifecycle-approval-${sequence + 1}`,
          createdAt: new Date().toISOString(),
          tone: "approval",
          kind: resolved ? "approval.resolved" : "approval.requested",
          summary: resolved ? "Approved" : "Command approval requested",
          payload: {
            requestId: "lifecycle-approval",
            requestKind: "command",
            requestType: "command_execution_approval",
            ...(resolved ? { decision: "accept" } : { detail: "echo lifecycle" }),
          },
          turnId: `lifecycle-turn-${turn}`,
        },
      });
      if (pushed.type !== "thread.activity-appended") throw new Error("Invalid lifecycle activity");
      thread.activities.push(pushed.payload.activity);
      await publish(pushed);
    };
    const stats = () => ({ ...admission.snapshot(), applied: { ...applied } });
    return {
      stats,
      async control(command: string) {
        switch (command) {
          case "start":
            turn++;
            await session("running");
            break;
          case "approval":
            await activity(false);
            break;
          case "crash":
            await session("error");
            break;
          case "saturate": {
            for (let index = 0; index < 1024; index++)
              await Effect.runPromise(admission.offer({ type: "ordinary", index }, 32, false));
            const overflow = await Effect.runPromise(
              Effect.exit(admission.offer({ type: "overflow" }, 32, false)),
            );
            if (overflow._tag !== "Failure") throw new Error("Ordinary admission did not fill");
            break;
          }
          case "reset":
            await Effect.runPromise(admission.cancelQueued(() => true));
            break;
          default:
            throw new Error(`Unknown lifecycle control ${command}`);
        }
        return stats();
      },
      async dispatch(command: Record<string, unknown>) {
        const type = String(command.type);
        if (command.threadId !== ThreadId.make(SMALL_THREAD))
          throw new Error("Wrong lifecycle thread");
        if (!isControlCommand({ type: type as Parameters<typeof isControlCommand>[0]["type"] }))
          throw new Error("Expected a control command");
        await Effect.runPromise(
          admission.offer(command, Buffer.byteLength(JSON.stringify(command)), true),
        );
        const selected = await Effect.runPromise(admission.take);
        if (selected !== command) throw new Error("Control was hidden behind ordinary admission");
        try {
          if (type === "thread.turn.interrupt") await session("stopped");
          else if (type === "thread.approval.respond") {
            if (command.requestId !== "lifecycle-approval" || command.decision !== "accept")
              throw new Error("Wrong approval identity");
            await activity(true);
          } else throw new Error(`Unexpected lifecycle command ${type}`);
          applied[type] = (applied[type] ?? 0) + 1;
          return { sequence };
        } finally {
          await Effect.runPromise(admission.release(command));
        }
      },
    };
  });
