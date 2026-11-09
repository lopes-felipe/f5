import { ComputerControlError } from "@t3tools/shared/computerControl";
import { computerRemainingBudget } from "./computerDeadline";

export interface CodexHandoff {
  native(deadline: number, check: () => Promise<void>): Promise<void>;
  browser(deadline: number, check: () => Promise<void>): Promise<void>;
  status(): { state: string; nextAction?: string };
}

/** One queue per provider generation. Opposing transitions never overtake each other. */
export class CodexControlHandoff {
  private tail: Promise<void> = Promise.resolve();
  private pending: { target: "native" | "browser"; promise: Promise<void> } | undefined;
  transition: "native" | "browser" | undefined;

  run(target: "native" | "browser", operation: () => Promise<void>): Promise<void> {
    if (this.pending?.target === target) return this.pending.promise;
    const promise = this.tail
      .catch(() => undefined)
      .then(async () => {
        this.transition = target;
        try {
          await operation();
        } finally {
          this.transition = undefined;
        }
      });
    this.tail = promise;
    const pending = { target, promise };
    this.pending = pending;
    void promise
      .finally(() => {
        if (this.pending === pending) this.pending = undefined;
      })
      .catch(() => undefined);
    return promise;
  }
}

/** Checks lifecycle and deadline even when the predicate is already satisfied. */
export async function waitForControl(
  ready: () => boolean | Promise<boolean>,
  deadline: number,
  check: () => Promise<void>,
): Promise<void> {
  for (;;) {
    computerRemainingBudget(deadline);
    await check();
    if (await ready()) {
      computerRemainingBudget(deadline);
      await check();
      computerRemainingBudget(deadline);
      return;
    }
    await new Promise<void>((resolve) =>
      setTimeout(resolve, Math.min(25, computerRemainingBudget(deadline))),
    );
  }
}

export function handoffError(message: string): ComputerControlError {
  return new ComputerControlError({ _tag: "Execution", message });
}
