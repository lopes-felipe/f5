import { useState } from "react";
import * as Schema from "effect/Schema";
import { useLocalStorage } from "../../hooks/useLocalStorage";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { PrHubCommentOperation, PullRequestKey } from "@t3tools/contracts";
import { ensureNativeApi } from "../../nativeApi";
import { getPrHubAccountGeneration, getPrHubDraftIdentity } from "../../lib/prHubAccount";
import { Button } from "../ui/button";
import { Textarea } from "../ui/textarea";
import { PrOperationRecovery } from "./PrOperationRecovery";

export function PrCommentSubmit({ prKey }: { prKey: PullRequestKey }) {
  const accountGeneration = getPrHubAccountGeneration();
  const client = useQueryClient();
  const queryKey = ["prHub", "commentOperation", accountGeneration, prKey];
  const query = useQuery({
    queryKey,
    queryFn: () =>
      ensureNativeApi().prHub.getCommentOperation({
        key: prKey,
        accountGeneration: accountGeneration!,
      }),
    enabled: Boolean(accountGeneration),
    retry: false,
  });
  const [body, setBody] = useLocalStorage(
    JSON.stringify(["prHub", "commentText", getPrHubDraftIdentity(), prKey]),
    "",
    Schema.String,
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const operation = query.data;
  const active =
    operation && ["prepared", "creating", "outcome_unknown"].includes(operation.status);
  const identity = operation && {
    key: prKey,
    accountGeneration: accountGeneration!,
    id: operation.id,
    payloadHash: operation.payloadHash,
  };
  async function run(action: () => Promise<PrHubCommentOperation>) {
    setBusy(true);
    setError(null);
    try {
      const result = await action();
      client.setQueryData(queryKey, result);
      if (result.status === "succeeded") setBody("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The saved comment could not be updated.");
      await query.refetch();
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="space-y-3">
      {operation?.errorMessage ? <p role="status">{operation.errorMessage}</p> : null}
      {error || query.error ? <p role="alert">{error ?? query.error?.message}</p> : null}
      {active && identity ? (
        <>
          <p role="status">Comment submission: {operation.status.replaceAll("_", " ")}</p>
          <pre
            aria-label="Comment submission preview"
            className="max-h-60 overflow-auto whitespace-pre-wrap rounded border border-border p-2 text-xs"
          >
            {operation.payload.markedBody}
          </pre>
          <p className="text-xs text-muted-foreground">
            This is a PR timeline comment. The visible F5 marker allows recovery if GitHub's
            response is lost.
          </p>
          {operation.status === "prepared" ? (
            <div className="flex gap-2">
              <Button
                disabled={busy}
                onClick={() => void run(() => ensureNativeApi().prHub.submitComment(identity))}
              >
                Submit comment to GitHub
              </Button>
              <Button
                variant="outline"
                disabled={busy}
                onClick={() => {
                  setBody(operation.payload.body);
                  void run(() =>
                    ensureNativeApi().prHub.recoverComment({ ...identity, action: "cancel" }),
                  );
                }}
              >
                Edit comment
              </Button>
            </div>
          ) : (
            <>
              <p className="text-sm">
                GitHub may have accepted this comment. Automatic retry is disabled.
              </p>
              <Button
                variant="outline"
                disabled={busy || query.isFetching}
                onClick={() => void query.refetch()}
              >
                Check GitHub result
              </Button>
              <PrOperationRecovery
                key={operation.id}
                kind="comment"
                busy={busy}
                onRecover={(action, remoteId) =>
                  void run(() =>
                    ensureNativeApi().prHub.recoverComment({
                      ...identity,
                      action,
                      ...(remoteId ? { remoteId } : {}),
                    }),
                  )
                }
              />
            </>
          )}
        </>
      ) : (
        <>
          {operation?.status === "succeeded" ? (
            <p role="status">Comment submitted to GitHub.</p>
          ) : null}
          {operation &&
          ["rejected", "abandoned", "failed_before_send"].includes(operation.status) ? (
            <Button variant="outline" onClick={() => setBody(operation.payload.body)}>
              Restore saved comment text
            </Button>
          ) : null}
          <Textarea
            aria-label="PR timeline comment"
            value={body}
            onChange={(e) => setBody(e.currentTarget.value)}
            disabled={busy || !getPrHubDraftIdentity()}
          />
          <Button
            disabled={
              busy || query.isFetching || Boolean(query.error) || !body.trim() || !accountGeneration
            }
            onClick={() =>
              void run(() =>
                ensureNativeApi().prHub.prepareComment({
                  key: prKey,
                  accountGeneration: accountGeneration!,
                  id: crypto.randomUUID(),
                  body,
                }),
              )
            }
          >
            Preview comment
          </Button>
          {query.error ? (
            <Button variant="outline" onClick={() => void query.refetch()}>
              Retry status check
            </Button>
          ) : null}
        </>
      )}
    </div>
  );
}
