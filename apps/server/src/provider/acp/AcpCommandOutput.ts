import {
  RuntimeItemId,
  type EventId,
  type ProviderKind,
  type ProviderRuntimeEvent,
  type ThreadId,
  type TurnId,
} from "@t3tools/contracts";

import type { AcpToolCallState } from "./AcpRuntimeModel.ts";

const MAX_TRACKED_TOOL_CALLS = 256;

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

/**
 * The text an ACP `execute` tool printed. Agents differ: Antigravity sends
 * `rawOutput: { output, exit_code }` (a bare string for denials), Grok sends
 * `{ output, exitCode }`, and some agents only send `content[]` text.
 */
export function acpCommandOutputText(data: Record<string, unknown>): string {
  const rawOutput = data.rawOutput;
  if (typeof rawOutput === "string") return rawOutput;
  const raw = asRecord(rawOutput);
  for (const key of ["output", "stdout", "text"] as const) {
    const value = raw?.[key];
    if (typeof value === "string") return value;
  }
  if (!Array.isArray(data.content)) return "";
  return data.content
    .flatMap((item) => {
      const entry = asRecord(item);
      const content = asRecord(entry?.content);
      return entry?.type === "content" &&
        content?.type === "text" &&
        typeof content.text === "string"
        ? [content.text]
        : [];
    })
    .join("");
}

/**
 * Turns the cumulative output ACP agents resend on every `execute` update
 * into append-only chunks. Output that is rewritten rather than extended
 * (a different prefix) is not emitted again: transcripts only append.
 */
export class AcpCommandOutputTracker {
  readonly #emitted = new Map<string, string>();

  /** The text to append for this update, or undefined when there is none. */
  next(toolCall: AcpToolCallState): string | undefined {
    const id = toolCall.toolCallId;
    const finished = toolCall.status === "completed" || toolCall.status === "failed";
    if (toolCall.kind !== "execute") {
      if (finished) this.#emitted.delete(id);
      return undefined;
    }
    const text = acpCommandOutputText(toolCall.data);
    const previous = this.#emitted.get(id) ?? "";
    let delta: string | undefined;
    if (text.length > previous.length && text.startsWith(previous)) {
      delta = text.slice(previous.length);
      this.#emitted.delete(id);
      this.#emitted.set(id, text);
      if (this.#emitted.size > MAX_TRACKED_TOOL_CALLS)
        this.#emitted.delete(this.#emitted.keys().next().value!);
    }
    if (finished) this.#emitted.delete(id);
    return delta;
  }
}

export function makeAcpCommandOutputEvent(input: {
  readonly stamp: { readonly eventId: EventId; readonly createdAt: string };
  readonly provider: ProviderKind;
  readonly threadId: ThreadId;
  readonly turnId: TurnId | undefined;
  readonly toolCallId: string;
  readonly text: string;
  readonly rawPayload: unknown;
}): ProviderRuntimeEvent {
  return {
    type: "content.delta",
    ...input.stamp,
    provider: input.provider,
    threadId: input.threadId,
    turnId: input.turnId,
    itemId: RuntimeItemId.make(input.toolCallId),
    payload: { streamKind: "command_output", delta: input.text },
    raw: { source: "acp.jsonrpc", method: "session/update", payload: input.rawPayload },
  };
}
