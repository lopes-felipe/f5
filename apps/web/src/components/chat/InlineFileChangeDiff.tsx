import { FileDiff } from "@pierre/diffs/react";
import { useQuery } from "@tanstack/react-query";
import {
  type OrchestrationGetTurnDiffResult,
  type ThreadId,
  type TurnId,
} from "@t3tools/contracts";
import { ChevronRightIcon } from "lucide-react";
import { memo, useCallback, useMemo } from "react";
import { openInPreferredEditor } from "../../editorPreferences";
import { useFileNavigation } from "../../fileNavigationContext";
import type { TurnDiffSummary } from "../../types";
import { readNativeApi } from "../../nativeApi";
import {
  buildFileDiffRenderKey,
  DIFF_PANEL_UNSAFE_CSS,
  getRenderablePatch,
  resolveFileDiffPath,
} from "../DiffPanel";
import { relativePathForDisplay } from "~/lib/attachedFiles";
import { resolveDiffThemeName } from "~/lib/diffRendering";
import { normalizeFilePathForDiffLookup } from "~/lib/normalizeFilePathForDiff";
import { checkpointDiffQueryOptions } from "~/lib/providerReactQuery";
import { resolvePathLinkTarget } from "../../terminal-links";
import { Button } from "../ui/button";
import { toastManager } from "../ui/toast";

interface InlineFileChangeDiffProps {
  workEntryId: string;
  threadId: ThreadId | null;
  turnId: TurnId;
  checkpointTurnCount: number | undefined;
  filePaths: readonly string[];
  workspaceRoot: string | undefined;
  resolvedTheme: "light" | "dark";
  turnDiffSummary: TurnDiffSummary | undefined;
  onOpenTurnDiff: (turnId: TurnId, filePath: string) => void;
}

function normalizeDiffLookupPath(filePath: string, workspaceRoot: string | undefined) {
  return normalizeFilePathForDiffLookup(filePath, workspaceRoot)?.path ?? null;
}

