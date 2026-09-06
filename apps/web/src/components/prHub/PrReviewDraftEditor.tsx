import { prComparisonsEqual } from "@t3tools/shared/prReview";
import { PrReviewSubmit } from "./PrReviewSubmit";
import type { PrReviewAnchor } from "@t3tools/shared/prReview";
import { Button } from "../ui/button";
import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  PrHubChangedFile,
  PrHubComparisonIdentity,
  PrHubReviewDraft,
  PullRequestKey,
} from "@t3tools/contracts";
import { ensureNativeApi } from "../../nativeApi";
import { getPrHubAccountGeneration } from "../../lib/prHubAccount";
import { Textarea } from "../ui/textarea";

export function PrReviewDraftEditor({
  prKey,
  prUrl,
  comparison,
  selectedAnchor,
  files,
}: {
  prKey: PullRequestKey;
  prUrl: string;
  comparison: PrHubComparisonIdentity;
  files?: readonly PrHubChangedFile[] | undefined;
  selectedAnchor?: (PrReviewAnchor & { nonce: string }) | null | undefined;
}) {
  const accountGeneration = getPrHubAccountGeneration();
  const query = useQuery({
    queryKey: ["prHub", "reviewDraft", accountGeneration, prKey],
    queryFn: () => ensureNativeApi().prHub.getReviewDraft({ key: prKey, accountGeneration }),
  });
  if (query.isPending)
    return <p className="text-sm text-muted-foreground">Loading review draft…</p>;
  if (query.isError)
    return (
      <p role="alert" className="text-sm">
        The saved review draft could not be loaded. {query.error.message}
      </p>
    );
  return (
    <DraftEditor
      key={`${accountGeneration}:${prKey}`}
      prKey={prKey}
      prUrl={prUrl}
      accountGeneration={accountGeneration}
      comparison={comparison}
      initialDraft={query.data.draft}
      selectedAnchor={selectedAnchor}
      files={files}
    />
  );
}

