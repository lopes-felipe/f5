import { useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { TrackedPullRequest } from "@t3tools/contracts";
import { ensureNativeApi } from "../../nativeApi";
import { getPrHubAccountGeneration } from "../../lib/prHubAccount";
import { PrMarkdown } from "./PrMarkdown";
import { setTaskChecked } from "./markdownTasks";

export function PrDescription({
  pr,
  body,
  canEdit,
}: {
  pr: TrackedPullRequest;
  body: string;
  canEdit: boolean;
}) {
  const client = useQueryClient();
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
    }
  }, [body]);
  function toggle(offset: number, checked: boolean) {
    const next = setTaskChecked(desired.current, offset, checked);
    if (next === desired.current || !generation || !pr.headRefOid) return;
    desired.current = next;
    pending.current++;
    setOptimistic(next);
    setError(null);
    queue.current = queue.current.then(async () => {
      try {
        if (failed.current) return;
        if (generation !== getPrHubAccountGeneration())
          throw new Error("The pull request account changed.");
        const api = ensureNativeApi().prHub;
        const operationId = crypto.randomUUID();
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
        if (result.status !== "succeeded")
          throw new Error(result.error ?? "Description update was not confirmed.");
        saved.current = next;
      } catch (cause) {
        failed.current = true;
        setError(cause instanceof Error ? cause.message : "Could not save description.");
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
      <PrMarkdown
        body={optimistic}
        host={pr.host}
        provider={pr.provider}
        onTaskChange={canEdit && !error && !!generation && !!pr.headRefOid ? toggle : undefined}
      />
    </>
  );
}
