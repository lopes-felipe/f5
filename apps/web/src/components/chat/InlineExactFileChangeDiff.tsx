import { FileDiff } from "@pierre/diffs/react";
import { useQuery } from "@tanstack/react-query";
import type {
  OrchestrationFileChangeId,
  OrchestrationGetThreadFileChangeResult,
  ThreadId,
} from "@t3tools/contracts";
import { ChevronRightIcon } from "lucide-react";
import { memo, useCallback, useMemo, type ReactNode } from "react";

import { openInPreferredEditor } from "../../editorPreferences";
import { useFileNavigation } from "../../fileNavigationContext";
import { readNativeApi } from "../../nativeApi";
import { resolvePathLinkTarget } from "../../terminal-links";
import { relativePathForDisplay } from "~/lib/attachedFiles";
import { resolveDiffThemeName } from "~/lib/diffRendering";
import { threadFileChangeQueryOptions } from "../../lib/orchestrationReactQuery";
import {
  buildFileDiffRenderKey,
  DIFF_PANEL_UNSAFE_CSS,
  getRenderablePatch,
  resolveFileDiffPath,
} from "../DiffPanel";
import { Button } from "../ui/button";
import { toastManager } from "../ui/toast";

interface InlineExactFileChangeDiffProps {
  workEntryId: string;
  threadId: ThreadId | null;
  fileChangeId: OrchestrationFileChangeId;
  workspaceRoot: string | undefined;
  resolvedTheme: "light" | "dark";
  onOpenFileChangeDiff: (fileChangeId: OrchestrationFileChangeId, filePath?: string) => void;
  fallback?: ReactNode;
}

export const InlineExactFileChangeDiff = memo(function InlineExactFileChangeDiff(
  props: InlineExactFileChangeDiffProps,
) {
  const {
    workEntryId,
    threadId,
    fileChangeId,
    workspaceRoot,
    resolvedTheme,
    onOpenFileChangeDiff,
    fallback = null,
  } = props;
  const handleFileNavigation = useFileNavigation();
  const exactFileChangeQuery = useQuery(
    threadFileChangeQueryOptions({
      threadId,
      fileChangeId,
      enabled: true,
    }),
  );
  const exactFileChangeData = exactFileChangeQuery.data as
    | OrchestrationGetThreadFileChangeResult
    | undefined;

  const renderablePatch = useMemo(() => {
    const patch = exactFileChangeData?.fileChange?.patch;
    if (!patch) {
      return null;
    }
    return getRenderablePatch(patch, `file-change:${fileChangeId}:${resolvedTheme}`);
  }, [exactFileChangeData?.fileChange?.patch, fileChangeId, resolvedTheme]);

  const renderableFiles = useMemo(() => {
    if (!renderablePatch || renderablePatch.kind !== "files") {
      return [];
    }
    return renderablePatch.files.toSorted((left, right) =>
      resolveFileDiffPath(left).localeCompare(resolveFileDiffPath(right), undefined, {
        numeric: true,
        sensitivity: "base",
      }),
    );
  }, [renderablePatch]);

  const openFile = useCallback(
    (filePath: string) => {
      if (handleFileNavigation(filePath)) {
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
    [handleFileNavigation, workspaceRoot],
  );

  if (threadId === null) {
    return <>{fallback}</>;
  }

  if (
    exactFileChangeQuery.error ||
    ((renderablePatch === null || renderablePatch.kind === "raw" || renderableFiles.length === 0) &&
      !(exactFileChangeQuery.isLoading && !exactFileChangeData?.fileChange))
  ) {
    return <>{fallback}</>;
  }

  return (
    <div data-testid="inline-file-diff" data-work-entry-id={workEntryId}>
      {exactFileChangeQuery.isLoading && !exactFileChangeData?.fileChange ? (
        <p className="px-3 py-2 text-[11px] text-muted-foreground/65">Loading diff...</p>
      ) : (
        <div className="max-h-80 space-y-2 overflow-auto">
          {renderableFiles.map((fileDiff) => {
            const filePath = resolveFileDiffPath(fileDiff);
            const renderKey = `${buildFileDiffRenderKey(fileDiff)}:${resolvedTheme}`;
            const displayPath = relativePathForDisplay(filePath, workspaceRoot);
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
                    </div>
                  </button>
                  <Button
                    type="button"
                    size="xs"
                    variant="ghost"
                    className="shrink-0"
                    onClick={() => onOpenFileChangeDiff(fileChangeId, filePath)}
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
      )}
    </div>
  );
});
