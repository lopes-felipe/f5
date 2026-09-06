import { PrOperationRecovery } from "./PrOperationRecovery";
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { PrHubReplyDraft, PullRequestKey } from "@t3tools/contracts";
import { usePrReplyDraft } from "./usePrReplyDraft";
import { prReplyBody } from "@t3tools/shared/prReview";
import { ensureNativeApi } from "../../nativeApi";
import { getPrHubAccountGeneration } from "../../lib/prHubAccount";
import { Button } from "../ui/button";
import { Textarea } from "../ui/textarea";

type Props = {
  prKey: PullRequestKey;
  threadId: string;
  comparisonVersion: string;
};
export function PrThreadReply(props: Props) {
  const generation = getPrHubAccountGeneration();
  const query = useQuery({
    queryKey: ["prHub", "replyDraft", generation, props.prKey, props.threadId],
    queryFn: () =>
      ensureNativeApi().prHub.getReplyDraft({
        key: props.prKey,
        threadId: props.threadId,
        accountGeneration: generation,
      }),
    staleTime: 0,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
  if (query.isPending || query.isFetching) return <p>Loading saved reply…</p>;
  if (query.isError)
    return (
      <p role="alert">
        {query.error.message}{" "}
        <Button size="xs" onClick={() => void query.refetch()}>
          Reload reply draft
        </Button>
      </p>
    );
  return (
    <ReplyEditor
      key={`${generation}:${props.prKey}:${props.threadId}`}
      {...props}
      initialDraft={query.data}
    />
  );
}

function ReplyEditor({
  prKey,
  threadId,
  comparisonVersion,
  initialDraft,
}: Props & { initialDraft: PrHubReplyDraft | null }) {
  const generation = getPrHubAccountGeneration();
  const queryClient = useQueryClient();
  const queryKey = ["prHub", "threadReply", generation, prKey, threadId];
  const query = useQuery({
    queryKey,
    queryFn: () =>
      ensureNativeApi().prHub.getReplyOperation({
        key: prKey,
        accountGeneration: generation,
        threadId,
      }),
    retry: false,
  });
  const [id, setId] = useState(() => crypto.randomUUID());
  const [revalidated, setRevalidated] = useState(false);
  const draft = usePrReplyDraft({
    key: prKey,
    threadId,
    accountGeneration: generation,
    comparisonVersion:
      initialDraft?.body && !revalidated ? initialDraft.comparisonVersion : comparisonVersion,
    initial: initialDraft,
  });
  const { body, setBody } = draft;
  const stale =
    initialDraft !== null &&
    initialDraft.body.length > 0 &&
    initialDraft.comparisonVersion !== comparisonVersion &&
    !revalidated;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pending =
    query.data &&
    query.data.status !== "succeeded" &&
    query.data.status !== "rejected" &&
    query.data.status !== "abandoned";
  async function reply() {
    setBusy(true);
    setError(null);
    try {
      const result = await ensureNativeApi().prHub.replyReviewThread({
        key: prKey,
        accountGeneration: generation,
        threadId,
        id,
        body,
        comparisonVersion,
      });
      queryClient.setQueryData(queryKey, result);
      if (result.status === "succeeded") {
        setBody("");
        await draft.flush();
        setId(crypto.randomUUID());
        await queryClient.invalidateQueries({
          queryKey: ["prHub", "reviewThreads", generation, prKey],
        });
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Reply failed; check its saved status.");
      await query.refetch();
    } finally {
      setBusy(false);
    }
  }
  async function recover(action: "link" | "abandon", remoteId?: string) {
    if (!query.data) return;
    setBusy(true);
    setError(null);
    try {
      const result = await ensureNativeApi().prHub.recoverReply({
        key: prKey,
        accountGeneration: generation,
        threadId,
        id: query.data.id,
        action,
        ...(remoteId ? { remoteId } : {}),
      });
      queryClient.setQueryData(queryKey, result);
      setId(crypto.randomUUID());
      if (result.status === "succeeded") {
        setBody("");
        await draft.flush();
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Reply recovery failed.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="space-y-2 border-t border-border pt-2">
      {draft.error ? <p role="alert">{draft.error}</p> : null}
      {draft.canRetry ? (
        <Button size="xs" onClick={() => void draft.retry()}>
          Retry saving reply draft
        </Button>
      ) : null}
      <p className="text-xs text-muted-foreground">
        {draft.saving || !draft.saved ? "Saving reply draft…" : "Reply draft saved"}
      </p>
      {stale ? (
        <label className="flex gap-2 text-sm">
          <input
            type="checkbox"
            checked={revalidated}
            onChange={(event) => setRevalidated(event.target.checked)}
          />
          The comparison changed. I checked this thread and still want to send this reply.
        </label>
      ) : null}
      {error || query.error ? (
        <p role="alert" className="text-sm">
          {error ?? query.error?.message}
        </p>
      ) : null}
      {pending && query.data ? (
        <>
          <p className="text-sm">This reply may have been accepted. It will not be sent again.</p>
          <pre className="whitespace-pre-wrap text-xs">{query.data.body}</pre>
          <Button
            size="xs"
            variant="outline"
            disabled={query.isFetching}
            onClick={() => void query.refetch()}
          >
            Check reply result
          </Button>
          <PrOperationRecovery
            key={query.data.id}
            kind="reply"
            busy={busy || query.isFetching}
            onRecover={(action, remoteId) => void recover(action, remoteId)}
          />
        </>
      ) : (
        <>
          <Textarea
            aria-label="Reply to review thread"
            value={body}
            disabled={busy || query.isPending || query.isError}
            maxLength={65_536}
            onChange={(event) => setBody(event.target.value)}
          />
          {body.trim() ? (
            <pre aria-label="Reply preview" className="whitespace-pre-wrap text-xs">
              {prReplyBody(body, id)}
            </pre>
          ) : null}
          <Button
            size="xs"
            disabled={
              busy || query.isPending || query.isError || !body.trim() || !draft.saved || stale
            }
            onClick={() => void reply()}
          >
            Post reply to GitHub
          </Button>
        </>
      )}
      {query.error ? (
        <Button size="xs" variant="outline" onClick={() => void query.refetch()}>
          Retry reply status
        </Button>
      ) : null}
    </div>
  );
}
