import type { ThreadId, ThreadPullRequestLink, TurnId } from "@t3tools/contracts";
import { formatSourceControlPullRequestKey } from "@t3tools/shared/sourceControl";
import { useEffect, useRef } from "react";
import { useRightPanelStore } from "../rightPanelStore";
import type { TurnDiffSummary } from "../types";

export function proactiveDiffAction(input: {
  previousTurnId: TurnId | null | undefined;
  runningTurnId: TurnId | null;
  completedTurnId: TurnId | null;
  checkpoint: Pick<TurnDiffSummary, "status" | "files"> | undefined;
  isRepo: boolean | undefined;
}): "ignore" | "defer" | "open" {
  if (
    input.runningTurnId !== null ||
    input.completedTurnId === null ||
    (input.previousTurnId !== undefined && input.previousTurnId !== input.completedTurnId)
  )
    return "ignore";
  if (!input.checkpoint || input.checkpoint.status === "missing" || input.isRepo === undefined)
    return "defer";
  return input.isRepo && input.checkpoint.status !== "error" && input.checkpoint.files.length > 0
    ? "open"
    : "ignore";
}

/** Observe starts before delayed metadata arrives; later manual panel choices always win. */
export function useProactivePanels(input: {
  threadId: ThreadId | null;
  enabled: boolean;
  ready: boolean;
  runningTurnId: TurnId | null;
  completedTurnId: TurnId | null;
  checkpoints: readonly TurnDiffSummary[];
  isRepo: boolean | undefined;
  linkedPullRequest: ThreadPullRequestLink | null;
  openTurnDiff: (turnId: TurnId) => void;
}) {
  const observation = useRef<{
    threadId: ThreadId;
    runningTurnId: TurnId | null | undefined;
    lastStartedTurnId: TurnId | null;
    targetKey: string | null | undefined;
    revision: number;
  } | null>(null);
  useEffect(() => {
    const { threadId, runningTurnId } = input;
    if (threadId === null) {
      observation.current = null;
      return;
    }
    const panels = useRightPanelStore.getState();
    const currentRevision = panels.userActionRevisionByThreadId[threadId] ?? 0;
    if (observation.current?.threadId !== threadId) {
      observation.current = {
        threadId,
        runningTurnId: undefined,
        lastStartedTurnId: null,
        targetKey: undefined,
        revision: currentRevision,
      };
    }
    const previous = observation.current;
    const observedTurnId = runningTurnId ?? input.completedTurnId;
    if (observedTurnId !== null && observedTurnId !== previous.lastStartedTurnId) {
      previous.lastStartedTurnId = observedTurnId;
      previous.revision = panels.captureProactiveTurnRevision(threadId, observedTurnId);
    }
    if (!input.ready) return;
    const link = input.linkedPullRequest;
    const key = link ? formatSourceControlPullRequestKey(link) : null;
    if (input.enabled && link && key !== previous.targetKey) {
      panels.openProactive(
        threadId,
        { id: `pr:${key}`, kind: "pull-request", key: key!, url: link.url },
        previous.revision,
      );
    }
    previous.targetKey = key;
    const action =
      input.enabled && link === null
        ? proactiveDiffAction({
            previousTurnId: previous.runningTurnId,
            runningTurnId,
            completedTurnId: input.completedTurnId,
            checkpoint: input.checkpoints.find(
              (checkpoint) => checkpoint.turnId === input.completedTurnId,
            ),
            isRepo: input.isRepo,
          })
        : "ignore";
    if (action !== "defer") previous.runningTurnId = runningTurnId;
    if (
      action === "open" &&
      input.completedTurnId &&
      panels.openProactive(
        threadId,
        { kind: "diff", turnId: input.completedTurnId },
        previous.revision,
      )
    ) {
      input.openTurnDiff(input.completedTurnId);
    }
  }, [
    input.threadId,
    input.enabled,
    input.ready,
    input.runningTurnId,
    input.completedTurnId,
    input.checkpoints,
    input.isRepo,
    input.linkedPullRequest,
    input.openTurnDiff,
  ]);
}
