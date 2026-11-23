import { Effect, type Scope } from "effect";

import type { AcpParsedSessionEvent } from "./AcpRuntimeModel.ts";

/**
 * Whether the agent is visibly working on a prompt: it wrote text or reasoning,
 * started a reply, used a tool or updated its plan. Session-level notices
 * (available commands, mode or usage changes) arrive without a prompt and prove
 * nothing about delivery.
 */
export function isAcpPromptProgress(event: AcpParsedSessionEvent): boolean {
  switch (event._tag) {
    case "ContentDelta":
    case "AssistantItemStarted":
    case "ToolCallUpdated":
    case "PlanUpdated":
      return true;
    default:
      return false;
  }
}

/**
 * Runs the running prompt's acceptance once, then forgets it. Forked so a slow
 * delivery write never holds up the agent's event stream.
 */
export function firePendingAcceptance(ctx: {
  pendingAcceptance: Effect.Effect<void> | undefined;
  readonly scope: Scope.Scope;
}): Effect.Effect<void> {
  const pending = ctx.pendingAcceptance;
  if (pending === undefined) return Effect.void;
  ctx.pendingAcceptance = undefined;
  return pending.pipe(Effect.forkIn(ctx.scope), Effect.asVoid);
}
