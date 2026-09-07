import { PrOperationRecovery } from "./PrOperationRecovery";
import { useState } from "react";
import * as Schema from "effect/Schema";
import { useLocalStorage } from "../../hooks/useLocalStorage";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { PrHubReviewDraft, PrHubReviewOperation, PullRequestKey } from "@t3tools/contracts";
import { ensureNativeApi } from "../../nativeApi";
import { getPrHubAccountGeneration } from "../../lib/prHubAccount";
import { Textarea } from "../ui/textarea";
import { Button } from "../ui/button";

export function PrReviewSubmit({
  prKey,
  prUrl,
  draft,
  disabled,
  onBusyChange,
  quickEvent,
}: {
  prKey: PullRequestKey;
  prUrl: string;
  quickEvent?: "APPROVE" | "REQUEST_CHANGES";
  draft: PrHubReviewDraft | null;
  disabled: boolean;
  onBusyChange: (busy: boolean) => void;
}) {
  const accountGeneration = getPrHubAccountGeneration();
  const queryClient = useQueryClient();
  const queryKey = ["prHub", "reviewOperation", accountGeneration, prKey];
  const query = useQuery({
    queryKey,
    queryFn: () => ensureNativeApi().prHub.getReviewOperation({ key: prKey, accountGeneration }),
    enabled: Boolean(quickEvent || draft?.frozen),
    retry: false,
  });
  const [event, setEvent] = useState<PrHubReviewOperation["payload"]["event"]>("COMMENT");
  const [quickBody, setQuickBody] = useLocalStorage(
    JSON.stringify(["prHub", "quickReviewText", accountGeneration, prKey, quickEvent]),
    "",
    Schema.String,
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const operation = query.data;
  async function run(action: () => Promise<PrHubReviewOperation>) {
    setBusy(true);
    onBusyChange(true);
    setError(null);
    try {
      const result = await action();
      queryClient.setQueryData(queryKey, result);
      if (quickEvent && result.status === "succeeded") setQuickBody("");
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Review operation failed. Check its saved state before retrying.",
      );
      await query.refetch();
    } finally {
      await queryClient.invalidateQueries({
        queryKey: ["prHub", "reviewDraft", accountGeneration, prKey],
      });
      setBusy(false);
      onBusyChange(false);
    }
  }
  const active =
    operation &&
    !["succeeded", "failed_before_send", "rejected", "abandoned"].includes(operation.status);
  const differentEntry =
    active &&
    (Boolean(quickEvent) !== (operation.payload.source === "quick_review") ||
      (quickEvent && quickEvent !== operation.payload.event));
  if (differentEntry)
    return (
      <p role="status" className="text-sm">
        A review from another editor or review outcome is still active. Finish or recover it in its
        original review editor before preparing another review.
      </p>
    );
  return (
    <div className="space-y-2 border-t border-border pt-3">
      {error || query.error ? (
        <p role="alert" className="text-sm">
          {error ?? query.error?.message}
        </p>
      ) : null}
      {query.error ? (
        <Button
          size="sm"
          variant="outline"
          disabled={query.isFetching}
          onClick={() => void query.refetch()}
        >
          Retry status check
        </Button>
      ) : null}
      <a href={prUrl} target="_blank" rel="noreferrer" className="text-xs underline">
        Open PR on GitHub
      </a>
      {active ? (
        <>
          <p className="text-sm font-medium">
            Review submission: {operation.status.replaceAll("_", " ")}
          </p>
          <p className="text-xs text-muted-foreground">
            {operation.payload.event} · commit{" "}
            {operation.payload.draft.comparison.headOid.slice(0, 12)}
          </p>
          <pre
            className="max-h-60 overflow-auto whitespace-pre-wrap rounded border border-border p-2 text-xs"
            aria-label="Review submission preview"
          >
            {operation.payload.body}
          </pre>
          {operation.payload.draft.content.comments.map((comment) => (
            <div key={comment.id} className="text-sm">
              <code>
                {comment.path}:{comment.startLine ? `${comment.startLine}-` : ""}
                {comment.line} ({comment.side})
              </code>
              <p className="whitespace-pre-wrap">{comment.body}</p>
            </div>
          ))}
          <p className="text-xs text-muted-foreground">
            The F5 marker shown above is included in the review so a lost response can be
            reconciled.
          </p>
          {operation.status === "prepared" || operation.status === "created" ? (
            <div className="flex gap-2">
              <Button
                size="sm"
                disabled={busy}
                onClick={() =>
                  void run(() =>
                    ensureNativeApi().prHub.submitReview({
                      key: prKey,
                      accountGeneration,
                      id: operation.id,
                      payloadHash: operation.payloadHash,
                    }),
                  )
                }
              >
                Submit review to GitHub
              </Button>
              {operation.status === "prepared" ? (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy}
                  onClick={() => {
                    if (quickEvent) setQuickBody(operation.payload.draft.content.body);
                    void run(() =>
                      ensureNativeApi().prHub.cancelReviewPreparation({
                        key: prKey,
                        accountGeneration,
                        id: operation.id,
                      }),
                    );
                  }}
                >
                  Back to draft
                </Button>
              ) : null}
            </div>
          ) : (
            <>
              <p className="text-sm">
                GitHub may have accepted this review. Automatic retry is disabled. The saved
                submission remains available for recovery.
              </p>
              <Button
                size="sm"
                variant="outline"
                disabled={busy || query.isFetching}
                onClick={() => void query.refetch()}
              >
                Check GitHub result
              </Button>
            </>
          )}
          {operation.status !== "prepared" ? (
            <PrOperationRecovery
              key={operation.id}
              kind="review"
              busy={busy}
              onRecover={(action, remoteId) =>
                void run(() =>
                  ensureNativeApi().prHub.recoverReview({
                    key: prKey,
                    accountGeneration,
                    id: operation.id,
                    action,
                    ...(remoteId ? { remoteId } : {}),
                  }),
                )
              }
            />
          ) : null}
        </>
      ) : (
        <>
          {operation?.status === "succeeded" ? (
            <p role="status" className="text-sm">
              Review submitted to GitHub.
              {operation.comparisonStatus === "outdated"
                ? " The PR comparison changed during submission; this review covers the earlier revision."
                : operation.comparisonStatus === "unverified"
                  ? " The current PR comparison could not be checked; the submitted revision remains recorded."
                  : ""}
            </p>
          ) : null}
          {operation?.status === "abandoned" ? (
            <p role="status" className="text-sm">
              Recovery abandoned. The draft and operation record are preserved; GitHub may still
              contain the earlier review.
            </p>
          ) : null}
          {operation?.status === "rejected" ? (
            <p role="status" className="text-sm">
              GitHub rejected review creation. Your draft is preserved.
            </p>
          ) : null}
          {quickEvent ? (
            <Textarea
              aria-label="Quick review note"
              value={quickBody}
              onChange={(e) => setQuickBody(e.currentTarget.value)}
              placeholder={
                quickEvent === "APPROVE" ? "Optional review note" : "Describe the requested changes"
              }
              disabled={busy || query.isFetching}
            />
          ) : (
            <label className="flex items-center gap-2 text-sm">
              Review outcome
              <select
                aria-label="Review outcome"
                className="rounded border border-border bg-background p-1"
                value={event}
                disabled={busy || draft?.frozen}
                onChange={(e) => setEvent(e.target.value as typeof event)}
              >
                <option value="COMMENT">Comment</option>
                <option value="APPROVE">Approve</option>
                <option value="REQUEST_CHANGES">Request changes</option>
              </select>
            </label>
          )}
          <Button
            size="sm"
            disabled={
              disabled ||
              busy ||
              query.isFetching ||
              Boolean(query.error) ||
              (quickEvent
                ? quickEvent === "REQUEST_CHANGES" && !quickBody.trim()
                : !draft || draft.frozen)
            }
            onClick={() => {
              if (quickEvent) {
                void run(async () => {
                  const files = await ensureNativeApi().prHub.getFiles({
                    key: prKey,
                    accountGeneration,
                    mode: "force",
                  });
                  if (!files.comparison || !accountGeneration)
                    throw new Error(
                      "The account and current PR comparison must be verified before preparing a review.",
                    );
                  return ensureNativeApi().prHub.prepareQuickReview({
                    key: prKey,
                    accountGeneration: accountGeneration!,
                    id: crypto.randomUUID(),
                    event: quickEvent,
                    body: quickBody,
                    expectedComparison: files.comparison,
                  });
                });
              } else if (draft)
                void run(() =>
                  ensureNativeApi().prHub.prepareReview({
                    key: prKey,
                    accountGeneration,
                    id: crypto.randomUUID(),
                    expectedVersion: draft.version,
                    event,
                  }),
                );
            }}
          >
            Preview review
          </Button>
        </>
      )}
    </div>
  );
}
