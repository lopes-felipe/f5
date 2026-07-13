import {
  type ChatAttachment,
  type CommandId,
  type ModelSlug,
  type NextTurnQueueItem,
  type NextTurnQueueSnapshot,
  ProviderInstanceId,
  type ProviderInteractionMode,
  type ProviderKind,
  type ProviderModelOptions,
  type RuntimeMode,
  type ThreadId,
} from "@t3tools/contracts";
import {
  GripVerticalIcon,
  ImageIcon,
  LoaderCircleIcon,
  PauseIcon,
  PencilIcon,
  PlayIcon,
  RefreshCwIcon,
  Trash2Icon,
  XIcon,
} from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import { readNativeApi } from "~/nativeApi";
import { useWsConnectionState } from "~/wsConnectionState";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Textarea } from "../ui/textarea";
import { toastManager } from "../ui/toast";

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Failed to update the queued turn.";
}

function itemLabel(item: NextTurnQueueItem): string {
  const text = item.command.message.text.trim();
  if (text.length > 0) return text;
  const count = item.command.message.attachments.length;
  return count === 1 ? "Image attachment" : `${count} attachments`;
}

interface EditDraft {
  readonly text: string;
  readonly attachments: ReadonlyArray<ChatAttachment>;
  readonly provider: ProviderKind | "";
  readonly model: string;
  readonly instanceId: string;
  readonly modelOptionsJson: string;
  readonly runtimeMode: RuntimeMode;
  readonly interactionMode: ProviderInteractionMode;
  readonly failurePolicy: "stop" | "continue";
}

