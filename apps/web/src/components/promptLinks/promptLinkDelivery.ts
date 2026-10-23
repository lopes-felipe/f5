import type { HistoryState } from "@tanstack/react-router";

/**
 * History state that marks one delivery of a prompt link. Opening the same link again would
 * otherwise reach the router as the same location, which it does not navigate to again, so the
 * link view could not tell that the user asked for it a second time.
 */
export function promptLinkDeliveryState(): HistoryState {
  return { promptLinkDelivery: crypto.randomUUID() } as HistoryState;
}

export function readPromptLinkDelivery(state: unknown): string | null {
  const delivery = (state as { promptLinkDelivery?: unknown } | null)?.promptLinkDelivery;
  return typeof delivery === "string" ? delivery : null;
}
