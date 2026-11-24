import { Effect } from "effect";

import type { AcpParsedSessionEvent } from "./AcpRuntimeModel.ts";

const MAX_SEEN_TOOL_CALLS = 4096;

/**
 * Decides whether a session event proves the agent is working on the prompt it
 * was just sent: it wrote text or reasoning, started a reply, started a new
 * tool call or updated its plan.
 *
 * ACP events name no prompt, so a tool call counts only the first time it is
 * seen. A late update of an earlier turn's tool (a trailing completion, a
 * detached child task still reporting) never accepts the next prompt.
 * Session-level notices (available commands, mode or usage changes) prove
 * nothing about delivery.
 *
 * Every event must pass through `observe`, so tool calls are remembered even
 * while no prompt waits for acceptance.
 */
export class AcpPromptProgressGate {
  private readonly seenToolCalls = new Set<string>();

  observe(event: AcpParsedSessionEvent): boolean {
    switch (event._tag) {
      case "ContentDelta":
      case "AssistantItemStarted":
      case "PlanUpdated":
        return true;
      case "ToolCallUpdated": {
        const id = event.toolCall.toolCallId;
        if (this.seenToolCalls.has(id)) return false;
        this.seenToolCalls.add(id);
        if (this.seenToolCalls.size > MAX_SEEN_TOOL_CALLS)
          this.seenToolCalls.delete(this.seenToolCalls.values().next().value!);
        return true;
      }
      default:
        return false;
    }
  }
}

/**
 * Runs the running prompt's acceptance once, then forgets it. The acceptance
 * only starts the delivery write on its own fiber (`ProviderService` joins it
 * when the send settles), so running it inline never holds up the event stream.
 */
export function firePendingAcceptance(ctx: {
  pendingAcceptance: Effect.Effect<void> | undefined;
}): Effect.Effect<void> {
  const pending = ctx.pendingAcceptance;
  if (pending === undefined) return Effect.void;
  ctx.pendingAcceptance = undefined;
  return pending;
}