function editDraftForItem(item: NextTurnQueueItem): EditDraft {
  return {
    text: item.command.message.text,
    attachments: item.command.message.attachments,
    provider: item.command.provider ?? "",
    model: item.command.modelSelection?.model ?? item.command.model ?? "",
    instanceId: item.command.modelSelection?.instanceId ?? "",
    modelOptionsJson: JSON.stringify(item.command.modelOptions ?? {}, null, 2),
    runtimeMode: item.command.runtimeMode,
    interactionMode: item.command.interactionMode,
    failurePolicy: item.failurePolicy,
  };
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
  const [loadError, setLoadError] = useState<string | null>(null);
  const [editingItemId, setEditingItemId] = useState<CommandId | null>(null);
  const [editDraft, setEditDraft] = useState<EditDraft | null>(null);
  const [busyItemId, setBusyItemId] = useState<CommandId | null>(null);
  const [queueBusy, setQueueBusy] = useState(false);
  const [draggedItemId, setDraggedItemId] = useState<CommandId | null>(null);

  const applySnapshot = useCallback(
    (next: NextTurnQueueSnapshot) => {
      if (next.threadId !== threadId) return;
      setSnapshot((current) =>
        current !== null && current.version > next.version ? current : next,
      );
      setLoadError(null);
    },
    [threadId],
  );

  const loadSnapshot = useCallback(async () => {
    const api = readNativeApi();
    if (!api) {
      setLoadError("Server connection is unavailable.");
      return;
    }
    try {
      applySnapshot(await api.nextTurnQueue.list({ threadId }));
    } catch (error) {
      setLoadError(errorMessage(error));
    }
  }, [applySnapshot, threadId]);

  useEffect(() => {
    const api = readNativeApi();
    if (!api) return;
    let active = true;
    const unsubscribe = api.nextTurnQueue.onUpdated((next) => {
      if (active) applySnapshot(next);
    });
    if (connection.phase === "connected") void loadSnapshot();
    return () => {
      active = false;
      unsubscribe();
    };
  }, [applySnapshot, connection.connectedAt, connection.phase, loadSnapshot]);

  useEffect(() => {
    if (snapshotHint) applySnapshot(snapshotHint);
  }, [applySnapshot, snapshotHint]);

  const runMutation = useCallback(
    async (itemId: CommandId, mutation: () => Promise<NextTurnQueueSnapshot>) => {
      setBusyItemId(itemId);
      try {
        applySnapshot(await mutation());
      } catch (error) {
        toastManager.add({ type: "error", title: errorMessage(error) });
        await loadSnapshot();
      } finally {
        setBusyItemId(null);
      }
    },
    [applySnapshot, loadSnapshot],
  );

  const items = snapshot?.items ?? [];
  const queueReorderLocked = items.some((item) => item.status === "dispatching");
  const reorderItem = (itemId: CommandId, targetIndex: number) => {
    if (!snapshot || queueReorderLocked) return;
    const sourceIndex = items.findIndex((item) => item.itemId === itemId);
    if (sourceIndex < 0 || targetIndex < 0 || targetIndex >= items.length) return;
    if (sourceIndex === targetIndex) return;
    const orderedItemIds = items.map((item) => item.itemId);
    const [moved] = orderedItemIds.splice(sourceIndex, 1);
    if (!moved) return;
    orderedItemIds.splice(targetIndex, 0, moved);
    void runMutation(itemId, async () => {
      const api = readNativeApi();
      if (!api) throw new Error("Server connection is unavailable.");
      return api.nextTurnQueue.reorder({
        threadId,
        expectedVersion: snapshot.version,
        orderedItemIds,
      });
    });
  };
  const pendingItem =
    optimisticItem?.threadId === threadId &&
    !items.some((item) => item.itemId === optimisticItem.itemId)
      ? optimisticItem
      : null;
  const itemCount = items.length + Number(pendingItem !== null);
  const queuePaused =
    snapshot?.blocker?.code === "manual_pause" || snapshot?.blocker?.code === "queue_paused";
  if (itemCount === 0 && loadError === null) return null;

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
        <div className="flex min-w-0 items-center gap-1">
          {snapshot?.blocker ? (
            <span
              className="truncate text-warning-foreground text-xs"
              title={snapshot.blocker.message}
            >
              {snapshot.blocker.message}
            </span>
          ) : (
            <span className="text-muted-foreground text-xs">Runs one at a time</span>
          )}
          {snapshot && snapshot.items.length > 0 ? (
            <>
              <Button
                type="button"
                variant="ghost"
                size="xs"
                disabled={queueBusy}
                onClick={() => {
                  setQueueBusy(true);
                  void (async () => {
                    try {
                      const api = readNativeApi();
                      if (!api) throw new Error("Server connection is unavailable.");
                      applySnapshot(
                        queuePaused
                          ? await api.nextTurnQueue.resumeQueue({
                              threadId,
                              expectedVersion: snapshot.version,
                            })
                          : await api.nextTurnQueue.pauseQueue({
                              threadId,
                              expectedVersion: snapshot.version,
                            }),
                      );
                    } catch (error) {
                      toastManager.add({ type: "error", title: errorMessage(error) });
                      await loadSnapshot();
                    } finally {
                      setQueueBusy(false);
                    }
                  })();
                }}
              >
                {queuePaused ? <PlayIcon /> : <PauseIcon />}
                {queuePaused ? "Resume all" : "Pause"}
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="xs"
                disabled={queueBusy}
                onClick={() => {
                  setQueueBusy(true);
                  void (async () => {
                    try {
                      const api = readNativeApi();
                      if (!api) throw new Error("Server connection is unavailable.");
                      const result = await api.nextTurnQueue.clear({
                        threadId,
                        expectedVersion: snapshot.version,
                      });
                      applySnapshot(result.snapshot);
                      if (result.skippedDispatching) {
                        toastManager.add({
                          type: "warning",
                          title: "The item already being sent was kept.",
                        });
                      }
                    } catch (error) {
                      toastManager.add({ type: "error", title: errorMessage(error) });
                      await loadSnapshot();
                    } finally {
                      setQueueBusy(false);
                    }
                  })();
                }}
              >
                <Trash2Icon /> Clear
              </Button>
            </>
          ) : null}
        </div>
      </div>
      {loadError ? (
        <div className="mb-1 flex items-center justify-between gap-2 rounded-lg bg-destructive/8 px-2 py-1.5 text-destructive text-xs">
          <span>{loadError}</span>
          <Button type="button" variant="ghost" size="xs" onClick={() => void loadSnapshot()}>
            <RefreshCwIcon /> Retry
          </Button>
        </div>
      ) : null}
      <ol className="space-y-1">
        {pendingItem ? (
          <li className="flex min-w-0 items-center gap-1.5 rounded-lg border border-primary/25 bg-primary/5 p-2">
            <LoaderCircleIcon className="size-3.5 shrink-0 animate-spin text-primary" />
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm" title={pendingItem.text}>
                {pendingItem.text || "Attachment-only turn"}
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
          const editing = editingItemId === item.itemId && editDraft !== null;
          const dispatching = item.status === "dispatching";
          const canResume =
            index === 0 && (item.status === "paused" || snapshot?.blocker?.resumable === true);
          const continueAfterFailure =
            snapshot?.blocker?.code === "previous_turn_failed" ||
            snapshot?.blocker?.code === "previous_turn_interrupted" ||
            snapshot?.blocker?.code === "provider_error";
          const deliveryMayDuplicate = snapshot?.blocker?.code === "delivery_unknown";
          return (
            <li
              key={item.itemId}
              className="rounded-lg border border-border/55 bg-background/55 p-2"
              onDragOver={(event) => {
                if (draggedItemId !== null && !queueReorderLocked) event.preventDefault();
              }}
              onDrop={(event) => {
                event.preventDefault();
                if (draggedItemId !== null) reorderItem(draggedItemId, index);
                setDraggedItemId(null);
              }}
            >
              {editing ? (
                <div className="space-y-2">
                  <Textarea
                    size="sm"
                    value={editDraft.text}
                    onChange={(event) =>
                      setEditDraft({ ...editDraft, text: event.currentTarget.value })
                    }
                    aria-label="Queued turn text"
                    autoFocus
                  />
                  {editDraft.attachments.length > 0 ? (
                    <div className="flex flex-wrap gap-1">
                      {editDraft.attachments.map((attachment) => (
                        <span
                          key={attachment.id}
                          className="inline-flex items-center gap-1 rounded-md border px-1.5 py-1 text-xs"
                        >
                          <ImageIcon className="size-3" />
                          <span className="max-w-36 truncate">{attachment.name}</span>
                          <button
                            type="button"
                            aria-label={`Remove ${attachment.name}`}
                            onClick={() =>
                              setEditDraft({
                                ...editDraft,
                                attachments: editDraft.attachments.filter(
                                  (candidate) => candidate.id !== attachment.id,
                                ),
                              })
                            }
                          >
                            <XIcon className="size-3" />
                          </button>
                        </span>
                      ))}
                    </div>
                  ) : null}
                  <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                    <label className="space-y-1 text-[11px] text-muted-foreground">
                      Provider
                      <select
                        className="h-7 w-full rounded-md border border-input bg-background px-2 text-foreground text-xs"
                        value={editDraft.provider}
                        onChange={(event) =>
                          setEditDraft({
                            ...editDraft,
                            provider: event.currentTarget.value as ProviderKind | "",
                          })
                        }
                      >
                        <option value="">Automatic</option>
                        <option value="codex">Codex</option>
                        <option value="claudeAgent">Claude</option>
                        <option value="cursor">Cursor</option>
                        <option value="opencode">OpenCode</option>
                        <option value="grok">Grok</option>
                      </select>
                    </label>
                    <label className="space-y-1 text-[11px] text-muted-foreground">
                      Model
                      <Input
                        size="sm"
                        value={editDraft.model}
                        onChange={(event) =>
                          setEditDraft({ ...editDraft, model: event.currentTarget.value })
                        }
                      />
                    </label>
                    <label className="space-y-1 text-[11px] text-muted-foreground">
                      Instance
                      <Input
                        size="sm"
                        value={editDraft.instanceId}
                        placeholder="Default"
                        onChange={(event) =>
                          setEditDraft({ ...editDraft, instanceId: event.currentTarget.value })
                        }
                      />
                    </label>
                    <label className="space-y-1 text-[11px] text-muted-foreground">
                      Runtime
                      <select
                        className="h-7 w-full rounded-md border border-input bg-background px-2 text-foreground text-xs"
                        value={editDraft.runtimeMode}
                        onChange={(event) =>
                          setEditDraft({
                            ...editDraft,
                            runtimeMode: event.currentTarget.value as RuntimeMode,
                          })
                        }
                      >
                        <option value="read-only">Read only</option>
                        <option value="approval-required">Approval required</option>
                        <option value="full-access">Full access</option>
                      </select>
                    </label>
                    <label className="space-y-1 text-[11px] text-muted-foreground">
                      Interaction
                      <select
                        className="h-7 w-full rounded-md border border-input bg-background px-2 text-foreground text-xs"
                        value={editDraft.interactionMode}
                        onChange={(event) =>
                          setEditDraft({
                            ...editDraft,
                            interactionMode: event.currentTarget.value as ProviderInteractionMode,
                          })
                        }
                      >
                        <option value="default">Default</option>
                        <option value="plan">Plan</option>
                      </select>
                    </label>
                    <label className="space-y-1 text-[11px] text-muted-foreground">
                      On failure
                      <select
                        className="h-7 w-full rounded-md border border-input bg-background px-2 text-foreground text-xs"
                        value={editDraft.failurePolicy}
                        onChange={(event) =>
                          setEditDraft({
                            ...editDraft,
                            failurePolicy: event.currentTarget.value as "stop" | "continue",
                          })
                        }
                      >
                        <option value="stop">Stop queue</option>
                        <option value="continue">Continue</option>
                      </select>
                    </label>
                  </div>
                  <label className="block space-y-1 text-[11px] text-muted-foreground">
                    Model options (JSON)
                    <Textarea
                      size="sm"
                      className="font-mono text-xs"
                      value={editDraft.modelOptionsJson}
                      onChange={(event) =>
                        setEditDraft({
                          ...editDraft,
                          modelOptionsJson: event.currentTarget.value,
                        })
                      }
                    />
                  </label>
                  <div className="flex justify-end gap-1.5">
                    <Button
                      type="button"
                      variant="ghost"
                      size="xs"
                      onClick={() => {
                        setEditingItemId(null);
                        setEditDraft(null);
                      }}
                    >
                      Cancel
                    </Button>
                    <Button
                      type="button"
                      size="xs"
                      disabled={
                        busy ||
                        (editDraft.text.trim().length === 0 && editDraft.attachments.length === 0)
                      }
                      onClick={() =>
                        void runMutation(item.itemId, async () => {
                          const api = readNativeApi();
                          if (!api || !snapshot)
                            throw new Error("Server connection is unavailable.");
                          let modelOptions: ProviderModelOptions;
                          try {
                            modelOptions = JSON.parse(
                              editDraft.modelOptionsJson,
                            ) as ProviderModelOptions;
                          } catch {
                            throw new Error("Model options must be valid JSON.");
                          }
                          const model = editDraft.model.trim();
                          const instanceId = editDraft.instanceId.trim();
                          const next = await api.nextTurnQueue.update({
                            itemId: item.itemId,
                            threadId,
                            expectedVersion: snapshot.version,
                            expectedRevision: item.revision,
                            text: editDraft.text,
                            attachments: editDraft.attachments,
                            provider: editDraft.provider || null,
                            model: model || null,
                            modelSelection:
                              model && instanceId
                                ? {
                                    instanceId: ProviderInstanceId.makeUnsafe(instanceId),
                                    model,
                                    ...(item.command.modelSelection?.options
                                      ? { options: item.command.modelSelection.options }
                                      : {}),
                                  }
                                : null,
                            modelOptions,
                            runtimeMode: editDraft.runtimeMode,
                            interactionMode: editDraft.interactionMode,
                            failurePolicy: editDraft.failurePolicy,
                          });
                          setEditingItemId(null);
                          setEditDraft(null);
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
                  <button
                    type="button"
                    draggable={!queueReorderLocked && !busy}
                    disabled={queueReorderLocked || busy}
                    className="cursor-grab rounded-sm text-muted-foreground disabled:cursor-not-allowed disabled:opacity-40"
                    aria-label="Reorder queued turn"
                    title="Drag to reorder, or use Arrow Up and Arrow Down"
                    onDragStart={(event) => {
                      setDraggedItemId(item.itemId);
                      event.dataTransfer.effectAllowed = "move";
                      event.dataTransfer.setData("text/plain", item.itemId);
                    }}
                    onDragEnd={() => setDraggedItemId(null)}
                    onKeyDown={(event) => {
                      if (event.key === "ArrowUp") {
                        event.preventDefault();
                        reorderItem(item.itemId, index - 1);
                      } else if (event.key === "ArrowDown") {
                        event.preventDefault();
                        reorderItem(item.itemId, index + 1);
                      }
                    }}
                  >
                    <GripVerticalIcon className="size-3.5" />
                  </button>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm" title={itemLabel(item)}>
                      {itemLabel(item)}
                    </p>
                    <p className="truncate text-muted-foreground text-[11px]">
                      {item.status === "paused"
                        ? (item.blocker?.message ?? "Paused")
                        : item.status === "dispatching"
                          ? "Sending to provider…"
                          : "Queued"}
                      {item.command.message.attachments.length > 0
                        ? ` · ${item.command.message.attachments.length} attachment${item.command.message.attachments.length === 1 ? "" : "s"}`
                        : ""}
                      {item.command.model ? ` · ${item.command.model}` : ""}
                      {` · ${item.command.interactionMode} · ${item.command.runtimeMode}`}
                      {` · ${item.failurePolicy === "stop" ? "stop on failure" : "continue on failure"}`}
                    </p>
                  </div>
                  {canResume ? (
                    <Button
                      type="button"
                      variant="ghost"
                      size="xs"
                      disabled={busy}
                      aria-label={
                        continueAfterFailure
                          ? "Continue queue anyway"
                          : deliveryMayDuplicate
                            ? "Retry delivery; this may duplicate the turn"
                            : "Resume queued turn"
                      }
                      title={
                        deliveryMayDuplicate
                          ? "The provider may have accepted the previous delivery. Retrying can duplicate this turn."
                          : undefined
                      }
                      onClick={() =>
                        void runMutation(item.itemId, async () => {
                          const api = readNativeApi();
                          if (!api || !snapshot)
                            throw new Error("Server connection is unavailable.");
                          return api.nextTurnQueue.resume({
                            itemId: item.itemId,
                            threadId,
                            expectedVersion: snapshot.version,
                            ...(continueAfterFailure ? { failurePolicy: "continue" } : {}),
                          });
                        })
                      }
                    >
                      <PlayIcon />
                      {continueAfterFailure
                        ? "Continue anyway"
                        : deliveryMayDuplicate
                          ? "Retry (may duplicate)"
                          : "Retry"}
                    </Button>
                  ) : null}
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-xs"
                    disabled={busy || dispatching}
                    aria-label="Edit queued turn"
                    onClick={() => {
                      setEditingItemId(item.itemId);
                      setEditDraft(editDraftForItem(item));
                    }}
                  >
                    <PencilIcon />
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-xs"
                    disabled={busy}
                    aria-label="Cancel queued turn"
                    onClick={() => {
                      if (!snapshot) return;
                      setBusyItemId(item.itemId);
                      void (async () => {
                        try {
                          const api = readNativeApi();
                          if (!api) throw new Error("Server connection is unavailable.");
                          const result = await api.nextTurnQueue.cancel({
                            itemId: item.itemId,
                            threadId,
                            expectedVersion: snapshot.version,
                          });
                          applySnapshot(result.snapshot);
                          if (result.outcome === "too_late") {
                            toastManager.add({
                              type: "warning",
                              title: "This turn is already being sent and cannot be cancelled.",
                            });
                          }
                        } catch (error) {
                          toastManager.add({ type: "error", title: errorMessage(error) });
                          await loadSnapshot();
                        } finally {
                          setBusyItemId(null);
                        }
                      })();
                    }}
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
