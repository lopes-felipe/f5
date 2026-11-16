import { createHash } from "node:crypto";
import { ComputerControlError } from "@t3tools/shared/computerControl";

/** Admission belongs to the transport invocation, not to an individual broker attempt.
 * Completed IDs are tombstones: a late transport retry must observe again, never repeat input.
 */
export class ComputerToolDispatcher {
  private readonly invocations = new Map<string, { hash: string; pending?: Promise<unknown> }>();
  invalidate(): void {
    for (const entry of this.invocations.values()) delete entry.pending;
  }
  async dispatch<T>(id: string, payload: unknown, call: () => Promise<T>): Promise<T> {
    if (Buffer.byteLength(id) > 512) throw new ComputerControlError({ _tag: "ReplayRejected" });
    const hash = createHash("sha256").update(JSON.stringify(payload)).digest("hex");
    const existing = this.invocations.get(id);
    if (existing) {
      if (existing.hash !== hash) throw new ComputerControlError({ _tag: "PayloadMismatch" });
      if (existing.pending) return existing.pending as Promise<T>;
      throw new ComputerControlError({ _tag: "ReplayRejected" });
    }
    if (this.invocations.size >= 65536) throw new ComputerControlError({ _tag: "ReplayRejected" });
    const admitted: { hash: string; pending?: Promise<unknown> } = { hash };
    this.invocations.set(id, admitted);
    const pending = Promise.resolve().then(call);
    admitted.pending = pending;
    try {
      return await pending;
    } finally {
      // Discard model-facing results; nothing sensitive is cached at this boundary.
      delete admitted.pending;
    }
  }
}
