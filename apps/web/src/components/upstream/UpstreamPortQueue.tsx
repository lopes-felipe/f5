import type { ProjectId, UpstreamOverview, UpstreamControlPortQueueInput } from "@t3tools/contracts";
import { useInfiniteQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";

import { ensureNativeApi } from "../../nativeApi";
import { upstreamPortsQueryKeys } from "../../lib/upstreamPortsReactQuery";
import { Button } from "../ui/button";
import { Dialog, DialogPopup, DialogHeader, DialogTitle, DialogDescription } from "../ui/dialog";
import { toastManager } from "../ui/toast";
import { ConfirmDialog } from "./UpstreamDialogs";

export function UpstreamPortQueue(props: { projectId: ProjectId; overview: UpstreamOverview; readOnly: boolean }) {
  const [open, setOpen] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [busy, setBusy] = useState(false);
  const navigate = useNavigate();
  const client = useQueryClient();
  const queue = props.overview.portQueue;
  const query = useInfiniteQuery({
    queryKey: upstreamPortsQueryKeys.queue(props.projectId),
    queryFn: ({ pageParam }) =>
      ensureNativeApi().upstreamPorts.getPortQueue({
        projectId: props.projectId,
        ...(pageParam ? { cursor: pageParam } : {}),
      }),
    initialPageParam: null as string | null,
    getNextPageParam: (page) => page.nextCursor,
    enabled: open,
    refetchInterval: (query) => {
      const data = query.state.data;
      const first = data?.pages[0];
      if (!open || !data || !first) return false;
      const unresolved =
        first.counts.queued + first.counts.executing + first.counts.needsAttention > 0 ||
        data.pages.some((page) =>
          page.entries.some(
            (entry) =>
              entry.status === "finished" &&
              entry.topics.some((topic) => !topic.superseded && topic.state === "in-progress"),
          ),
        ) ||
        (first.counts.awaitingReview > 0 && data.pages.at(-1)?.nextCursor !== null);
      return unresolved ? 120_000 : false;
    },
  });
  const control = async (action: UpstreamControlPortQueueInput["action"], entryId?: string) => {
    setBusy(true);
    try {
      if (action === "ignore-conflicts" && !entryId) throw new Error("Choose a queued entry.");
      await ensureNativeApi().upstreamPorts.controlPortQueue(
        action === "ignore-conflicts"
          ? { projectId: props.projectId, action, entryId: entryId! }
          : { projectId: props.projectId, action },
      );
      await Promise.all([
        client.invalidateQueries({ queryKey: upstreamPortsQueryKeys.queue(props.projectId) }),
        client.invalidateQueries({ queryKey: upstreamPortsQueryKeys.overview(props.projectId) }),
      ]);
    } catch (error) {
      toastManager.add({
        type: "error",
        title: "Could not update the port queue",
        description: String(error),
      });
    } finally {
      setBusy(false);
    }
  };
  const first = query.data?.pages[0];
  const threadLink = (id: string) => (
    <button
      type="button"
      className="underline"
      onClick={() => void navigate({ to: "/$threadId", params: { threadId: id } })}
    >
      {id}
    </button>
  );
  return (
    <>
      {(queue.hasHistory || queue.queuedTopics + queue.running > 0) && (
        <Button size="xs" variant="ghost" onClick={() => setOpen(true)}>
          Queue · {queue.running}/{queue.concurrency} running · {queue.queuedTopics} queued
          {queue.paused ? " · Paused" : queue.hold ? ` · Waiting: ${queue.hold.message}` : ""}
          {queue.waitingOnFiles > 0 ? ` · ${queue.waitingOnFiles} waiting on files` : ""}
        </Button>
      )}
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogPopup className="max-w-3xl">
          <DialogHeader>
            <DialogTitle>Port queue</DialogTitle>
            <DialogDescription>
              Threads refill as execution finishes. Topics become Done only when their trailers reach the default
              branch.
            </DialogDescription>
          </DialogHeader>
          <div className="max-h-[70vh] space-y-4 overflow-auto px-6 pb-6 text-sm">
            <div className="flex gap-2">
              <Button
                size="sm"
                variant="outline"
                disabled={props.readOnly || busy}
                onClick={() => void control(queue.paused ? "resume" : "pause")}
              >
                {queue.paused ? "Resume" : "Pause"}
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={props.readOnly || busy || queue.queuedTopics === 0}
                onClick={() => setClearing(true)}
              >
                Clear queue
              </Button>
            </div>
            {queue.pausedReason && <p role="alert">{queue.pausedReason}</p>}
            {queue.hold && (
              <p role="status">
                {queue.hold.message}
                {queue.hold.retryAt && ` Retry ${new Date(queue.hold.retryAt).toLocaleString()}.`}
              </p>
            )}
            {first && (
              <>
                <dl className="flex flex-wrap gap-3">
                  {Object.entries(first.counts).map(([key, value]) => (
                    <div key={key}>
                      <dt className="text-muted-foreground">
                        {(
                          {
                            awaitingReview: "Awaiting review",
                            needsAttention: "Needs attention",
                          } as Record<string, string>
                        )[key] ?? key}
                      </dt>
                      <dd>{value}</dd>
                    </div>
                  ))}
                </dl>
                <p>
                  Done on default branch: {first.doneOnDefaultBranch}
                  {first.baseEvidenceAt && ` · evidence ${new Date(first.baseEvidenceAt).toLocaleString()}`}
                </p>
                {first.baseRefreshError && (
                  <p role="alert" className="text-warning-foreground">
                    Could not refresh base evidence: {first.baseRefreshError}
                  </p>
                )}
              </>
            )}
            {query.error && <p role="alert">{String(query.error)}</p>}
            {query.isPending && <p>Loading queue…</p>}
            {query.data?.pages
              .flatMap((page) => page.entries)
              .map((entry) => (
                <article key={entry.entryId} className="space-y-2 rounded-md border p-3">
                  <p className="font-medium">
                    #{entry.position + 1} · {entry.status}
                    {entry.result && ` · ${entry.result}`} · {entry.fileCount} files
                  </p>
                  {entry.topics.map((topic) => (
                    <p key={topic.topicId}>
                      <a
                        className="underline"
                        href={`/upstream?project=${encodeURIComponent(props.projectId)}&list=${topic.state ?? "ready"}&topic=${encodeURIComponent(topic.topicId)}`}
                      >
                        {topic.title}
                      </a>
                      {topic.superseded ? " · superseded epoch" : topic.result ? ` · ${topic.result}` : ""}
                    </p>
                  ))}
                  {entry.threadId && <p>Thread: {threadLink(entry.threadId)}</p>}
                  {entry.prUrl && (
                    <a href={entry.prUrl} target="_blank" rel="noreferrer" className="underline">
                      Pull request
                    </a>
                  )}
                  {entry.reason && <p>{entry.reason}</p>}
                  {entry.waitingOn.length > 0 && (
                    <div>
                      <p>
                        Waiting on files changed by{" "}
                        {entry.waitingOn.map((other, i) => (
                          <span key={`${other.topicId}:${other.threadId}`}>
                            {i > 0 && ", "}
                            {other.prUrl ? (
                              <a className="underline" href={other.prUrl} target="_blank" rel="noreferrer">
                                {other.topicId} PR
                              </a>
                            ) : other.threadId ? (
                              threadLink(other.threadId)
                            ) : (
                              other.topicId
                            )}
                            {other.needsAttention && " (port needs attention)"}
                          </span>
                        ))}
                      </p>
                      <Button
                        size="xs"
                        variant="outline"
                        disabled={props.readOnly || busy}
                        onClick={() => void control("ignore-conflicts", entry.entryId)}
                      >
                        Start without waiting
                      </Button>
                    </div>
                  )}
                </article>
              ))}
            {query.hasNextPage && (
              <Button
                size="sm"
                variant="outline"
                disabled={query.isFetchingNextPage}
                onClick={() => void query.fetchNextPage()}
              >
                Load more
              </Button>
            )}
          </div>
        </DialogPopup>
      </Dialog>
      <ConfirmDialog
        request={
          clearing
            ? {
                title: "Clear queued ports?",
                description: "Cancel the remaining queued entries. Started threads continue running.",
                confirmLabel: "Clear queue",
                onConfirm: () => void control("clear"),
              }
            : null
        }
        onClose={() => setClearing(false)}
      />
    </>
  );
}
