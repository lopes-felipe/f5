import type { ThreadId } from "@t3tools/contracts";
import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";

import { invalidateGitQueries } from "~/lib/gitReactQuery";
import { newCommandId } from "~/lib/utils";
import { readNativeApi } from "~/nativeApi";
import { detectBranchDrift, type BranchDrift } from "./ChatView.branchDrift.logic";
import { Button } from "./ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "./ui/dialog";
import { toastManager } from "./ui/toast";

interface BranchDriftRequest extends BranchDrift {
  readonly cwd: string;
  readonly threadId: ThreadId;
}

type BranchDriftDecision = "switch" | "continue" | "cancel";

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message.trim().length > 0
    ? error.message
    : "The branch change could not be applied.";
}

export function useChatViewBranchDriftGuard(scopeThreadId: ThreadId): {
  readonly guardBranchDrift: (input: {
    readonly cwd: string;
    readonly threadId: ThreadId;
    readonly recordedBranch: string | null;
  }) => Promise<boolean>;
  readonly branchDriftDialog: ReactNode;
} {
  const queryClient = useQueryClient();
  const resolverRef = useRef<((proceed: boolean) => void) | null>(null);
  const [request, setRequest] = useState<BranchDriftRequest | null>(null);
  const [pendingDecision, setPendingDecision] = useState<BranchDriftDecision | null>(null);
  const [decisionError, setDecisionError] = useState<string | null>(null);

  const settle = useCallback((proceed: boolean) => {
    const resolve = resolverRef.current;
    resolverRef.current = null;
    setRequest(null);
    setPendingDecision(null);
    setDecisionError(null);
    resolve?.(proceed);
  }, []);

  useEffect(
    () => () => {
      resolverRef.current?.(false);
      resolverRef.current = null;
    },
    [scopeThreadId],
  );

  const guardBranchDrift = useCallback(
    async (input: {
      readonly cwd: string;
      readonly threadId: ThreadId;
      readonly recordedBranch: string | null;
    }): Promise<boolean> => {
      if (input.recordedBranch === null) return true;
      const api = readNativeApi();
      if (!api) return false;
      try {
        const branches = await api.git.listBranches({ cwd: input.cwd });
        const drift = detectBranchDrift({
          recordedBranch: input.recordedBranch,
          currentBranch: branches.branches.find((branch) => branch.current)?.name ?? null,
        });
        if (!drift) return true;
        resolverRef.current?.(false);
        return await new Promise<boolean>((resolve) => {
          resolverRef.current = resolve;
          setDecisionError(null);
          setPendingDecision(null);
          setRequest({ ...input, ...drift });
        });
      } catch (error: unknown) {
        toastManager.add({
          type: "error",
          title: "Could not verify the current Git branch.",
          description: errorMessage(error),
        });
        return false;
      }
    },
    [],
  );

  const decide = useCallback(
    async (decision: BranchDriftDecision) => {
      if (!request || pendingDecision !== null) return;
      if (decision === "cancel") {
        settle(false);
        return;
      }
      const api = readNativeApi();
      if (!api) {
        settle(false);
        return;
      }
      setPendingDecision(decision);
      setDecisionError(null);
      try {
        if (decision === "switch") {
          await api.git.checkout({ cwd: request.cwd, branch: request.recordedBranch });
          const verified = await api.git.listBranches({ cwd: request.cwd });
          if (verified.branches.find((branch) => branch.current)?.name !== request.recordedBranch) {
            throw new Error(`Git did not switch to '${request.recordedBranch}'.`);
          }
        } else {
          await api.orchestration.dispatchCommand({
            type: "thread.meta.update",
            commandId: newCommandId(),
            threadId: request.threadId,
            branch: request.currentBranch,
            expectedBranch: request.recordedBranch,
          });
        }
        await invalidateGitQueries(queryClient, { cwd: request.cwd });
        settle(true);
      } catch (error: unknown) {
        setPendingDecision(null);
        setDecisionError(errorMessage(error));
      }
    },
    [pendingDecision, queryClient, request, settle],
  );

  const currentBranchLabel = request?.currentBranch ?? "detached HEAD";
  const branchDriftDialog = request ? (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && pendingDecision === null) settle(false);
      }}
    >
      <DialogPopup className="max-w-xl">
        <DialogHeader>
          <DialogTitle>Thread branch changed</DialogTitle>
          <DialogDescription>
            This thread records <code>{request.recordedBranch}</code>, but its workspace is on{" "}
            <code>{currentBranchLabel}</code>.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel className="space-y-3 text-sm">
          <p>
            Switch back if this turn belongs on the recorded branch. Git will refuse the switch if
            local changes cannot be preserved safely.
          </p>
          {decisionError ? <p className="text-destructive-foreground">{decisionError}</p> : null}
        </DialogPanel>
        <DialogFooter>
          <Button
            disabled={pendingDecision !== null}
            variant="ghost"
            onClick={() => void decide("cancel")}
          >
            Cancel send
          </Button>
          <Button
            disabled={pendingDecision !== null}
            variant="outline"
            onClick={() => void decide("continue")}
          >
            Continue on {currentBranchLabel}
          </Button>
          <Button disabled={pendingDecision !== null} onClick={() => void decide("switch")}>
            Switch to {request.recordedBranch}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  ) : null;

  return { guardBranchDrift, branchDriftDialog };
}
