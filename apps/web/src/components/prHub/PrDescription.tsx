import { useCallback, useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { ForgeOperation, TrackedPullRequest } from "@t3tools/contracts";
import { Schema } from "effect";
import { ensureNativeApi } from "../../nativeApi";
import { getPrHubAccountGeneration, getPrHubDraftIdentity } from "../../lib/prHubAccount";
import { useLocalStorage } from "../../hooks/useLocalStorage";
import { ForgeOperationPanel } from "./ForgeOperationPanel";
import { PrMarkdown } from "./PrMarkdown";
import { setTaskChecked } from "./markdownTasks";
import { toastManager } from "../ui/toast";

export function PrDescription({
  pr,
  body,
  canEdit,
  readingVersion,
}: {
  pr: TrackedPullRequest;
  body: string;
  canEdit: boolean;
  readingVersion?: number | undefined;
}) {
  const client = useQueryClient();
  const [operationId, setOperationId] = useLocalStorage(
    JSON.stringify(["descriptionOperation", getPrHubDraftIdentity(), pr.key]),
    "",
    Schema.String,
  );
  const [needsRecovery, setNeedsRecovery] = useState(Boolean(operationId));
  const [optimistic, setOptimistic] = useState(body);
  const [error, setError] = useState<string | null>(null);
  const desired = useRef(body);
  const saved = useRef(body);
  const pending = useRef(0);
  const queue = useRef(Promise.resolve());
  const failed = useRef(false);
  const generation = getPrHubAccountGeneration();
  useEffect(() => {
    if (pending.current === 0) {
      desired.current = saved.current = body;
      setOptimistic(body);
      if (!operationId) {
        failed.current = false;
        setError(null);
      }
    }
  }, [body, readingVersion]);
  const resolveOperation = useCallback(
    (operation: ForgeOperation | null) => {
      if (
        operation?.status === "succeeded" &&
        operation.payload.kind === "edit" &&
        operation.payload.body !== undefined
      ) {
        desired.current = saved.current = operation.payload.body;
        setOptimistic(operation.payload.body);
      }
      setOperationId("");
      setNeedsRecovery(false);
      failed.current = false;
      setError(null);
      void client.invalidateQueries({ queryKey: ["prHub"] });
    },
    [client, setOperationId],
  );
  function toggle(offset: number, checked: boolean) {
    const next = setTaskChecked(desired.current, offset, checked);
    if (next === desired.current || !generation || !pr.headRefOid) return;
    desired.current = next;
    pending.current++;
    setOptimistic(next);
    setError(null);
    queue.current = queue.current.then(async () => {
      let recover = true;
      try {
        if (failed.current) return;
        if (generation !== getPrHubAccountGeneration())
          throw new Error("The pull request account changed.");
        const api = ensureNativeApi().prHub;
        const operationId = crypto.randomUUID();
        setOperationId(operationId);
        const prepared = await api.prepareOperation({
          key: pr.key,
          accountGeneration: generation!,
          operationId,
          expectedHeadOid: pr.headRefOid!,
          payload: { kind: "edit", body: next },
        });
        if (prepared.status !== "prepared")
          throw new Error(prepared.error ?? "Could not prepare description update.");
        const result = await api.submitOperation({
          key: pr.key,
          accountGeneration: generation!,
          operationId,
        });
        recover = ["prepared", "running", "outcome_unknown"].includes(result.status);
        if (result.status !== "succeeded")
          throw new Error(result.error ?? "Description update was not confirmed.");
        saved.current = next;
        setOperationId("");
      } catch (cause) {
        failed.current = true;
        if (!recover) setOperationId("");
        setNeedsRecovery(recover);
        setError(cause instanceof Error ? cause.message : "Could not save description.");
        toastManager.add({
          type: "error",
          title: "Could not save description",
          description: cause instanceof Error ? cause.message : "The save could not be confirmed.",
        });
      } finally {
        pending.current--;
        if (pending.current === 0) {
          desired.current = saved.current;
          setOptimistic(saved.current);
          void client.invalidateQueries({ queryKey: ["prHub"] });
        }
      }
    });
  }
  return (
    <>
      {error ? <p role="alert">{error}</p> : null}
      {needsRecovery ? (
        <ForgeOperationPanel
          key={operationId}
          pr={pr}
          label="Description"
          payload={{ kind: "edit", body: desired.current }}
          initialOperationId={operationId}
          recoveryOnly
          onResolved={resolveOperation}
        />
      ) : null}
      <PrMarkdown
        body={optimistic}
        host={pr.host}
        provider={pr.provider}
        onTaskChange={
          canEdit && !error && !needsRecovery && !!generation && !!pr.headRefOid
            ? toggle
            : undefined
        }
      />
    </>
  );
}
