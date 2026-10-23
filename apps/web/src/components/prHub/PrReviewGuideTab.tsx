import { useState } from "react";
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { PullRequestReviewGuideResult, type TrackedPullRequest } from "@t3tools/contracts";
import { Schema } from "effect";
import { prReviewExcerpt } from "@t3tools/shared/prReview";
import { ensureNativeApi } from "../../nativeApi";
import { getPrHubAccountGeneration } from "../../lib/prHubAccount";
import { prHubFilesQueryOptions } from "../../lib/prHubReactQuery";
import { Button } from "../ui/button";

export function PrReviewGuideTab({ pr }: { pr: Pick<TrackedPullRequest, "key" | "headRefOid"> }) {
  const client = useQueryClient();
  const accountGeneration = getPrHubAccountGeneration();
  const queryKey = ["prHub", "reviewGuide", accountGeneration, pr.key];
  const [selected, setSelected] = useState(0);
  const query = useQuery({
    queryKey,
    queryFn: async () =>
      Schema.decodeUnknownSync(PullRequestReviewGuideResult)(
        await ensureNativeApi().prHub.getReviewGuide({ key: pr.key, accountGeneration }),
      ),
    retry: false,
    refetchInterval: (query) => (query.state.data?.run?._tag === "Running" ? 2000 : false),
  });
  const generate = useMutation({
    mutationFn: async () =>
      Schema.decodeUnknownSync(PullRequestReviewGuideResult)(
        await ensureNativeApi().prHub.generateReviewGuide({ key: pr.key, accountGeneration }),
      ),
    onSuccess: (result) => {
      client.setQueryData(queryKey, result);
      setSelected(0);
    },
  });
  const files = useInfiniteQuery({
    ...prHubFilesQueryOptions(pr.key),
    enabled: !!query.data?.guide,
  });
  const data = query.data;
  const guide = data?.guide;
  const activeIndex = Math.min(selected, Math.max(0, (guide?.stops.length ?? 0) - 1));
  const stop = guide?.stops[activeIndex];
  const running = generate.isPending || data?.run?._tag === "Running";
  const currentHead = data?.currentHeadSha ?? pr.headRefOid;
  const stale =
    !!guide &&
    ((!!currentHead && guide.headSha !== currentHead) ||
      !!files.data?.pages.some(
        (page) => page.comparison && page.comparison.headOid !== guide.headSha,
      ));
  const changedFiles = files.data?.pages.flatMap((page) => page.files) ?? [];
  return (
    <section aria-label="Guided review" className="flex min-w-0 flex-col gap-4">
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm text-muted-foreground">A guided review tour · Beta</p>
        <Button
          size="sm"
          disabled={running || query.isPending || query.isError}
          onClick={() => generate.mutate()}
        >
          {running ? "Generating guide…" : guide ? "Regenerate guide" : "Generate guide"}
        </Button>
      </div>
      {query.isError ? (
        <div role="alert">
          Could not load the guide.{" "}
          <Button size="xs" onClick={() => void query.refetch()}>
            Retry
          </Button>
        </div>
      ) : null}
      {generate.isError ? <p role="alert">Could not start guide generation. Try again.</p> : null}
      {data?.run?._tag === "Failed" ? <p role="alert">{data.run.detail}</p> : null}
      {stale ? (
        <p role="status" className="rounded border border-warning p-3 text-sm">
          This guide describes an older PR head. Regenerate it before relying on its line
          references.
        </p>
      ) : null}
      {!guide && !query.isPending && !running && !query.isError ? (
        <p className="text-sm text-muted-foreground">
          Generate a tour of the changed files, contracts and review questions.
        </p>
      ) : null}
      {guide && stop ? (
        <div className="grid min-w-0 gap-4 md:grid-cols-[12rem_minmax(0,1fr)]">
          <nav aria-label="Review stops" className="flex flex-col gap-1">
            {guide.stops.map((entry, index) => (
              <button
                type="button"
                key={index}
                aria-current={activeIndex === index ? "step" : undefined}
                className={`rounded p-2 text-left text-sm ${activeIndex === index ? "bg-secondary font-medium" : "hover:bg-secondary/50"}`}
                onClick={() => setSelected(index)}
              >
                {index + 1}. {entry.title}
              </button>
            ))}
          </nav>
          <article className="min-w-0 space-y-4" aria-label={stop.title}>
            <h3 className="text-lg font-semibold">{stop.title}</h3>
            <p className="whitespace-pre-wrap text-sm">{stop.summary}</p>
            {stop.attention ? (
              <p className="rounded border border-border p-3 text-sm">
                <strong>{stop.attention.kind}: </strong>
                {stop.attention.note}
              </p>
            ) : null}
            {stop.excerpts.map((excerpt, index) => {
              const file = changedFiles.find((file) => file.path === excerpt.path);
              const lines =
                !stale && file?.patch
                  ? prReviewExcerpt(file.patch, excerpt.side, excerpt.start, excerpt.end)
                  : [];
              return (
                <figure key={index} className="min-w-0 space-y-2">
                  <figcaption className="break-all font-mono text-xs">
                    {excerpt.path} · {excerpt.side} {excerpt.start}–{excerpt.end}
                  </figcaption>
                  {excerpt.caption ? <p className="text-sm">{excerpt.caption}</p> : null}
                  {lines.length ? (
                    <pre className="overflow-auto rounded border border-border p-3 text-xs">
                      {lines.map((line) => `${line.line}  ${line.text}`).join("\n")}
                    </pre>
                  ) : (
                    <p className="text-xs text-muted-foreground">
                      {stale
                        ? "Excerpt hidden because the PR head changed."
                        : "Excerpt unavailable in the loaded diff."}
                    </p>
                  )}
                </figure>
              );
            })}
            {stop.files.length ? (
              <ul className="list-inside list-disc text-sm">
                {stop.files.map((file) => (
                  <li key={file.path}>
                    <code>{file.path}</code>
                    {file.note ? ` — ${file.note}` : ""}
                  </li>
                ))}
              </ul>
            ) : null}
            {stop.notes.map((note, index) => (
              <div key={index} className="rounded border border-border p-3 text-sm">
                <h4 className="font-medium">{note.title}</h4>
                <p className="font-mono text-xs">
                  {note.path}:{note.line}
                </p>
                <p className="whitespace-pre-wrap">{note.body}</p>
              </div>
            ))}
            {stop.questions.length ? (
              <ul className="list-inside list-disc text-sm">
                {stop.questions.map((question, index) => (
                  <li key={index}>{question}</li>
                ))}
              </ul>
            ) : null}
            {files.hasNextPage ? (
              <Button
                size="xs"
                disabled={files.isFetchingNextPage}
                onClick={() => void files.fetchNextPage()}
              >
                Load more changed files
              </Button>
            ) : null}
            {files.isError ? (
              <Button size="xs" onClick={() => void files.refetch()}>
                Retry loading excerpts
              </Button>
            ) : null}
            <div className="flex justify-between">
              <Button
                size="xs"
                disabled={activeIndex === 0}
                onClick={() => setSelected(activeIndex - 1)}
              >
                Previous stop
              </Button>
              <Button
                size="xs"
                disabled={activeIndex + 1 >= guide.stops.length}
                onClick={() => setSelected(activeIndex + 1)}
              >
                Next stop
              </Button>
            </div>
          </article>
        </div>
      ) : null}
    </section>
  );
}