export const InlineFileChangeDiff = memo(function InlineFileChangeDiff(
  props: InlineFileChangeDiffProps,
) {
  const {
    workEntryId,
    threadId,
    turnId,
    checkpointTurnCount,
    filePaths,
    workspaceRoot,
    resolvedTheme,
    turnDiffSummary,
    onOpenTurnDiff,
  } = props;
  const handleFileNavigation = useFileNavigation();
  const diffUnavailable =
    threadId === null || typeof checkpointTurnCount !== "number" || filePaths.length === 0;

  const checkpointDiffQuery = useQuery(
    checkpointDiffQueryOptions({
      threadId,
      fromTurnCount:
        typeof checkpointTurnCount === "number" ? Math.max(0, checkpointTurnCount - 1) : null,
      toTurnCount: checkpointTurnCount ?? null,
      cacheScope: `turn:${turnId}`,
      enabled: !diffUnavailable,
      retryMode: "inline",
    }),
  );
  const checkpointDiffData = checkpointDiffQuery.data as OrchestrationGetTurnDiffResult | undefined;

  const renderablePatch = useMemo(() => {
    if (!checkpointDiffData?.diff) {
      return null;
    }
    // Reuse the same parse-cache scope as DiffPanel so inline cards and the
    // side panel share the parsed representation for the same patch + theme.
    return getRenderablePatch(checkpointDiffData.diff, `diff-panel:${resolvedTheme}`);
  }, [checkpointDiffData?.diff, resolvedTheme]);

  const normalizedEntryFiles = useMemo(
    () =>
      new Set(
        filePaths
          .map((filePath) => normalizeDiffLookupPath(filePath, workspaceRoot))
          .filter((filePath): filePath is string => filePath !== null),
      ),
    [filePaths, workspaceRoot],
  );

  const turnDiffFileByPath = useMemo(() => {
    const entries = turnDiffSummary?.files ?? [];
    const next = new Map<string, (typeof entries)[number]>();
    for (const file of entries) {
      const normalizedPath = normalizeDiffLookupPath(file.path, workspaceRoot);
      if (!normalizedPath || next.has(normalizedPath)) {
        continue;
      }
      next.set(normalizedPath, file);
    }
    return next;
  }, [turnDiffSummary?.files, workspaceRoot]);

  const matchedFiles = useMemo(() => {
    if (!renderablePatch || renderablePatch.kind !== "files") {
      return [];
    }
    return renderablePatch.files
      .flatMap((fileDiff) => {
        const filePath = resolveFileDiffPath(fileDiff);
        const normalizedPath = normalizeDiffLookupPath(filePath, workspaceRoot);
        if (!normalizedPath || !normalizedEntryFiles.has(normalizedPath)) {
          return [];
        }
        return [
          {
            fileDiff,
            filePath,
            summaryFile: turnDiffFileByPath.get(normalizedPath),
          },
        ];
      })
      .toSorted((left, right) =>
        left.filePath.localeCompare(right.filePath, undefined, {
          numeric: true,
          sensitivity: "base",
        }),
      );
  }, [normalizedEntryFiles, renderablePatch, turnDiffFileByPath, workspaceRoot]);

  const openFile = useCallback(
    (filePath: string) => {
      if (handleFileNavigation(filePath, turnId)) {
        return;
      }
      const api = readNativeApi();
      if (!api) {
        toastManager.add({
          type: "error",
          title: "Editor opening is unavailable.",
        });
        return;
      }
      const targetPath = workspaceRoot ? resolvePathLinkTarget(filePath, workspaceRoot) : filePath;
      void openInPreferredEditor(api, targetPath).catch((error) => {
        toastManager.add({
          type: "error",
          title: "Unable to open file",
          description: error instanceof Error ? error.message : "An error occurred.",
        });
      });
    },
    [handleFileNavigation, turnId, workspaceRoot],
  );

  const content = (() => {
    if (diffUnavailable) {
      return <p className="px-3 py-2 text-[11px] text-muted-foreground/65">Diff unavailable</p>;
    }

    if (checkpointDiffQuery.isLoading && !checkpointDiffData?.diff) {
      return <p className="px-3 py-2 text-[11px] text-muted-foreground/65">Loading diff...</p>;
    }

    if (
      checkpointDiffQuery.error ||
      !renderablePatch ||
      renderablePatch.kind === "raw" ||
      matchedFiles.length === 0
    ) {
      return <p className="px-3 py-2 text-[11px] text-muted-foreground/65">Diff unavailable</p>;
    }

    return (
      <div className="max-h-80 space-y-2 overflow-auto px-2 pb-2">
        {matchedFiles.map(({ fileDiff, filePath, summaryFile }) => {
          const renderKey = `${buildFileDiffRenderKey(fileDiff)}:${resolvedTheme}`;
          const displayPath = relativePathForDisplay(filePath, workspaceRoot);
          const hasCounts =
            typeof summaryFile?.additions === "number" &&
            typeof summaryFile?.deletions === "number";
          return (
            <div
              key={renderKey}
              className="overflow-hidden rounded-md border border-border/60 bg-background/55"
            >
              <div className="flex items-center justify-between gap-2 border-b border-border/60 px-3 py-2">
                <button
                  type="button"
                  className="min-w-0 flex-1 text-left"
                  onClick={() => openFile(filePath)}
                  title={displayPath}
                >
                  <div className="flex items-center gap-2">
                    <span className="text-muted-foreground/55">
                      <ChevronRightIcon className="size-3" />
                    </span>
                    <span className="truncate font-mono text-[11px] text-foreground/85">
                      {displayPath}
                    </span>
                    {hasCounts ? (
                      <span className="shrink-0 text-[10px] text-muted-foreground/65">
                        +{summaryFile.additions} / -{summaryFile.deletions}
                      </span>
                    ) : null}
                  </div>
                </button>
                <Button
                  type="button"
                  size="xs"
                  variant="ghost"
                  className="shrink-0"
                  onClick={() => onOpenTurnDiff(turnId, filePath)}
                >
                  View full diff
                </Button>
              </div>
              <FileDiff
                fileDiff={fileDiff}
                options={{
                  diffStyle: "unified",
                  lineDiffType: "none",
                  theme: resolveDiffThemeName(resolvedTheme),
                  themeType: resolvedTheme,
                  disableFileHeader: true,
                  unsafeCSS: DIFF_PANEL_UNSAFE_CSS,
                }}
              />
            </div>
          );
        })}
      </div>
    );
  })();

  return (
    <div data-testid="inline-file-diff" data-work-entry-id={workEntryId}>
      {content}
    </div>
  );
});
