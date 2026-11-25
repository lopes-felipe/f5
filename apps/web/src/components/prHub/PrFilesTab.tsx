import { PrViewedFile } from "./PrViewedFile";
import { PrChangeStat } from "./PrChangeStat";
import { describePrDiffError } from "./prDiffError";
import { forgeProviderLabel } from "./forgePresentation";
import { OpenLinkAnchor } from "../OpenLinkAnchor";
import { Empty, EmptyHeader, EmptyTitle, EmptyDescription } from "../ui/empty";
import { isTestChangedFile } from "@t3tools/shared/changedFileKind";
import { ForgeComposer } from "./ForgeControls";
import { CopyPathButton } from "../CopyPathButton";
import { MiddleTruncate } from "../MiddleTruncate";
import { ChangedFileTree, orderChangedFilesLikeTree } from "../ChangedFileTree";
import { useAppSettings } from "../../appSettings";
import { getPrHubAccountGeneration } from "../../lib/prHubAccount";
import { ensureNativeApi } from "../../nativeApi";
import type { PrReviewAnchor } from "@t3tools/shared/prReview";
import { PrReviewDraftEditor } from "./PrReviewDraftEditor";
import { lazy, Suspense, useMemo, useState } from "react";
import { useInfiniteQuery } from "@tanstack/react-query";
import { AlertTriangleIcon, FileIcon, LoaderCircleIcon } from "lucide-react";
import type { PrHubChangedFile, TrackedPullRequest } from "@t3tools/contracts";

import { prHubFilesQueryOptions } from "../../lib/prHubReactQuery";
import { Badge } from "../ui/badge";
import { Alert, AlertDescription, AlertTitle } from "../ui/alert";
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
    ...prHubFilesQueryOptions(pr, comparisonMode),
    enabled: active,
  });
  const pages = query.data?.pages ?? [];
  const liveComparison = query.isFetched ? pages[0]?.comparison : undefined;
  const loadedFiles = useMemo(() => {
    const byPath = new Map<string, PrHubChangedFile>();
    for (const page of query.data?.pages ?? []) {
      for (const file of page.files) {
        if (!byPath.has(file.path)) byPath.set(file.path, file);
      }
    }
    return orderChangedFilesLikeTree([...byPath.values()], settings.diffFileTreeOrder === "path");
  }, [query.data, settings.diffFileTreeOrder]);
  const selectionScope = JSON.stringify([
    pr.key,
    getPrHubAccountGeneration(),
    pages[0]?.comparison,
  ]);
  const selectedPath = selectedAnchor?.scope === selectionScope ? selectedAnchor.path : undefined;
  const testFileCount = loadedFiles.filter((file) => isTestChangedFile(file.path)).length;
  const files = settings.diffHideTestFiles
    ? loadedFiles.filter((file) => file.path === selectedPath || !isTestChangedFile(file.path))
    : loadedFiles;
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
    const error = query.error instanceof Error ? query.error.message : String(query.error);
    const providerName = forgeProviderLabel(pr.provider);
    const { title, description } = describePrDiffError(error, providerName);
    return (
      <Empty role="tabpanel" aria-label="Files" className="min-h-64">
        <AlertTriangleIcon />
        <EmptyHeader>
          <EmptyTitle>{title}</EmptyTitle>
          <EmptyDescription>{description}</EmptyDescription>
        </EmptyHeader>
        <div className="flex flex-wrap justify-center gap-2">
          <Button size="xs" variant="outline" onClick={() => void query.refetch()}>
            Retry
          </Button>
          <Button
            size="xs"
            variant="outline"
            render={<OpenLinkAnchor href={pr.url} target="_blank" rel="noopener noreferrer" />}
          >
            Open on {providerName}
          </Button>
          {comparisonMode === "changes_since_review" ? (
            <Button size="xs" variant="outline" onClick={() => setComparisonMode("current_pr")}>
              Return to current PR
            </Button>
          ) : null}
        </div>
        <details className="w-full max-w-lg text-xs text-muted-foreground">
          <summary className="cursor-pointer">Technical details</summary>
          <pre className="mt-3 max-h-40 overflow-auto whitespace-pre-wrap break-words rounded border p-3 text-left">
            {error}
          </pre>
        </details>
      </Empty>
    );
  }

  return (
    <div className="space-y-3" role="tabpanel" aria-label="Files">
      <p className="text-xs text-muted-foreground" aria-live="polite">
        {comparisonMode === "current_pr" ? (
          <>
            {loadedFiles.length} of {pr.changedFiles} changed files loaded ·{" "}
            <PrChangeStat pr={pr} eager />
          </>
        ) : (
          <>
            {loadedFiles.length} changed files loaded{query.hasNextPage ? " · more available" : ""}
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
      {testFileCount > 0 ? (
        <label className="flex items-center gap-2 text-xs">
          <input
            type="checkbox"
            checked={settings.diffHideTestFiles}
            onChange={(event) => updateSettings({ diffHideTestFiles: event.target.checked })}
          />
          Hide test files
          {loadedFiles.length > files.length
            ? ` (${loadedFiles.length - files.length} hidden)`
            : ""}
        </label>
      ) : null}
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
      liveComparison &&
      comparisonMode === "current_pr" ? (
        <PrReviewDraftEditor
          prKey={pr.key}
          prUrl={pr.url}
          comparison={liveComparison}
          files={loadedFiles}
          selectedAnchor={selectedAnchor?.scope === selectionScope ? selectedAnchor : null}
        />
      ) : null}
      {!pr.repositoryArchived && liveComparison?.mode === "current_pr" ? (
        <p className="text-xs text-muted-foreground">
          Click a diff line number to draft an inline comment.
        </p>
      ) : null}
      {pr.provider !== "github" &&
      pr.forgeCapabilities?.review.inlineComment &&
      liveComparison &&
      selectedAnchor?.scope === selectionScope ? (
        <ForgeComposer
          key={selectedAnchor.nonce}
          pr={pr}
          anchor={{
            baseOid: liveComparison.baseOid,
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
        <p className="py-4 text-sm text-muted-foreground">
          {loadedFiles.length > 0 ? "All loaded files are hidden." : "No changed files reported."}
        </p>
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
                {liveComparison ? (
                  <PrViewedFile pr={pr} path={file.path} comparison={liveComparison} />
                ) : null}
                <CopyPathButton path={file.path} />
              </div>
              {isExpanded(file.path) ? (
                <Suspense fallback={<p className="p-3 text-sm">Loading diff?</p>}>
                  <LazyPrFileDiff
                    key={selectionScope}
                    file={file}
                    loadDiff={
                      pr.provider === "github" && liveComparison
                        ? async () => {
                            const result = await ensureNativeApi().prHub.getFiles({
                              key: pr.key,
                              ...(getPrHubAccountGeneration()
                                ? { accountGeneration: getPrHubAccountGeneration()! }
                                : {}),
                              mode: "force",
                              comparisonMode,
                              fullDiffFile: { path: file.path, comparison: liveComparison },
                            });
                            const loaded = result.files.find(
                              (candidate) => candidate.path === file.path,
                            );
                            if (!loaded?.patch)
                              throw new Error(
                                "GitHub did not provide a renderable diff for this file.",
                              );
                            return loaded;
                          }
                        : undefined
                    }
                    onComment={
                      liveComparison?.mode === "current_pr" &&
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
          disabled={query.isFetchingNextPage || !query.isFetched}
          onClick={() => void query.fetchNextPage()}
        >
          {query.isFetchingNextPage ? "Loading…" : "Load more files"}
        </Button>
      ) : null}
    </div>
  );
}
