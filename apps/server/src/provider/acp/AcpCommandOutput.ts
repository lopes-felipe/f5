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
  if (typeof rawOutput === "string" && rawOutput) return rawOutput;
  const raw = asRecord(rawOutput);
  for (const key of ["output", "stdout", "text"] as const) {
    const value = raw?.[key];
    if (typeof value === "string" && value) return value;
  }
  if (!Array.isArray(data.content)) return "";
  // Separate content blocks are separate pieces of text, never one line.
  return data.content
    .flatMap((item) => {
      const entry = asRecord(item);
      const content = asRecord(entry?.content);
      return entry?.type === "content" &&
        content?.type === "text" &&
        typeof content.text === "string" &&
        content.text
        ? [content.text]
        : [];
    })
    .join("\n");
}

/** What `AcpRuntimeModel` puts before the kept tail of output over its bound. */
export const ACP_OUTPUT_TRUNCATION_MARKER = "[Earlier output truncated]\n\n";
/** Kept per tool call to bridge a truncated update; above the runtime's 8,000-character tail. */
const EMITTED_TAIL_CHARS = 16_000;

/** The longest prefix of `next` that `previous` ends with (KMP failure function). */
function overlap(previous: string, next: string): number {
  const window = previous.slice(-next.length);
  const text = `${next}\u0000${window}`;
  const failure = new Array<number>(text.length).fill(0);
  for (let index = 1; index < text.length; index++) {
    let length = failure[index - 1]!;
    while (length > 0 && text[index] !== text[length]) length = failure[length - 1]!;
    if (text[index] === text[length]) length++;
    failure[index] = length;
  }
  return failure[text.length - 1]!;
}

interface TrackedOutput {
  /** The end of the raw text emitted so far, for comparing with the next update. */
  readonly emittedTail: string;
  /** Raw text received but held back, because it may start a registered credential. */
  readonly held: string;
}

/**
 * Turns the cumulative output ACP agents resend on every `execute` update
 * into append-only chunks.
 *
 * - Output that is rewritten rather than extended (a different prefix) is not
 *   emitted again: transcripts only append.
 * - Past the runtime's bound, an update carries only the truncation marker and
 *   the output's tail. The tail is matched against what was emitted, so only
 *   new text is appended; when the two no longer overlap, a truncation notice
 *   precedes the tail. Identical repeated lines at the seam can be taken as
 *   already emitted.
 * - Credentials are scrubbed from each published event as a whole. Text at
 *   the end of an update that could be the start of a registered credential
 *   (`holdback`) is held until the next update or the end of the command, so a
 *   credential is never split across two chunks that each look harmless.
 */
export class AcpCommandOutputTracker {
  readonly #tracked = new Map<string, TrackedOutput>();

  constructor(
    /** How many trailing characters of `text` could begin a registered credential. */
    private readonly holdback: (text: string) => number = () => 0,
  ) {}

  /** The text to append for this update, or undefined when there is none. */
  next(toolCall: AcpToolCallState): string | undefined {
    const id = toolCall.toolCallId;
    const finished = toolCall.status === "completed" || toolCall.status === "failed";
    if (toolCall.kind !== "execute") {
      if (finished) this.#tracked.delete(id);
      return undefined;
    }
    const text = acpCommandOutputText(toolCall.data);
    const state = this.#tracked.get(id) ?? { emittedTail: "", held: "" };
    // Everything received so far: what was emitted, then what was held back.
    const received = state.emittedTail + state.held;
    let fresh = "";
    if (text.startsWith(ACP_OUTPUT_TRUNCATION_MARKER)) {
      const tail = text.slice(ACP_OUTPUT_TRUNCATION_MARKER.length);
      const shared = overlap(received, tail);
      fresh =
        shared > 0 || received.length === 0
          ? tail.slice(shared)
          : `\n${ACP_OUTPUT_TRUNCATION_MARKER}${tail}`;
    } else if (text.length > received.length && text.startsWith(received)) {
      fresh = text.slice(received.length);
    }
    const pending = state.held + fresh;
    const keep = finished ? 0 : Math.min(pending.length, Math.max(0, this.holdback(pending)));
    const delta = pending.slice(0, pending.length - keep);
    if (finished) this.#tracked.delete(id);
    else {
      this.#tracked.delete(id);
      this.#tracked.set(id, {
        emittedTail: (state.emittedTail + delta).slice(-EMITTED_TAIL_CHARS),
        held: pending.slice(pending.length - keep),
      });
      if (this.#tracked.size > MAX_TRACKED_TOOL_CALLS)
        this.#tracked.delete(this.#tracked.keys().next().value!);
    }
    return delta ? delta : undefined;
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
