import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import * as Schema from "effect/Schema";
import type { ForgeMutationPayload, ForgeOperation, TrackedPullRequest } from "@t3tools/contracts";
import { useLocalStorage } from "../../hooks/useLocalStorage";
import { ensureNativeApi } from "../../nativeApi";
import { getPrHubAccountGeneration, getPrHubDraftIdentity } from "../../lib/prHubAccount";
import { Button } from "../ui/button";

export function ForgeOperationPanel({
  pr,
  payload,
  label,
  onSucceeded,
}: {
  pr: TrackedPullRequest;
  payload: ForgeMutationPayload;
  label: string;
  onSucceeded?: (() => void) | undefined;
}) {
  const client = useQueryClient();
  const generation = getPrHubAccountGeneration();
  const [operationId, setOperationId] = useLocalStorage(
    JSON.stringify(["forgeOperation", getPrHubDraftIdentity(), pr.key, label]),
    "",
    Schema.String,
  );
  const [operation, setOperation] = useState<ForgeOperation | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const query = useQuery({
    queryKey: ["prHub", "forgeOperation", generation, pr.key, label, operationId],
    enabled: !!generation,
    queryFn: () =>
      ensureNativeApi().prHub.getOperation({
        key: pr.key,
        accountGeneration: generation!,
        operationId,
      }),
    retry: false,
  });
  useEffect(() => {
    if (query.data) {
      setOperation(query.data);
      setOperationId(query.data.operationId);
    }
  }, [query.data, setOperationId]);
  const active = operation && ["prepared", "running", "outcome_unknown"].includes(operation.status);
  async function run(action: () => Promise<ForgeOperation>, id = operationId) {
    setBusy(true);
    setError(null);
    try {
      const value = await action();
      setOperation(value);
      client.setQueryData(["prHub", "forgeOperation", generation, pr.key, label, id], value);
      if (value.status === "succeeded") {
        onSucceeded?.();
        await client.invalidateQueries({ queryKey: ["prHub"] });
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The operation could not be confirmed.");
      await query.refetch();
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="space-y-2">
      {error || query.error ? <p role="alert">{error ?? query.error?.message}</p> : null}
      {active ? (
        <>
          <p role="status">Saved operation: {operation.status.replaceAll("_", " ")}</p>
          <pre
            aria-label={`${label} preview`}
            className="max-h-48 overflow-auto whitespace-pre-wrap rounded border border-border p-2 text-xs"
          >
            {JSON.stringify(operation.payload, null, 2)}
          </pre>
          <p className="text-xs text-muted-foreground">
            Account {pr.host} · revision {operation.expectedHeadOid.slice(0, 12)}
          </p>
          {operation.error ? <p role="status">{operation.error}</p> : null}
          {operation.status === "outcome_unknown" ? (
            <Button
              variant="outline"
              disabled={busy}
              onClick={() => {
                if (
                  window.confirm(
                    "Verify the outcome on the forge first. Acknowledge this uncertain operation? It will remain recorded and will never be resent.",
                  )
                )
                  void run(() =>
                    ensureNativeApi().prHub.cancelOperation({
                      key: pr.key,
                      accountGeneration: generation!,
                      operationId,
                    }),
                  );
              }}
            >
              Acknowledge verified outcome
            </Button>
          ) : null}
          {operation.status === "prepared" ? (
            <div className="flex gap-2">
              <Button
                disabled={busy || operation.accountGeneration !== generation}
                onClick={() =>
                  void run(() =>
                    ensureNativeApi().prHub.submitOperation({
                      key: pr.key,
                      accountGeneration: generation!,
                      operationId,
                    }),
                  )
                }
              >
                Confirm {label.toLowerCase()}
              </Button>
              <Button
                variant="outline"
                disabled={busy}
                onClick={() =>
                  void run(() =>
                    ensureNativeApi().prHub.cancelOperation({
                      key: pr.key,
                      accountGeneration: generation!,
                      operationId,
                    }),
                  )
                }
              >
                Cancel prepared operation
              </Button>
            </div>
          ) : (
            <Button
              disabled={busy}
              variant="outline"
              onClick={() =>
                void run(() =>
                  ensureNativeApi().prHub.recoverOperation({
                    key: pr.key,
                    accountGeneration: generation!,
                    operationId,
                  }),
                )
              }
            >
              Check saved operation
            </Button>
          )}
        </>
      ) : (
        <>
          {operation ? (
            <p role="status">Operation {operation.status.replaceAll("_", " ")}</p>
          ) : null}
          <Button
            size="sm"
            variant="outline"
            disabled={busy || !generation || !pr.headRefOid || query.isFetching}
            onClick={() => {
              const id = crypto.randomUUID();
              setOperationId(id);
              void run(
                () =>
                  ensureNativeApi().prHub.prepareOperation({
                    key: pr.key,
                    accountGeneration: generation!,
                    operationId: id,
                    expectedHeadOid: pr.headRefOid!,
                    payload,
                  }),
                id,
              );
            }}
          >
            Prepare {label.toLowerCase()}
          </Button>
        </>
      )}
    </div>
  );
}
