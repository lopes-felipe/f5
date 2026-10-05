import { PrViewedFile } from "./PrViewedFile";
import { ForgeComposer } from "./ForgeControls";
import { CopyPathButton } from "../CopyPathButton";
import { MiddleTruncate } from "../MiddleTruncate";
import { ChangedFileTree } from "../ChangedFileTree";
import { useAppSettings } from "../../appSettings";
import { getPrHubAccountGeneration } from "../../lib/prHubAccount";
import type { PrReviewAnchor } from "@t3tools/shared/prReview";
import { PrReviewDraftEditor } from "./PrReviewDraftEditor";
import { lazy, Suspense, useState } from "react";
import { useInfiniteQuery } from "@tanstack/react-query";
import { AlertTriangleIcon, FileIcon, LoaderCircleIcon } from "lucide-react";
import type { TrackedPullRequest } from "@t3tools/contracts";

import { prHubFilesQueryOptions } from "../../lib/prHubReactQuery";
import { Alert, AlertDescription, AlertTitle } from "../ui/alert";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";

const LazyPrFileDiff = lazy(() =>
  import("./PrFileDiff").then((module) => ({ default: module.PrFileDiff })),
);

export function PrFilesTab({ pr, active }: { pr: TrackedPullRequest; active: boolean }) {
  const { settings, updateSettings } = useAppSettings();
  const [selectedAnchor, setSelectedAnchor] = useState<
    (PrReviewAnchor & { nonce: string; scope: string }) | null
  >(null);
  const [comparisonMode, setComparisonMode] = useState<"current_pr" | "changes_since_review">(
    "current_pr",
  );
  const [expandedOverrides, setExpandedOverrides] = useState<Record<string, boolean>>({});
  const query = useInfiniteQuery({
    ...prHubFilesQueryOptions(pr.key, comparisonMode),
    enabled: active,
  });
  const pages = query.data?.pages ?? [];
  const files = pages.flatMap((page) => page.files);
  const selectionScope = JSON.stringify([
    pr.key,
    getPrHubAccountGeneration(),
    pages[0]?.comparison,
  ]);
  const isExpanded = (path: string) =>
    expandedOverrides[`${selectionScope}:${path}`] ?? settings.diffFileDefaultState === "expanded";
  const toggleExpanded = (path: string) =>
    setExpandedOverrides((previous) => ({
      ...previous,
      [`${selectionScope}:${path}`]: !isExpanded(path),
    }));
  const warning = pages.find((page) => page.warning)?.warning;

  if (query.isPending) {
    return (
      <div className="flex items-center gap-2 py-4 text-sm text-muted-foreground" role="tabpanel">
        <LoaderCircleIcon className="size-4 animate-spin" /> Loading changed files…
      </div>
    );
  }
  if (query.isError) {
    return (
      <Alert variant="error" role="tabpanel">
        <AlertTriangleIcon />
        <AlertTitle>Changed files unavailable</AlertTitle>
        <AlertDescription>
          <span>{query.error instanceof Error ? query.error.message : "GitHub files failed."}</span>
          <Button size="xs" variant="outline" onClick={() => void query.refetch()}>
            Retry
          </Button>
          {comparisonMode === "changes_since_review" ? (
            <Button size="xs" variant="outline" onClick={() => setComparisonMode("current_pr")}>
              Return to current PR
            </Button>
          ) : null}
        </AlertDescription>
      </Alert>
    );
  }

  return (
    <div className="space-y-3" role="tabpanel" aria-label="Files">
      <p className="text-xs text-muted-foreground" aria-live="polite">
        {comparisonMode === "current_pr" ? (
          <>
            {files.length} of {pr.changedFiles} changed files loaded ·{" "}
            <span className="text-diff-addition">+{pr.additions}</span> /{" "}
            <span className="text-diff-deletion">−{pr.deletions}</span>
          </>
        ) : (
          <>
            {files.length} changed files loaded{query.hasNextPage ? " · more available" : ""}
          </>
        )}
        {pages.some((page) => page.providerCapped) ? " · provider file limit reached" : ""}
      </p>
      <ChangedFileTree
        scope={`pr:${pr.host}/${pr.repository.nameWithOwner}`}
        files={files}
        onSelect={(path) => {
          setExpandedOverrides((previous) => ({
            ...previous,
            [`${selectionScope}:${path}`]: true,
          }));
          window.requestAnimationFrame(() =>
            Array.from(document.querySelectorAll<HTMLElement>("[data-pr-file-path]"))
              .find(
                (element) =>
                  element.dataset.prFilePath === path && element.dataset.prKey === pr.key,
              )
              ?.scrollIntoView({ block: "start" }),
          );
        }}
      />
      <label className="flex items-center gap-2 text-xs">
        <input
          type="checkbox"
          checked={settings.diffIgnoreWhitespace}
          onChange={(event) => updateSettings({ diffIgnoreWhitespace: event.target.checked })}
        />
        Hide whitespace-only hunks
      </label>
      <div className="flex gap-2">
        <Button
          size="xs"
          variant="outline"
          onClick={() =>
            setExpandedOverrides((previous) => ({
              ...previous,
              ...Object.fromEntries(files.map((file) => [`${selectionScope}:${file.path}`, true])),
            }))
          }
        >
          Expand all
        </Button>
        <Button
          size="xs"
          variant="outline"
          onClick={() =>
            setExpandedOverrides((previous) => ({
              ...previous,
              ...Object.fromEntries(files.map((file) => [`${selectionScope}:${file.path}`, false])),
            }))
          }
        >
          Collapse all
        </Button>
      </div>
      {pr.viewerHasReviewed ? (
        <div className="flex gap-2">
          <Button
            size="xs"
            variant={comparisonMode === "current_pr" ? "default" : "outline"}
            onClick={() => setComparisonMode("current_pr")}
          >
            Current PR
          </Button>
          <Button
            size="xs"
            variant={comparisonMode === "changes_since_review" ? "default" : "outline"}
            onClick={() => setComparisonMode("changes_since_review")}
          >
            Changes since my review
          </Button>
        </div>
      ) : null}
      {pr.provider === "github" &&
      !pr.repositoryArchived &&
      pages[0]?.comparison &&
      comparisonMode === "current_pr" ? (
        <PrReviewDraftEditor
          prKey={pr.key}
          prUrl={pr.url}
          comparison={pages[0].comparison}
          files={files}
          selectedAnchor={selectedAnchor?.scope === selectionScope ? selectedAnchor : null}
        />
      ) : null}
      {!pr.repositoryArchived && pages[0]?.comparison?.mode === "current_pr" ? (
        <p className="text-xs text-muted-foreground">
          Click a diff line number to draft an inline comment.
        </p>
      ) : null}
      {pr.provider !== "github" &&
      pr.forgeCapabilities?.review.inlineComment &&
      selectedAnchor?.scope === selectionScope ? (
        <ForgeComposer
          key={selectedAnchor.nonce}
          pr={pr}
          anchor={{
            baseOid: pages[0]?.comparison?.baseOid,
            path: selectedAnchor.path,
            line: selectedAnchor.line,
            side: selectedAnchor.side === "LEFT" ? "old" : "new",
          }}
        />
      ) : null}
      {warning ? (
        <Alert variant="warning">
          <AlertTriangleIcon />
          <AlertTitle>File coverage</AlertTitle>
          <AlertDescription>{warning}</AlertDescription>
        </Alert>
      ) : null}
      {files.length === 0 ? (
        <p className="py-4 text-sm text-muted-foreground">No changed files reported.</p>
      ) : (
        <div className="divide-y divide-border overflow-hidden rounded-lg border border-border">
          {files.map((file) => (
            <div key={file.path} data-pr-file-path={file.path} data-pr-key={pr.key}>
              <div className="flex items-center pr-2">
                <button
                  type="button"
                  aria-expanded={isExpanded(file.path)}
                  onClick={() => toggleExpanded(file.path)}
                  className="flex min-w-0 flex-1 items-center gap-3 px-3 py-2 text-left text-sm"
                >
                  <FileIcon className="size-4 shrink-0 text-muted-foreground" />
                  <MiddleTruncate className="flex-1 font-mono text-xs" text={file.path} />
                  <span className="shrink-0 tabular-nums">
                    <span className="text-diff-addition">+{file.additions}</span>{" "}
                    <span className="text-diff-deletion">−{file.deletions}</span>
                  </span>
                  <Badge variant="outline" size="sm">
                    {file.changeType}
                  </Badge>
                </button>
                {pages[0]?.comparison ? (
                  <PrViewedFile pr={pr} path={file.path} comparison={pages[0].comparison} />
                ) : null}
                <CopyPathButton path={file.path} />
              </div>
              {isExpanded(file.path) ? (
                <Suspense fallback={<p className="p-3 text-sm">Loading diff?</p>}>
                  <LazyPrFileDiff
                    file={file}
                    onComment={
                      pages[0]?.comparison?.mode === "current_pr" &&
                      (pr.provider === "github" || pr.forgeCapabilities?.review.inlineComment)
                        ? (anchor) =>
                            setSelectedAnchor({
                              ...anchor,
                              nonce: crypto.randomUUID(),
                              scope: selectionScope,
                            })
                        : undefined
                    }
                    scope={`${pr.key}:${JSON.stringify(pages[0]?.comparison)}`}
                    url={`${pr.url}/files`}
                  />
                </Suspense>
              ) : null}
            </div>
          ))}
        </div>
      )}
      {query.hasNextPage ? (
        <Button
          size="sm"
          variant="outline"
          disabled={query.isFetchingNextPage}
          onClick={() => void query.fetchNextPage()}
        >
          {query.isFetchingNextPage ? "Loading…" : "Load more files"}
        </Button>
      ) : null}
    </div>
  );
}
