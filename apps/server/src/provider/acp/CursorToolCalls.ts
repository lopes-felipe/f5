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

export interface CursorInterruptedToolCall<TurnId> {
  readonly toolCall: AcpToolCallState;
  readonly turnId: TurnId | undefined;
}

/**
 * Tool calls Cursor has not reported finished, each with the turn that
 * started it. A backgrounded command can outlive that turn, so its later
 * updates keep the originating turn instead of whichever turn is active (or
 * none, while the thread is idle). A stopped or failed turn closes only its
 * own tools as interrupted, so no card spins forever.
 */
export class CursorOpenToolCalls<TurnId = string> {
  readonly #open = new Map<string, { toolCall: AcpToolCallState; turnId: TurnId | undefined }>();

  /**
   * Records the update and returns the turn it belongs to: the turn that
   * opened the tool, or `activeTurnId` for a tool not seen before.
   */
  observe(toolCall: AcpToolCallState, activeTurnId: TurnId | undefined): TurnId | undefined {
    const turnId = this.#open.get(toolCall.toolCallId)?.turnId ?? activeTurnId;
    if (toolCall.status === "completed" || toolCall.status === "failed")
      this.#open.delete(toolCall.toolCallId);
    else this.#open.set(toolCall.toolCallId, { toolCall, turnId });
    return turnId;
  }

  /**
   * Returns the interrupted closures of the tools `turnId` opened, or of every
   * open tool when `turnId` is omitted (the session itself ended), and forgets
   * them.
   */
  drainInterrupted(turnId?: TurnId): ReadonlyArray<CursorInterruptedToolCall<TurnId>> {
    const closed: Array<CursorInterruptedToolCall<TurnId>> = [];
    for (const [id, entry] of this.#open) {
      if (turnId !== undefined && entry.turnId !== turnId) continue;
      this.#open.delete(id);
      closed.push({
        turnId: entry.turnId,
        toolCall: {
          ...entry.toolCall,
          status: "failed",
          detail: "Interrupted before the tool reported completion.",
        },
      });
    }
    return closed;
  }
}
