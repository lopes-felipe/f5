import { isAdmittedDeliveryQueueItem } from "@t3tools/contracts";
import { WorkspaceTransitionSummary } from "./WorkspaceTransitionBanner";
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

import { useStore } from "~/store";
import { selectThreadById } from "~/threadSelectors";
import { useShallow } from "zustand/react/shallow";
import { readNativeApi } from "~/nativeApi";
import { rewriteComposerRuntimeSkillInvocationForSend } from "../ChatView.logic";
import { EMPTY_QUEUE_THREAD_STATE, useNextTurnQueueStore } from "~/nextTurnQueueStore";
import { useWsConnectionState } from "~/wsConnectionState";
import { Button } from "../ui/button";
import { toastManager } from "../ui/toast";
import {
  deriveQueueAnnouncement,
  describeQueueBlockedState,
  isFoldedUsageLimitItem,
  mergeVisibleOrder,
  moveItemInOrder,
} from "./NextTurnQueuePanel.logic";
import { NextTurnQueueRow } from "./NextTurnQueueRow";
import { COMPOSER_TRAY_PANEL_CLASS_NAME, type ComposerPanelVariant } from "./composer/ComposerTray";

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

/**
 * Lists the thread's queue on every (re)connect while `auto` is set; pushed
 * updates keep it current in between. Returns the loader for manual retries.
 */
function useNextTurnQueueHydration(threadId: ThreadId, auto: boolean): () => Promise<void> {
  const connection = useWsConnectionState();
  const applySnapshot = useNextTurnQueueStore((store) => store.applySnapshot);
  const setHydrationError = useNextTurnQueueStore((store) => store.setHydrationError);
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
    if (auto && connection.phase === "connected") void load();
  }, [auto, connection.connectedAt, connection.phase, load]);
  return load;
}

/** The polite announcement for the latest queue change, such as a turn sent or a pause. */
function useQueueAnnouncement(threadId: ThreadId, enabled: boolean): string {
  const snapshot = useNextTurnQueueStore((store) => store.byThreadId[threadId]?.snapshot ?? null);
  const [announcement, setAnnouncement] = useState("");
  const previousSnapshotRef = useRef(snapshot);

  useEffect(() => {
    if (!enabled || !snapshot) return;
    const next = deriveQueueAnnouncement(previousSnapshotRef.current, snapshot);
    previousSnapshotRef.current = snapshot;
    if (!next) return;
    const timeout = window.setTimeout(() => setAnnouncement(next), 400);
    return () => window.clearTimeout(timeout);
  }, [enabled, snapshot]);
  return announcement;
}

function QueueAnnouncer({ announcement }: { readonly announcement: string }) {
  return (
    <span className="sr-only" role="status" aria-live="polite" aria-atomic="true">
      {announcement}
    </span>
  );
}

/**
 * Keeps a thread's queue loaded and announced while its panel may be
 * unmounted, as it is inside a closed status-chip popover. Panels rendered
 * alongside it pass `synced`.
 */
export function NextTurnQueueSync({ threadId }: { readonly threadId: ThreadId }) {
  useNextTurnQueueHydration(threadId, true);
  return <QueueAnnouncer announcement={useQueueAnnouncement(threadId, true)} />;
}