function DraftEditor({
  prKey,
  prUrl,
  accountGeneration,
  comparison,
  initialDraft,
  selectedAnchor,
  files,
}: {
  prKey: PullRequestKey;
  prUrl: string;
  accountGeneration: string | undefined;
  comparison: PrHubComparisonIdentity;
  files?: readonly PrHubChangedFile[] | undefined;
  initialDraft: PrHubReviewDraft | null;
  selectedAnchor?: (PrReviewAnchor & { nonce: string }) | null | undefined;
}) {
  const queryClient = useQueryClient();
  const [reviewBusy, setReviewBusy] = useState(false);
  const [confirmedAnchors, setConfirmedAnchors] = useState<ReadonlySet<string>>(new Set());
  const [reanchorId, setReanchorId] = useState<string | null>(null);
  useEffect(() => {
    setConfirmedAnchors(new Set());
    setReanchorId(null);
  }, [comparison]);
  const [draft, setDraft] = useState(initialDraft);
  const [content, setContent] = useState<PrHubReviewDraft["content"]>(
    initialDraft?.content ?? { body: "", comments: [], viewedFiles: [] },
  );
  const [savedContent, setSavedContent] = useState(JSON.stringify(content));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mounted = useRef(true);
  const pending = useRef({
    draft: initialDraft,
    content,
    savedContent: JSON.stringify(content),
    saving: false,
    failed: false,
  });
  useEffect(() => {
    const state = pending.current;
    if (
      initialDraft &&
      (initialDraft.version > (state.draft?.version ?? 0) ||
        (initialDraft.version === state.draft?.version &&
          initialDraft.frozen !== state.draft.frozen)) &&
      !state.saving &&
      JSON.stringify(state.content) === state.savedContent
    ) {
      state.draft = initialDraft;
      state.content = initialDraft.content;
      state.savedContent = JSON.stringify(initialDraft.content);
      setDraft(initialDraft);
      setContent(initialDraft.content);
      setSavedContent(JSON.stringify(initialDraft.content));
    }
  }, [initialDraft]);
  const flush = useRef<() => void>(() => {});
  flush.current = () => {
    const state = pending.current;
    if (
      state.saving ||
      state.failed ||
      state.draft?.frozen ||
      JSON.stringify(state.content) === state.savedContent
    )
      return;
    state.saving = true;
    const sentContent = state.content;
    if (mounted.current) setSaving(true);
    void ensureNativeApi()
      .prHub.saveReviewDraft({
        key: prKey,
        accountGeneration,
        expectedVersion: state.draft?.version ?? 0,
        comparison: state.draft?.comparison ?? comparison,
        content: sentContent,
      })
      .then((result) => {
        if (result.status !== "ok")
          throw new Error(
            result.status === "frozen"
              ? "This draft is frozen for submission. Your local text is preserved."
              : "Another window changed this draft. Your local text is preserved; reopen the PR to load the saved version.",
          );
        state.draft = result.draft;
        state.savedContent = JSON.stringify(sentContent);
        queryClient.setQueryData(["prHub", "reviewDraft", accountGeneration, prKey], result);
        if (mounted.current) {
          setDraft(result.draft);
          setSavedContent(JSON.stringify(sentContent));
        }
      })
      .catch((cause: unknown) => {
        state.failed = true;
        if (mounted.current)
          setError(
            cause instanceof Error
              ? cause.message
              : "Draft save failed. Your text is preserved here.",
          );
      })
      .finally(() => {
        state.saving = false;
        if (mounted.current) setSaving(false);
        // Finish edits queued during a save, including after in-app navigation.
        flush.current();
      });
  };
  useEffect(() => {
    mounted.current = true;
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (JSON.stringify(pending.current.content) !== pending.current.savedContent) {
        event.preventDefault();
        event.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", beforeUnload);
    return () => {
      mounted.current = false;
      window.removeEventListener("beforeunload", beforeUnload);
      flush.current();
    };
  }, []);
  useEffect(() => {
    const timer = setTimeout(() => flush.current(), 500);
    return () => clearTimeout(timer);
  }, [content]);
  const stale = draft !== null && !prComparisonsEqual(draft.comparison, comparison);
  function updateContent(next: PrHubReviewDraft["content"]) {
    pending.current.content = next;
    setContent(next);
  }
  const handledAnchor = useRef<string | null>(null);
  useEffect(() => {
    if (!selectedAnchor || handledAnchor.current === selectedAnchor.nonce) return;
    handledAnchor.current = selectedAnchor.nonce;
    if (pending.current.draft?.frozen || comparison.mode !== "current_pr") return;
    if (stale) {
      if (!reanchorId) return;
      updateContent({
        ...pending.current.content,
        comments: pending.current.content.comments.map((item) =>
          item.id === reanchorId
            ? {
                id: item.id,
                body: item.body,
                commitOid: item.commitOid,
                path: selectedAnchor.path,
                side: selectedAnchor.side,
                line: selectedAnchor.line,
              }
            : item,
        ),
      });
      setConfirmedAnchors((previous) => new Set([...previous, reanchorId]));
      setReanchorId(null);
      return;
    }
    const current = pending.current.content;
    if (current.comments.length >= 100) return;
    updateContent({
      ...current,
      comments: [
        ...current.comments,
        {
          id: selectedAnchor.nonce,
          path: selectedAnchor.path,
          side: selectedAnchor.side,
          line: selectedAnchor.line,
          commitOid: comparison.headOid,
          body: "",
        },
      ],
    });
  }, [selectedAnchor, stale, comparison, reanchorId]);
  async function revalidate() {
    const state = pending.current;
    if (
      !state.draft ||
      state.saving ||
      state.draft.frozen ||
      JSON.stringify(state.content) !== state.savedContent
    )
      return;
    state.saving = true;
    setSaving(true);
    setError(null);
    try {
      const result = await ensureNativeApi().prHub.saveReviewDraft({
        key: prKey,
        accountGeneration,
        expectedVersion: state.draft.version,
        comparison,
        revalidate: true,
        content: {
          ...state.content,
          comments: state.content.comments.map((item) => ({
            ...item,
            commitOid: comparison.headOid,
          })),
        },
      });
      if (result.status !== "ok" || !result.draft)
        throw new Error("The draft changed in another window. Reopen it before revalidating.");
      state.draft = result.draft;
      state.content = result.draft.content;
      state.savedContent = JSON.stringify(result.draft.content);
      state.failed = false;
      setDraft(result.draft);
      setContent(result.draft.content);
      setSavedContent(state.savedContent);
      queryClient.setQueryData(["prHub", "reviewDraft", accountGeneration, prKey], result);
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Anchor revalidation failed. Draft text is preserved.",
      );
    } finally {
      state.saving = false;
      setSaving(false);
    }
  }
  return (
    <div className="space-y-2 rounded-lg border border-border p-3">
      <label className="text-sm font-medium" htmlFor="pr-review-draft">
        Review draft
      </label>
      {stale ? (
        <p role="status" className="text-sm text-warning-foreground">
          The comparison changed. Draft text is preserved; inline anchors require revalidation
          before submission.
        </p>
      ) : null}
      <Textarea
        id="pr-review-draft"
        value={content.body}
        maxLength={65_536}
        disabled={draft?.frozen || reviewBusy || saving}
        onChange={(event) => {
          updateContent({ ...pending.current.content, body: event.target.value });
        }}
        placeholder="Write review notes…"
      />
      {content.comments.map((comment) => (
        <div key={comment.id} className="space-y-1 rounded border border-border p-2">
          <label htmlFor={`pr-comment-${comment.id}`} className="text-xs font-mono">
            {comment.path}:{comment.line} ({comment.side === "LEFT" ? "old" : "new"})
          </label>
          <Textarea
            id={`pr-comment-${comment.id}`}
            value={comment.body}
            disabled={draft?.frozen || reviewBusy || saving}
            maxLength={65_536}
            placeholder="Write an inline review comment?"
            onChange={(event) =>
              updateContent({
                ...pending.current.content,
                comments: pending.current.content.comments.map((item) =>
                  item.id === comment.id ? { ...item, body: event.target.value } : item,
                ),
              })
            }
          />
          <label className="flex items-center gap-2 text-xs">
            Range start (optional)
            <input
              type="number"
              aria-label={`Range start for ${comment.path}:${comment.line}`}
              min={1}
              max={comment.line}
              value={comment.startLine ?? ""}
              disabled={saving || reviewBusy || draft?.frozen}
              className="w-24 rounded border border-border bg-background px-2"
              onChange={(event) => {
                const value = event.target.value;
                const startLine = Number(value);
                if (
                  value &&
                  (!Number.isSafeInteger(startLine) || startLine < 1 || startLine > comment.line)
                )
                  return;
                updateContent({
                  ...pending.current.content,
                  comments: pending.current.content.comments.map((item) => {
                    if (item.id !== comment.id) return item;
                    const { startLine: _line, startSide: _side, ...single } = item;
                    return value ? { ...single, startLine, startSide: item.side } : single;
                  }),
                });
                setConfirmedAnchors((previous) => {
                  const next = new Set(previous);
                  next.delete(comment.id);
                  return next;
                });
              }}
            />{" "}
            Same side, ending at line {comment.line}
          </label>
          {stale ? (
            <div className="flex items-center gap-2 text-xs">
              <label>
                <input
                  type="checkbox"
                  checked={confirmedAnchors.has(comment.id)}
                  disabled={saving || draft?.frozen}
                  onChange={(event) =>
                    setConfirmedAnchors((previous) => {
                      const next = new Set(previous);
                      if (event.target.checked) next.add(comment.id);
                      else next.delete(comment.id);
                      return next;
                    })
                  }
                />{" "}
                I checked this anchor against the current diff
              </label>
              <Button
                size="xs"
                variant="outline"
                disabled={saving || draft?.frozen}
                onClick={() => setReanchorId(comment.id)}
              >
                {reanchorId === comment.id
                  ? "Click a replacement diff line"
                  : "Choose replacement line"}
              </Button>
            </div>
          ) : null}
          <Button
            size="xs"
            variant="outline"
            disabled={draft?.frozen || reviewBusy || saving}
            onClick={() =>
              updateContent({
                ...pending.current.content,
                comments: pending.current.content.comments.filter((item) => item.id !== comment.id),
              })
            }
          >
            Remove draft comment
          </Button>
        </div>
      ))}
      {stale ? (
        <Button
          size="sm"
          variant="outline"
          disabled={
            saving ||
            reviewBusy ||
            draft?.frozen ||
            JSON.stringify(content) !== savedContent ||
            content.comments.some((item) => !confirmedAnchors.has(item.id))
          }
          onClick={() => void revalidate()}
        >
          Revalidate draft against current comparison
        </Button>
      ) : null}
      {files?.length ? (
        <details className="text-xs">
          <summary>Viewed files ({content.viewedFiles.length})</summary>
          <div className="max-h-40 overflow-auto space-y-1 py-2">
            {files.map((file) => (
              <label key={file.path} className="flex items-center gap-2">
                <input
                  type="checkbox"
                  disabled={stale || saving || reviewBusy || draft?.frozen || !file.blobOid}
                  checked={content.viewedFiles.some(
                    (viewed) => viewed.path === file.path && viewed.blobOid === file.blobOid,
                  )}
                  onChange={(event) => {
                    const viewedFiles = pending.current.content.viewedFiles.filter(
                      (viewed) => viewed.path !== file.path,
                    );
                    if (event.target.checked && file.blobOid)
                      viewedFiles.push({ path: file.path, blobOid: file.blobOid });
                    updateContent({ ...pending.current.content, viewedFiles });
                  }}
                />
                {file.path}
              </label>
            ))}
          </div>
        </details>
      ) : null}
      <PrReviewSubmit
        prKey={prKey}
        prUrl={prUrl}
        draft={draft}
        disabled={stale || saving || Boolean(error) || JSON.stringify(content) !== savedContent}
        onBusyChange={setReviewBusy}
      />
      <p role="status" className="text-xs text-muted-foreground">
        {error ??
          (saving || JSON.stringify(content) !== savedContent
            ? "Saving draft…"
            : draft
              ? "Draft saved in F5"
              : "Drafts save automatically in F5")}
      </p>
    </div>
  );
}
