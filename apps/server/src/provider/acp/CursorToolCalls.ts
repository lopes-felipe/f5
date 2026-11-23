import type { AcpToolCallState } from "./AcpRuntimeModel.ts";

function nonZeroExitCode(rawOutput: unknown): number | undefined {
  if (!rawOutput || typeof rawOutput !== "object" || Array.isArray(rawOutput)) return undefined;
  const record = rawOutput as Record<string, unknown>;
  const code = record.exitCode ?? record.exit_code;
  return typeof code === "number" && Number.isFinite(code) && code !== 0 ? code : undefined;
}

/** Cursor reports a shell command that exited non-zero as `completed`; F5 shows it as failed. */
export function cursorToolCallWithExitStatus(toolCall: AcpToolCallState): AcpToolCallState {
  if (toolCall.status !== "completed" || toolCall.kind !== "execute") return toolCall;
  const code = nonZeroExitCode(toolCall.data.rawOutput);
  if (code === undefined) return toolCall;
  return {
    ...toolCall,
    status: "failed",
    detail: toolCall.detail ?? `Exited with code ${code}.`,
  };
}

/**
 * Tool calls still open in the current turn. A turn that ends while Cursor
 * never completed a tool closes that tool as interrupted, so no card spins
 * forever.
 */
export class CursorOpenToolCalls {
  readonly #open = new Map<string, AcpToolCallState>();

  observe(toolCall: AcpToolCallState): void {
    if (toolCall.status === "completed" || toolCall.status === "failed")
      this.#open.delete(toolCall.toolCallId);
    else this.#open.set(toolCall.toolCallId, toolCall);
  }

  /** Returns the interrupted closures and forgets them. */
  drainInterrupted(): ReadonlyArray<AcpToolCallState> {
    const closed = [...this.#open.values()].map(
      (toolCall): AcpToolCallState => ({
        ...toolCall,
        status: "failed",
        detail: "Interrupted before the tool reported completion.",
      }),
    );
    this.#open.clear();
    return closed;
  }
}