export function NextTurnQueuePanel({
  threadId,
  provider,
  runtimeSlashCommands,
  projectSkills,
  turnSteering = false,
  variant = "standalone",
  foldedItemId = null,
  synced = false,
}: {
  readonly variant?: ComposerPanelVariant;
  /** A mounted `NextTurnQueueSync` already loads and announces this queue. */
  readonly synced?: boolean;
  readonly threadId: ThreadId;
  /** The pending continue the usage-limit card shows instead of this list. */
  readonly foldedItemId?: CommandId | null;
  readonly turnSteering?: boolean | undefined;
  readonly provider?: ProviderKind | null;
  readonly runtimeSlashCommands?: CompactRuntimeConfiguredActivityPayload["slashCommands"] | null;
  readonly projectSkills?: ReadonlyArray<ProjectSkill> | null | undefined;
}) {
  // Steering eligibility only; message deltas leave these fields unchanged.
  const thread = useStore(
    useShallow((store) => {
      const entry = selectThreadById(store, threadId);
      return entry
        ? {
            activeTurnId: entry.session?.activeTurnId ?? null,
            sessionGeneration: entry.session?.capabilities?.generation ?? null,
            interactionMode: entry.interactionMode,
            runtimeMode: entry.runtimeMode,
            hasWorktree: entry.worktreePath != null,
          }
        : undefined;
    }),
  );
  const state = useNextTurnQueueStore(
    (store) => store.byThreadId[threadId] ?? EMPTY_QUEUE_THREAD_STATE,
  );
  const applySnapshot = useNextTurnQueueStore((store) => store.applySnapshot);
  const setPendingOrder = useNextTurnQueueStore((store) => store.setPendingOrder);
  const setItemBusy = useNextTurnQueueStore((store) => store.setItemBusy);
  const [collapsed, setCollapsed] = useState(false);
  const announcement = useQueueAnnouncement(threadId, !synced);
  const watchdogRef = useRef<number | null>(null);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));
  const load = useNextTurnQueueHydration(threadId, !synced);

  useEffect(() => {
    if (state.snapshot?.paused || state.snapshot?.blockedKind === "error") setCollapsed(false);
  }, [state.snapshot?.blockedKind, state.snapshot?.paused]);

  useEffect(
    () => () => {
      if (watchdogRef.current === null) return;
      window.clearTimeout(watchdogRef.current);
      watchdogRef.current = null;
      // The watchdog was the only thing left to drop an order the server has
      // not matched; a stale one would hide items that arrive later.
      setPendingOrder(threadId, null);
    },
    [setPendingOrder, threadId],
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
  const hiddenIds = useMemo(
    () =>
      new Set(
        snapshot?.items
          .filter((item) => isFoldedUsageLimitItem(item, foldedItemId))
          .map((item) => item.itemId) ?? [],
      ),
    [foldedItemId, snapshot?.items],
  );
  const clearKeepIds = new Set([
    ...hiddenIds,
    ...(snapshot?.items.filter(isAdmittedDeliveryQueueItem).map((item) => item.itemId) ?? []),
  ]);
  const handleMutationError = (error: unknown) => {
    toastManager.add({ type: "error", title: errorMessage(error) });
    void load();
  };
  const visibleOrder = order.filter((itemId) => !hiddenIds.has(itemId));
  const orderedItems = visibleOrder.flatMap((itemId) => {
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
        watchdogRef.current = null;
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
      const next = moveItemInOrder(visibleOrder, itemId, direction);
      if (next !== visibleOrder) void reorder(mergeVisibleOrder(order, hiddenIds, next));
    },
    [hiddenIds, order, reorder, visibleOrder],
  );

  const onDragEnd = useCallback(
    (event: DragEndEvent) => {
      if (!event.over || event.active.id === event.over.id) return;
      const from = visibleOrder.indexOf(event.active.id as CommandId);
      const to = visibleOrder.indexOf(event.over.id as CommandId);
      if (from < 0 || to < 0) return;
      const next = [...visibleOrder];
      const [moved] = next.splice(from, 1);
      if (!moved) return;
      next.splice(to, 0, moved);
      void reorder(mergeVisibleOrder(order, hiddenIds, next));
    },
    [hiddenIds, order, reorder, visibleOrder],
  );

  if (!snapshot && state.syncError) {
    return (
      <section className="mx-auto mb-2 w-full max-w-(--chat-content-max-width) rounded-xl border p-3 text-sm">
        Couldn&apos;t load the queue.{" "}
        <Button size="xs" variant="link" onClick={() => void load()}>
          Retry
        </Button>
      </section>
    );
  }
  if (!snapshot) return null;
  const itemCount = snapshot.items.length - hiddenIds.size + state.optimistic.length;
  if (
    itemCount === 0 &&
    !snapshot.paused &&
    !state.syncError &&
    snapshot.quarantinedCount === 0 &&
    (!snapshot.workspaceTransition ||
      ["completed", "cancelled"].includes(snapshot.workspaceTransition.phase))
  ) {
    return null;
  }
  const blockedDescription = describeQueueBlockedState(snapshot, {
    workspaceBannerShown: thread?.hasWorktree ?? false,
  });
  // Gate on the delivery the server can still act on, not on the pause reason:
  // a superseded delivery can leave a stale reason with nothing to recover.
  const unresolvedDelivery = snapshot.unresolvedDelivery ?? null;
  const hasDeliveryFailure = unresolvedDelivery !== null;
  const hasDeliveryPause =
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
        const allowPossibleDuplicate = unresolvedDelivery?.state === "ambiguous";
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
      className={
        variant === "tray"
          ? `${COMPOSER_TRAY_PANEL_CLASS_NAME} outline-none`
          : "mx-auto mb-2 w-full max-w-(--chat-content-max-width) rounded-xl border border-border bg-card px-2.5 py-2 shadow-sm"
      }
      aria-label="Queued turns"
    >
      {synced ? null : <QueueAnnouncer announcement={announcement} />}
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
            <span className="rounded bg-warning/20 px-1.5 py-0.5 text-2xs">PAUSED</span>
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
          {snapshot.items.length > clearKeepIds.size ? (
            <Button
              type="button"
              variant="ghost"
              size="xs"
              onClick={() => {
                const api = readNativeApi();
                if (!api) return;
                void api.nextTurnQueue
                  .clear({
                    threadId,
                    scope: "all",
                    expectedRevision: snapshot.revision,
                    // Folded continuations and admitted deliveries have their own recovery actions.
                    ...(clearKeepIds.size > 0 ? { keepItemIds: [...clearKeepIds] } : {}),
                  })
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
                              .then((restored) => applySnapshot(restored.snapshot))
                              .catch(handleMutationError);
                          },
                        },
                      });
                    }
                  })
                  .catch(handleMutationError);
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
          {snapshot.workspaceTransition && (
            <WorkspaceTransitionSummary transition={snapshot.workspaceTransition} />
          )}
          {hasDeliveryFailure || hasDeliveryPause ? (
            <span className="ml-1 inline-flex gap-1">
              <Button
                type="button"
                variant="link"
                size="xs"
                onClick={() => void runDeliveryRecovery("recheck")}
              >
                Recheck
              </Button>
              {hasDeliveryFailure ? (
                <>
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
                </>
              ) : null}
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
          <SortableContext items={visibleOrder} strategy={verticalListSortingStrategy}>
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
                              .then((restored) => applySnapshot(restored.snapshot))
                              .catch(handleMutationError);
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
                      ...visibleOrder.filter((itemId) => itemId !== candidate.itemId),
                    ];
                    await reorder(mergeVisibleOrder(order, hiddenIds, next));
                  }}
                  canSteer={
                    turnSteering &&
                    Boolean(
                      thread?.activeTurnId &&
                      thread.interactionMode === item.command.interactionMode &&
                      thread.runtimeMode === item.command.runtimeMode,
                    )
                  }
                  onSteer={async (candidate) =>
                    runItemMutation(candidate, async () => {
                      const api = readNativeApi();
                      if (!api) throw new Error("Server connection is unavailable.");
                      applySnapshot(
                        await api.nextTurnQueue.steer({
                          itemId: candidate.itemId,
                          expectedRevision: snapshot.revision,
                          ...(thread?.sessionGeneration != null
                            ? { expectedSessionGeneration: thread.sessionGeneration }
                            : {}),
                        }),
                      );
                    })
                  }
                  canRunNow={!thread?.activeTurnId && snapshot.reasonCode !== "active_turn"}
                  onRunNow={async (candidate) =>
                    runItemMutation(candidate, async () => {
                      const api = readNativeApi();
                      if (!api) throw new Error("Server connection is unavailable.");
                      applySnapshot(
                        await api.nextTurnQueue.promote({
                          itemId: candidate.itemId,
                          interruptActive: false,
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
