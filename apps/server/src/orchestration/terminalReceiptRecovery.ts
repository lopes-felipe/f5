import type { ProviderRuntimeEvent } from "@t3tools/contracts";
import { Cause, Effect, Fiber } from "effect";
import type { ProviderTerminalEventRepositoryShape } from "../persistence/Services/ProviderTerminalEvents.ts";
import { registerShutdown } from "../shutdown.ts";

/** Page-sized retries share live ingestion admission and stop with its source. */
export function startTerminalReceiptRetries<E>(
  repository: Pick<ProviderTerminalEventRepositoryShape, "listDue">,
  enqueue: (event: ProviderRuntimeEvent) => Effect.Effect<unknown, E>,
  afterReplay: Effect.Effect<unknown, E> = Effect.void,
) {
  return Effect.gen(function* () {
    const replayDueReceipts = Effect.suspend(() => repository.listDue()).pipe(
      Effect.flatMap((receipts) =>
        Effect.forEach(receipts, (receipt) => enqueue(receipt.event), {
          concurrency: 1,
          discard: true,
        }),
      ),
      Effect.andThen(afterReplay),
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.interrupt
          : Effect.logWarning("failed to retry provider terminal receipts", {
              cause: Cause.pretty(cause),
            }),
      ),
    );
    yield* replayDueReceipts;
    const receiptRetries = yield* replayDueReceipts.pipe(
      Effect.andThen(Effect.sleep("1 second")),
      Effect.forever,
      Effect.forkScoped,
    );
    yield* registerShutdown("terminal-receipt-retries", "admission", () =>
      Fiber.interrupt(receiptRetries),
    );
  });
}
