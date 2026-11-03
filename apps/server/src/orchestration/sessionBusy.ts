import type { OrchestrationReadModel } from "@t3tools/contracts";

export function isBusySession(input: {
  readonly status: string | null;
  readonly activeTurnId: string | null;
}) {
  return input.status === "starting" || input.status === "running" || input.activeTurnId !== null;
}

export function busyThreadIds(model: OrchestrationReadModel): Set<string> {
  return new Set(
    model.threads
      .filter(
        (thread) =>
          thread.deletedAt === null && thread.session !== null && isBusySession(thread.session),
      )
      .map((thread) => thread.id),
  );
}

export function desktopBusyThreadCount(
  model: OrchestrationReadModel,
  pending: readonly string[],
): number {
  const ids = busyThreadIds(model);
  const live = new Set<string>(
    model.threads.filter((thread) => thread.deletedAt === null).map((thread) => thread.id),
  );
  for (const id of pending) if (live.has(id)) ids.add(id);
  return ids.size;
}
