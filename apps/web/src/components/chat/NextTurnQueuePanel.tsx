import type {
  CommandId,
  ModelSlug,
  NextTurnQueueSnapshot,
  ProviderInteractionMode,
  RuntimeMode,
  ThreadId,
} from "@t3tools/contracts";
import {
  ChevronDownIcon,
  ChevronUpIcon,
  LoaderCircleIcon,
  PencilIcon,
  PlayIcon,
  Trash2Icon,
} from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import { readNativeApi } from "~/nativeApi";
import { useWsConnectionState } from "~/wsConnectionState";
import { Button } from "../ui/button";
import { Textarea } from "../ui/textarea";
import { toastManager } from "../ui/toast";

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Failed to update the queued turn.";
}

export interface OptimisticQueuedTurn {
  readonly itemId: CommandId;
  readonly threadId: ThreadId;
  readonly text: string;
  readonly model?: ModelSlug | undefined;
  readonly interactionMode: ProviderInteractionMode;
  readonly runtimeMode: RuntimeMode;
}

export function NextTurnQueuePanel({
  threadId,
  optimisticItem,
  snapshotHint,
}: {
  readonly threadId: ThreadId;
  readonly optimisticItem?: OptimisticQueuedTurn | null | undefined;
  readonly snapshotHint?: NextTurnQueueSnapshot | null | undefined;
}) {
  const connection = useWsConnectionState();
  const [snapshot, setSnapshot] = useState<NextTurnQueueSnapshot | null>(null);
  const [editingItemId, setEditingItemId] = useState<CommandId | null>(null);
  const [editText, setEditText] = useState("");
  const [busyItemId, setBusyItemId] = useState<CommandId | null>(null);

  useEffect(() => {
    const api = readNativeApi();
    if (!api) return;
    let active = true;
    const unsubscribe = api.nextTurnQueue.onUpdated((next) => {
      if (active && next.threadId === threadId) setSnapshot(next);
    });
    if (connection.phase === "connected") {
      void api.nextTurnQueue
        .list({ threadId })
        .then((next) => {
          if (active) setSnapshot(next);
        })
        .catch(() => undefined);
    }
    return () => {
      active = false;
      unsubscribe();
    };
  }, [connection.connectedAt, connection.phase, threadId]);

  useEffect(() => {
    if (snapshotHint?.threadId === threadId) setSnapshot(snapshotHint);
  }, [snapshotHint, threadId]);

  const runMutation = useCallback(
    async (itemId: CommandId, mutation: () => Promise<NextTurnQueueSnapshot>) => {
      setBusyItemId(itemId);
      try {
        setSnapshot(await mutation());
      } catch (error) {
        toastManager.add({ type: "error", title: errorMessage(error) });
      } finally {
        setBusyItemId(null);
      }
    },
    [],
  );

  const items = snapshot?.items ?? [];
  const pendingItem =
    optimisticItem?.threadId === threadId &&
    !items.some((item) => item.itemId === optimisticItem.itemId)
      ? optimisticItem
      : null;
  const itemCount = items.length + Number(pendingItem !== null);
  if (itemCount === 0) return null;

  return (
    <section
      className="mx-auto mb-2 w-full max-w-3xl rounded-xl border border-border/70 bg-card/95 px-2.5 py-2 shadow-sm"
      aria-label="Queued turns"
      aria-live="polite"
    >
      <div className="flex items-center justify-between gap-2 px-1 pb-1.5">
        <span className="font-medium text-xs">
          Next turns <span className="text-muted-foreground">({itemCount})</span>
        </span>
        {snapshot?.blockedReason ? (
          <span className="truncate text-warning-foreground text-xs" title={snapshot.blockedReason}>
            {snapshot.blockedReason}
          </span>
        ) : (
          <span className="text-muted-foreground text-xs">Runs one at a time</span>
        )}
      </div>
      <ol className="space-y-1">
        {pendingItem ? (
          <li className="flex min-w-0 items-center gap-1.5 rounded-lg border border-primary/25 bg-primary/5 p-2">
            <LoaderCircleIcon className="size-3.5 shrink-0 animate-spin text-primary" />
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm" title={pendingItem.text}>
                {pendingItem.text}
              </p>
              <p className="truncate text-primary/80 text-[11px]">
                Adding to queue…
                {pendingItem.model ? ` · ${pendingItem.model}` : ""}
                {` · ${pendingItem.interactionMode} · ${pendingItem.runtimeMode}`}
              </p>
            </div>
          </li>
        ) : null}
        {items.map((item, index) => {
          const busy = busyItemId === item.itemId;
          const editing = editingItemId === item.itemId;
          return (
            <li
              key={item.itemId}
              className="rounded-lg border border-border/55 bg-background/55 p-2"
            >
              {editing ? (
                <div className="space-y-2">
                  <Textarea
                    size="sm"
                    value={editText}
                    onChange={(event) => setEditText(event.currentTarget.value)}
                    aria-label="Queued turn text"
                    autoFocus
                  />
                  <div className="flex justify-end gap-1.5">
                    <Button
                      type="button"
                      variant="ghost"
                      size="xs"
                      onClick={() => setEditingItemId(null)}
                    >
                      Cancel
                    </Button>
                    <Button
                      type="button"
                      size="xs"
                      disabled={busy || editText.trim().length === 0}
                      onClick={() =>
                        void runMutation(item.itemId, async () => {
                          const api = readNativeApi();
                          if (!api) throw new Error("Server connection is unavailable.");
                          const next = await api.nextTurnQueue.update({
                            itemId: item.itemId,
                            text: editText,
                            expectedUpdatedAt: item.updatedAt,
                          });
                          setEditingItemId(null);
                          return next;
                        })
                      }
                    >
                      Save
                    </Button>
                  </div>
                </div>
              ) : (
                <div className="flex min-w-0 items-center gap-1.5">
                  <span className="w-5 shrink-0 text-center text-muted-foreground text-xs">
                    {index + 1}
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm" title={item.command.message.text}>
                      {item.command.message.text}
                    </p>
                    <p className="truncate text-muted-foreground text-[11px]">
                      {item.status === "paused" ? (item.lastError ?? "Paused") : "Queued"}
                      {item.command.model ? ` · ${item.command.model}` : ""}
                      {` · ${item.command.interactionMode} · ${item.command.runtimeMode}`}
                    </p>
                  </div>
                  {item.status === "paused" ? (
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-xs"
                      disabled={busy}
                      aria-label="Resume queued turn"
                      onClick={() =>
                        void runMutation(item.itemId, async () => {
                          const api = readNativeApi();
                          if (!api) throw new Error("Server connection is unavailable.");
                          return api.nextTurnQueue.resume({ itemId: item.itemId });
                        })
                      }
                    >
                      <PlayIcon />
                    </Button>
                  ) : null}
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-xs"
                    disabled={busy}
                    aria-label="Edit queued turn"
                    onClick={() => {
                      setEditingItemId(item.itemId);
                      setEditText(item.command.message.text);
                    }}
                  >
                    <PencilIcon />
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-xs"
                    disabled={busy || index === 0}
                    aria-label="Move queued turn up"
                    onClick={() => {
                      const orderedItemIds = items.map((candidate) => candidate.itemId);
                      [orderedItemIds[index - 1], orderedItemIds[index]] = [
                        orderedItemIds[index]!,
                        orderedItemIds[index - 1]!,
                      ];
                      void runMutation(item.itemId, async () => {
                        const api = readNativeApi();
                        if (!api) throw new Error("Server connection is unavailable.");
                        return api.nextTurnQueue.reorder({ threadId, orderedItemIds });
                      });
                    }}
                  >
                    <ChevronUpIcon />
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-xs"
                    disabled={busy || index === items.length - 1}
                    aria-label="Move queued turn down"
                    onClick={() => {
                      const orderedItemIds = items.map((candidate) => candidate.itemId);
                      [orderedItemIds[index], orderedItemIds[index + 1]] = [
                        orderedItemIds[index + 1]!,
                        orderedItemIds[index]!,
                      ];
                      void runMutation(item.itemId, async () => {
                        const api = readNativeApi();
                        if (!api) throw new Error("Server connection is unavailable.");
                        return api.nextTurnQueue.reorder({ threadId, orderedItemIds });
                      });
                    }}
                  >
                    <ChevronDownIcon />
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-xs"
                    disabled={busy}
                    aria-label="Cancel queued turn"
                    onClick={() =>
                      void runMutation(item.itemId, async () => {
                        const api = readNativeApi();
                        if (!api) throw new Error("Server connection is unavailable.");
                        return api.nextTurnQueue.cancel({ itemId: item.itemId });
                      })
                    }
                  >
                    <Trash2Icon />
                  </Button>
                </div>
              )}
            </li>
          );
        })}
      </ol>
    </section>
  );
}
