import { File as FileViewer } from "@pierre/diffs/react";
import { useQuery } from "@tanstack/react-query";
import { useNavigate, useParams, useSearch } from "@tanstack/react-router";
import { ThreadId } from "@t3tools/contracts";
import { ExternalLinkIcon, RefreshCwIcon, XIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef } from "react";
import { openInPreferredEditor } from "../editorPreferences";
import { clearFileViewSearchParams, parseDiffRouteSearch } from "../diffRouteSearch";
import { useTheme } from "../hooks/useTheme";
import { resolveDiffThemeName } from "../lib/diffRendering";
import { looksLikeAbsoluteFilePath } from "../lib/normalizeFilePathForDiff";
import { fileContentQueryOptions } from "../lib/providerReactQuery";
import { readNativeApi } from "../nativeApi";
import { useStore } from "../store";
import { resolvePathLinkTarget } from "../terminal-links";
import { DiffPanelShell, DiffPanelLoadingState, type DiffPanelMode } from "./DiffPanelShell";
import { Button } from "./ui/button";
import { DIFF_PANEL_UNSAFE_CSS } from "./DiffPanel";

interface FileViewPanelProps {
  mode: DiffPanelMode;
}

function fileNameFromPath(filePath: string): string {
  const parts = filePath.split("/");
  return parts.at(-1) ?? filePath;
}

export function formatPositionBadge(params: {
  line: number | undefined;
  endLine: number | undefined;
  column: number | undefined;
}): string | null {
  if (!params.line) {
    return null;
  }
  if (params.column) {
    return `L${params.line}:${params.column}`;
  }
  if (params.endLine && params.endLine > params.line) {
    return `L${params.line}-${params.endLine}`;
  }
  return `L${params.line}`;
}

export function resolveEditorTarget(input: {
  filePath: string;
  workspaceRoot: string | undefined;
  line: number | undefined;
  column: number | undefined;
}): string {
  const pathWithPosition = input.line
    ? `${input.filePath}:${input.line}${input.column ? `:${input.column}` : ""}`
    : input.filePath;
  return input.workspaceRoot
    ? resolvePathLinkTarget(pathWithPosition, input.workspaceRoot)
    : pathWithPosition;
}

