import { ComputerControlError } from "@t3tools/shared/computerControl";

export function computerRemainingBudget(deadline: number): number {
  const remaining = Math.floor(deadline - performance.now());
  if (remaining <= 0)
    throw new ComputerControlError({
      _tag: "Execution",
      message: "Computer request timed out before dispatch.",
    });
  return remaining;
}

/** Only race pre-dispatch work or observations. Dispatched mutations need desktop outcomes. */
export async function computerWithinDeadline<A>(
  deadline: number,
  operation: () => Promise<A>,
  signal?: AbortSignal,
): Promise<A> {
  const remaining = computerRemainingBudget(deadline);
  if (signal?.aborted) throw signal.reason;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort = () => {};
  try {
    const result = await Promise.race([
      operation(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new ComputerControlError({
                _tag: "Execution",
                message: "Computer request timed out before dispatch.",
              }),
            ),
          remaining,
        );
        onAbort = () => reject(signal!.reason);
        signal?.addEventListener("abort", onAbort, { once: true });
        if (signal?.aborted) onAbort();
      }),
    ]);
    computerRemainingBudget(deadline);
    if (signal?.aborted) throw signal.reason;
    return result;
  } finally {
    if (timer) clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }
}
