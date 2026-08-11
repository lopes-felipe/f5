import type {
  CommandId,
  CompactRuntimeConfiguredActivityPayload,
  NextTurnQueueItem,
  ProjectSkill,
  ProviderKind,
  ThreadId,
} from "@t3tools/contracts";
import {
  DndContext,
  PointerSensor,
  closestCorners,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import { restrictToFirstScrollableAncestor, restrictToVerticalAxis } from "@dnd-kit/modifiers";
import { SortableContext, verticalListSortingStrategy } from "@dnd-kit/sortable";
import {
  ChevronDownIcon,
  ChevronUpIcon,
  LoaderCircleIcon,
  PauseIcon,
  PlayIcon,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { readNativeApi } from "~/nativeApi";
import { rewriteComposerRuntimeSkillInvocationForSend } from "../ChatView.logic";
import { EMPTY_QUEUE_THREAD_STATE, useNextTurnQueueStore } from "~/nextTurnQueueStore";
import { useWsConnectionState } from "~/wsConnectionState";
import { Button } from "../ui/button";
import { toastManager } from "../ui/toast";
import {
  deriveQueueAnnouncement,
  describeQueueBlockedState,
  moveItemInOrder,
} from "./NextTurnQueuePanel.logic";
import { NextTurnQueueRow } from "./NextTurnQueueRow";

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Failed to update the queued turn.";
}

function rebuildEditedText(item: NextTurnQueueItem, visibleText: string): string {
  const current = item.command.message.text;
  const displayed = item.command.message.text.trim().length > 0 ? current : "";
  const existingVisible =
    displayed.length > 0
      ? current.slice(0, current.length - (current.length - current.trimEnd().length))
      : "";
  const terminalMarker = current.search(/\n*<terminal_context>|\n*<attached_files>/u);
  if (terminalMarker >= 0) return `${visibleText.trim()}${current.slice(terminalMarker)}`;
  return existingVisible === current ? visibleText.trim() : `${visibleText.trim()}\n`;
}

export function NextTurnQueuePanel({
  threadId,
  provider,
  runtimeSlashCommands,
  projectSkills,
}: {
  readonly threadId: ThreadId;
  readonly provider?: ProviderKind | null;
  readonly runtimeSlashCommands?: CompactRuntimeConfiguredActivityPayload["slashCommands"] | null;
  readonly projectSkills?: ReadonlyArray<ProjectSkill> | null | undefined;
}) {
  const connection = useWsConnectionState();
  const state = useNextTurnQueueStore(
    (store) => store.byThreadId[threadId] ?? EMPTY_QUEUE_THREAD_STATE,
  );
  const applySnapshot = useNextTurnQueueStore((store) => store.applySnapshot);
  const setHydrationError = useNextTurnQueueStore((store) => store.setHydrationError);
  const setPendingOrder = useNextTurnQueueStore((store) => store.setPendingOrder);
  const setItemBusy = useNextTurnQueueStore((store) => store.setItemBusy);
  const [collapsed, setCollapsed] = useState(false);
  const [announcement, setAnnouncement] = useState("");
  const previousSnapshotRef = useRef(state.snapshot);
  const watchdogRef = useRef<number | null>(null);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));

  const load = useCallback(async () => {
    const api = readNativeApi();
    if (!api?.nextTurnQueue) return;
    try {
      applySnapshot(await api.nextTurnQueue.list({ threadId }));
    } catch (error) {
      setHydrationError(threadId, errorMessage(error));
    }
  }, [applySnapshot, setHydrationError, threadId]);

  useEffect(() => {
    if (connection.phase === "connected") void load();
  }, [connection.connectedAt, connection.phase, load]);

  useEffect(() => {
    const snapshot = state.snapshot;
    if (!snapshot) return;
    const next = deriveQueueAnnouncement(previousSnapshotRef.current, snapshot);
    previousSnapshotRef.current = snapshot;
    if (!next) return;
    const timeout = window.setTimeout(() => setAnnouncement(next), 400);
    return () => window.clearTimeout(timeout);
  }, [state.snapshot]);

  useEffect(() => {
    if (state.snapshot?.paused || state.snapshot?.blockedKind === "error") setCollapsed(false);
  }, [state.snapshot?.blockedKind, state.snapshot?.paused]);

  useEffect(
    () => () => {
      if (watchdogRef.current !== null) window.clearTimeout(watchdogRef.current);
    },
    [],
  );

  const runItemMutation = useCallback(
    async (item: NextTurnQueueItem, mutation: () => Promise<void>) => {
      setItemBusy(threadId, item.itemId, true);
      try {
        await mutation();
      } catch (error) {
        setPendingOrder(threadId, null);
        toastManager.add({ type: "error", title: errorMessage(error) });
        void load();
      } finally {
        setItemBusy(threadId, item.itemId, false);
      }
    },
    [load, setItemBusy, setPendingOrder, threadId],
  );

  const snapshot = state.snapshot;
  const order = state.pendingOrder ?? snapshot?.items.map((item) => item.itemId) ?? [];
  const itemsById = useMemo(
    () => new Map(snapshot?.items.map((item) => [item.itemId, item] as const) ?? []),
    [snapshot?.items],
  );
  const orderedItems = order.flatMap((itemId) => {
    const item = itemsById.get(itemId);
    return item ? [item] : [];
  });

  const reorder = useCallback(
    async (orderedItemIds: ReadonlyArray<CommandId>) => {
      const api = readNativeApi();
      if (!api || !snapshot) return;
      setPendingOrder(threadId, orderedItemIds);
      if (watchdogRef.current !== null) window.clearTimeout(watchdogRef.current);
      watchdogRef.current = window.setTimeout(() => {
        setPendingOrder(threadId, null);
        void load();
      }, 5_000);
      try {
        applySnapshot(
          await api.nextTurnQueue.reorder({
            threadId,
            orderedItemIds,
            expectedRevision: snapshot.revision,
          }),
        );
      } catch (error) {
        setPendingOrder(threadId, null);
        toastManager.add({ type: "error", title: errorMessage(error) });
        void load();
      }
    },
    [applySnapshot, load, setPendingOrder, snapshot, threadId],
  );

  const move = useCallback(
    (itemId: CommandId, direction: -1 | 1) => {
      const next = moveItemInOrder(order, itemId, direction);
      if (next !== order) void reorder(next);
    },
    [order, reorder],
  );

  const onDragEnd = useCallback(
    (event: DragEndEvent) => {
      if (!event.over || event.active.id === event.over.id) return;
      const from = order.indexOf(event.active.id as CommandId);
      const to = order.indexOf(event.over.id as CommandId);
      if (from < 0 || to < 0) return;
      const next = [...order];
      const [moved] = next.splice(from, 1);
      if (!moved) return;
      next.splice(to, 0, moved);
      void reorder(next);
    },
    [order, reorder],
  );

  if (!snapshot && state.syncError) {
    return (
      <section className="mx-auto mb-2 w-full max-w-3xl rounded-xl border p-3 text-sm">
        Couldn&apos;t load the queue.{" "}
        <Button size="xs" variant="link" onClick={() => void load()}>
          Retry
        </Button>
      </section>
    );
  }
  if (!snapshot) return null;
  const itemCount = snapshot.items.length + state.optimistic.length;
  if (itemCount === 0 && !snapshot.paused && !state.syncError && snapshot.quarantinedCount === 0) {
    return null;
  }
  const blockedDescription = describeQueueBlockedState(snapshot);
  const hasDeliveryFailure =
    snapshot.reasonCode === "delivery_rejected" || snapshot.reasonCode === "delivery_ambiguous";

  const runDeliveryRecovery = async (action: "recheck" | "retry" | "discard"): Promise<void> => {
    const api = readNativeApi();
    if (!api) return;
    try {
      if (action === "recheck") {
        applySnapshot(await api.nextTurnQueue.recheckDelivery({ threadId }));
        return;
      }
      if (action === "retry") {
        const allowPossibleDuplicate = snapshot.reasonCode === "delivery_ambiguous";
        if (
          allowPossibleDuplicate &&
          !window.confirm(
            "The provider may already have received this turn. Retry anyway and accept the risk of a duplicate prompt?",
          )
        ) {
          return;
        }
        applySnapshot(await api.nextTurnQueue.retryDelivery({ threadId, allowPossibleDuplicate }));
        return;
      }
      if (!window.confirm("Discard this undelivered turn and keep the queue paused?")) return;
      applySnapshot(await api.nextTurnQueue.discardDelivery({ threadId }));
    } catch (error) {
      toastManager.add({ type: "error", title: errorMessage(error) });
      void load();
    }
  };

  return (
    <section
      id="next-turn-queue-panel"
      tabIndex={-1}
      className="mx-auto mb-2 w-full max-w-3xl rounded-xl border border-border/70 bg-card/95 px-2.5 py-2 shadow-sm"
      aria-label="Queued turns"
    >
      <span className="sr-only" role="status" aria-live="polite" aria-atomic="true">
        {announcement}
      </span>
      <span id="next-turn-queue-reorder-help" className="sr-only">
        Press Alt+Up or Alt+Down to reorder this queued turn.
      </span>
      <div className="flex items-center justify-between gap-2 px-1">
        <div className="flex items-center gap-2">
          <span className="font-medium text-xs">Next turns ({itemCount})</span>
          {snapshot.items.length >= snapshot.maxItems - 3 ? (
            <span className="text-muted-foreground text-xs">
              {snapshot.items.length}/{snapshot.maxItems}
            </span>
          ) : null}
          {snapshot.paused ? (
            <span className="rounded bg-warning/20 px-1.5 py-0.5 text-[10px]">PAUSED</span>
          ) : null}
        </div>
        <div className="flex items-center gap-1">
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            aria-label={snapshot.paused ? "Resume queue" : "Pause queue"}
            disabled={hasDeliveryFailure}
            onClick={() => {
              const api = readNativeApi();
              if (!api) return;
              void api.nextTurnQueue
                .setPaused({
                  threadId,
                  paused: !snapshot.paused,
                  expectedRevision: snapshot.revision,
                })
                .then(applySnapshot)
                .catch((error) => toastManager.add({ type: "error", title: errorMessage(error) }));
            }}
          >
            {snapshot.paused ? <PlayIcon /> : <PauseIcon />}
          </Button>
          {snapshot.items.length > 0 ? (
            <Button
              type="button"
              variant="ghost"
              size="xs"
              onClick={() => {
                const api = readNativeApi();
                if (!api) return;
                void api.nextTurnQueue
                  .clear({ threadId, scope: "all", expectedRevision: snapshot.revision })
                  .then((result) => {
                    applySnapshot(result.snapshot);
                    if (result.removed.length > 0) {
                      toastManager.add({
                        type: "success",
                        title: "Queue cleared.",
                        actionProps: {
                          children: "Undo",
                          onClick: () => {
                            const current =
                              useNextTurnQueueStore.getState().byThreadId[threadId]?.snapshot;
                            if (!current) return;
                            void api.nextTurnQueue
                              .restore({
                                threadId,
                                itemIds: result.removed.map((item) => item.itemId),
                                expectedRevision: current.revision,
                              })
                              .then((restored) => applySnapshot(restored.snapshot));
                          },
                        },
                      });
                    }
                  });
              }}
            >
              Clear
            </Button>
          ) : null}
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            aria-label={collapsed ? "Expand queue" : "Collapse queue"}
            onClick={() => setCollapsed((value) => !value)}
          >
            {collapsed ? <ChevronDownIcon /> : <ChevronUpIcon />}
          </Button>
        </div>
      </div>
      {snapshot.quarantinedCount > 0 ? (
        <p className="mt-1 text-warning-foreground text-xs">
          {snapshot.quarantinedCount} invalid queued turn
          {snapshot.quarantinedCount === 1 ? " was" : "s were"} quarantined.
        </p>
      ) : null}
      {blockedDescription ? (
        <div
          className={`mt-1 rounded px-2 py-1 text-xs ${snapshot.blockedKind === "waiting" ? "text-muted-foreground" : "bg-warning/10 text-warning-foreground"}`}
        >
          {blockedDescription}
          {snapshot.reasonCode === "worktree_missing" ? (
            <Button
              type="button"
              variant="link"
              size="xs"
              onClick={() => {
                const api = readNativeApi();
                if (api) void api.nextTurnQueue.refreshGate({ threadId }).then(applySnapshot);
              }}
            >
              Refresh
            </Button>
          ) : null}
          {hasDeliveryFailure ? (
            <span className="ml-1 inline-flex gap-1">
              <Button
                type="button"
                variant="link"
                size="xs"
                onClick={() => void runDeliveryRecovery("recheck")}
              >
                Recheck
              </Button>
              <Button
                type="button"
                variant="link"
                size="xs"
                onClick={() => void runDeliveryRecovery("retry")}
              >
                Retry
              </Button>
              <Button
                type="button"
                variant="link"
                size="xs"
                onClick={() => void runDeliveryRecovery("discard")}
              >
                Discard
              </Button>
            </span>
          ) : null}
        </div>
      ) : null}
      {!collapsed ? (
        <DndContext
          sensors={sensors}
          collisionDetection={closestCorners}
          modifiers={[restrictToVerticalAxis, restrictToFirstScrollableAncestor]}
          onDragEnd={onDragEnd}
        >
          <SortableContext items={[...order]} strategy={verticalListSortingStrategy}>
            <ol className="mt-1 max-h-[min(42vh,320px)] space-y-1 overflow-y-auto overscroll-contain">
              {state.optimistic.map((item) => (
                <li
                  key={item.submissionId}
                  className="flex items-center gap-2 rounded-lg border border-primary/25 bg-primary/5 p-2 text-sm"
                >
                  <LoaderCircleIcon className="size-3.5 animate-spin" />
                  <span className="truncate">{item.text}</span>
                </li>
              ))}
              {orderedItems.map((item, index) => (
                <NextTurnQueueRow
                  key={item.itemId}
                  item={item}
                  index={index}
                  snapshot={snapshot}
                  busy={state.busyItemIds.includes(item.itemId)}
                  onMove={move}
                  onUpdate={async (candidate, update) =>
                    runItemMutation(candidate, async () => {
                      const api = readNativeApi();
                      if (!api) throw new Error("Server connection is unavailable.");
                      const rewritten = rewriteComposerRuntimeSkillInvocationForSend({
                        text: update.text,
                        provider: candidate.command.provider ?? provider,
                        runtimeSlashCommands,
                        projectSkills,
                      });
                      applySnapshot(
                        await api.nextTurnQueue.update({
                          itemId: candidate.itemId,
                          text: rebuildEditedText(candidate, rewritten.text),
                          skillCall: rewritten.skillCall ?? null,
                          ...(update.model !== undefined ? { model: update.model } : {}),
                          runtimeMode: update.runtimeMode,
                          interactionMode: update.interactionMode,
                          expectedUpdatedAt: candidate.updatedAt,
                        }),
                      );
                    })
                  }
                  onCancel={async (candidate) =>
                    runItemMutation(candidate, async () => {
                      const api = readNativeApi();
                      if (!api) throw new Error("Server connection is unavailable.");
                      const result = await api.nextTurnQueue.cancel({
                        itemId: candidate.itemId,
                        expectedUpdatedAt: candidate.updatedAt,
                      });
                      applySnapshot(result.snapshot);
                      toastManager.add({
                        type: "success",
                        title: "Queued turn canceled.",
                        actionProps: {
                          children: "Undo",
                          onClick: () => {
                            const current =
                              useNextTurnQueueStore.getState().byThreadId[threadId]?.snapshot;
                            if (!current) return;
                            void api.nextTurnQueue
                              .restore({
                                threadId,
                                itemIds: [candidate.itemId],
                                expectedRevision: current.revision,
                              })
                              .then((restored) => applySnapshot(restored.snapshot));
                          },
                        },
                      });
                    })
                  }
                  onRetry={async (candidate) =>
                    runItemMutation(candidate, async () => {
                      const api = readNativeApi();
                      if (!api) throw new Error("Server connection is unavailable.");
                      applySnapshot(
                        await api.nextTurnQueue.retry({
                          itemId: candidate.itemId,
                          expectedUpdatedAt: candidate.updatedAt,
                        }),
                      );
                    })
                  }
                  onDuplicate={async (candidate) =>
                    runItemMutation(candidate, async () => {
                      const api = readNativeApi();
                      if (!api) throw new Error("Server connection is unavailable.");
                      applySnapshot(
                        await api.nextTurnQueue.duplicate({
                          itemId: candidate.itemId,
                          expectedUpdatedAt: candidate.updatedAt,
                        }),
                      );
                    })
                  }
                  onMoveToTop={async (candidate) => {
                    const next = [
                      candidate.itemId,
                      ...order.filter((itemId) => itemId !== candidate.itemId),
                    ];
                    await reorder(next);
                  }}
                  onRunNow={async (candidate) =>
                    runItemMutation(candidate, async () => {
                      const api = readNativeApi();
                      if (!api) throw new Error("Server connection is unavailable.");
                      const activeTurn = snapshot.reasonCode === "active_turn";
                      if (
                        activeTurn &&
                        !window.confirm("Stop the active turn and run this queued turn now?")
                      ) {
                        return;
                      }
                      applySnapshot(
                        await api.nextTurnQueue.promote({
                          itemId: candidate.itemId,
                          interruptActive: activeTurn,
                          expectedRevision: snapshot.revision,
                        }),
                      );
                    })
                  }
                />
              ))}
            </ol>
          </SortableContext>
        </DndContext>
      ) : null}
    </section>
  );
}
