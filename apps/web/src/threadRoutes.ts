import type { OrchestrationThread } from "@t3tools/contracts";

export function resolveThreadRouteRenderState(input: {
  startupReady: boolean;
  threadExists: boolean;
  draftThreadExists: boolean;
  detail:
    | { thread?: Pick<OrchestrationThread, "deletedAt" | "archivedAt"> | null | undefined }
    | undefined;
  detailFetching: boolean;
}): "ready" | "loading" | "missing" {
  if (input.threadExists || input.draftThreadExists) return "ready";
  if (!input.startupReady || input.detailFetching) return "loading";
  const thread = input.detail?.thread;
  // An older server omits metadata. A failed request also cannot prove absence.
  if (thread === undefined) return "loading";
  if (thread === null || thread.deletedAt !== null || thread.archivedAt !== null) return "missing";
  // The detail hook hydrates the shared store before ChatView mounts.
  return "loading";
}