export default function FileViewPanel({ mode }: FileViewPanelProps) {
  const navigate = useNavigate();
  const { resolvedTheme } = useTheme();
  const viewerRef = useRef<HTMLDivElement>(null);
  const routeThreadId = useParams({
    strict: false,
    select: (params) => (params.threadId ? ThreadId.makeUnsafe(params.threadId) : null),
  });
  const fileSearch = useSearch({ strict: false, select: (search) => parseDiffRouteSearch(search) });
  const activeThreadId = routeThreadId;
  const activeThread = useStore((store) =>
    activeThreadId ? store.threads.find((thread) => thread.id === activeThreadId) : undefined,
  );
  const activeProjectId = activeThread?.projectId ?? null;
  const activeProject = useStore((store) =>
    activeProjectId ? store.projects.find((project) => project.id === activeProjectId) : undefined,
  );
  const workspaceRoot = activeThread?.worktreePath ?? activeProject?.cwd;
  const filePath = fileSearch.fileViewPath;
  const fileLine = fileSearch.fileLine;
  const fileEndLine = fileSearch.fileEndLine;
  const fileColumn = fileSearch.fileColumn;
  const canDisplayFileInPanel =
    typeof filePath === "string" && !looksLikeAbsoluteFilePath(filePath);
  const positionBadge = useMemo(
    () => formatPositionBadge({ line: fileLine, endLine: fileEndLine, column: fileColumn }),
    [fileColumn, fileEndLine, fileLine],
  );
  const selectedLines = useMemo(
    () => (fileLine ? { start: fileLine, end: fileEndLine ?? fileLine } : null),
    [fileEndLine, fileLine],
  );
  const fileQuery = useQuery(
    fileContentQueryOptions({
      cwd: workspaceRoot,
      relativePath: canDisplayFileInPanel ? filePath : undefined,
    }),
  );

  useEffect(() => {
    if (!fileLine || !viewerRef.current || !fileQuery.data) {
      return;
    }

    const frameId = window.requestAnimationFrame(() => {
      const directTarget = viewerRef.current?.querySelector<HTMLElement>(
        `[data-line="${fileLine}"]`,
      );
      const host = viewerRef.current?.firstElementChild;
      const shadowTarget =
        host instanceof HTMLElement
          ? host.shadowRoot?.querySelector<HTMLElement>(`[data-line="${fileLine}"]`)
          : null;
      const target = shadowTarget ?? directTarget;
      target?.scrollIntoView({ block: "center" });
    });

    return () => {
      window.cancelAnimationFrame(frameId);
    };
  }, [fileLine, fileQuery.data]);

  const openInEditor = useCallback(() => {
    if (!filePath) {
      return;
    }
    const api = readNativeApi();
    if (!api) {
      console.warn("Native API not found. Unable to open file in editor.");
      return;
    }
    const targetPath = resolveEditorTarget({
      filePath,
      workspaceRoot,
      line: fileLine,
      column: fileColumn,
    });
    void openInPreferredEditor(api, targetPath).catch((error) => {
      console.warn("Failed to open file in editor.", error);
    });
  }, [fileColumn, fileLine, filePath, workspaceRoot]);

  const closeFileView = useCallback(() => {
    if (!routeThreadId) {
      return;
    }
    void navigate({
      to: "/$threadId",
      params: { threadId: routeThreadId },
      search: (previous) => clearFileViewSearchParams(previous),
    });
  }, [navigate, routeThreadId]);

  const header = (
    <div className="flex min-w-0 flex-1 items-center justify-between gap-2 [-webkit-app-region:no-drag]">
      <div className="min-w-0">
        <div className="flex min-w-0 items-center gap-2">
          <p className="truncate text-sm font-medium text-foreground">
            {filePath ? fileNameFromPath(filePath) : "File viewer"}
          </p>
          {positionBadge ? (
            <span className="shrink-0 rounded-md border border-border/70 bg-background/70 px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
              {positionBadge}
            </span>
          ) : null}
        </div>
        {filePath ? (
          <p className="truncate text-[11px] text-muted-foreground/70">{filePath}</p>
        ) : null}
      </div>
      <div className="flex shrink-0 items-center gap-1">
        <Button
          size="icon-xs"
          variant="outline"
          onClick={openInEditor}
          disabled={!filePath}
          aria-label="Open file in editor"
        >
          <ExternalLinkIcon className="size-3.5" />
        </Button>
        <Button size="icon-xs" variant="ghost" onClick={closeFileView} aria-label="Close file view">
          <XIcon className="size-3.5" />
        </Button>
      </div>
    </div>
  );

  return (
    <DiffPanelShell mode={mode} header={header}>
      {!filePath ? (
        <div className="flex flex-1 items-center justify-center px-5 text-center text-xs text-muted-foreground/70">
          Select a file to inspect.
        </div>
      ) : !canDisplayFileInPanel ? (
        <div className="flex min-h-0 flex-1 flex-col p-3">
          <div className="rounded-md border border-border/60 bg-card/40 p-3">
            <p className="text-sm font-medium text-foreground">Unable to display file</p>
            <p className="mt-2 text-sm text-muted-foreground">
              Files outside the current workspace can only be opened in your editor.
            </p>
            <div className="mt-4 flex items-center gap-2">
              <Button size="xs" variant="outline" onClick={openInEditor}>
                <ExternalLinkIcon className="size-3.5" />
                Open in editor
              </Button>
            </div>
          </div>
        </div>
      ) : fileQuery.isLoading ? (
        <DiffPanelLoadingState label="Loading file..." />
      ) : fileQuery.isError ? (
        <div className="flex min-h-0 flex-1 flex-col p-3">
          <div className="rounded-md border border-border/60 bg-card/40 p-3">
            <p className="text-sm font-medium text-foreground">Unable to display file</p>
            <p className="mt-2 text-sm text-muted-foreground">
              {fileQuery.error instanceof Error ? fileQuery.error.message : "Failed to load file."}
            </p>
            <div className="mt-4 flex items-center gap-2">
              <Button size="xs" variant="outline" onClick={() => void fileQuery.refetch()}>
                <RefreshCwIcon className="size-3.5" />
                Retry
              </Button>
              <Button size="xs" variant="outline" onClick={openInEditor}>
                <ExternalLinkIcon className="size-3.5" />
                Open in editor
              </Button>
            </div>
          </div>
        </div>
      ) : !fileQuery.data ? (
        <div className="flex flex-1 items-center justify-center px-5 text-center text-xs text-muted-foreground/70">
          File contents are unavailable.
        </div>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col p-2">
          <div className="file-view-surface flex min-h-0 flex-1 flex-col overflow-hidden rounded-md border border-border/60 bg-card/25">
            <div ref={viewerRef} className="min-h-0 flex-1 overflow-auto">
              <FileViewer
                file={{ name: fileQuery.data.relativePath, contents: fileQuery.data.contents }}
                selectedLines={selectedLines}
                options={{
                  disableFileHeader: true,
                  theme: resolveDiffThemeName(resolvedTheme),
                  themeType: resolvedTheme,
                  unsafeCSS: DIFF_PANEL_UNSAFE_CSS,
                }}
              />
            </div>
          </div>
        </div>
      )}
    </DiffPanelShell>
  );
}
