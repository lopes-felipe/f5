import { File as FileViewer } from "@pierre/diffs/react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useParams, useSearch } from "@tanstack/react-router";
import { ThreadId } from "@t3tools/contracts";
import {
  AlertTriangleIcon,
  ExternalLinkIcon,
  PencilIcon,
  RefreshCwIcon,
  SaveIcon,
  XIcon,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { MouseEvent as ReactMouseEvent } from "react";
import { openInPreferredEditor } from "../editorPreferences";
import { clearFileViewSearchParams, parseDiffRouteSearch } from "../diffRouteSearch";
import { useDiffWordWrap } from "../appSettings";
import { useTheme } from "../hooks/useTheme";
import { resolveDiffThemeName } from "../lib/diffRendering";
import { looksLikeAbsoluteFilePath } from "../lib/normalizeFilePathForDiff";
import { fileContentQueryOptions, providerQueryKeys } from "../lib/providerReactQuery";
import { useComposerDraftStore } from "../composerDraftStore";
import { readNativeApi } from "../nativeApi";
import { type RightPanelSurface, useRightPanelStore } from "../rightPanelStore";
import { useStore } from "../store";
import { resolvePathLinkTarget } from "../terminal-links";
import { DiffPanelShell, DiffPanelLoadingState, type DiffPanelMode } from "./DiffPanelShell";
import { Button } from "./ui/button";
import { Textarea } from "./ui/textarea";
import { DIFF_PANEL_UNSAFE_CSS } from "./DiffPanel";
import { insertFileMentionIntoComposer } from "./composerFileMentionInsertion";
import { showFileEntryContextMenu } from "./fileEntryActions";

interface FileViewPanelProps {
  mode: DiffPanelMode;
  surface?: Extract<RightPanelSurface, { kind: "file" }> | undefined;
  onClose?: (() => void) | undefined;
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

export function reconcileDraftContents(input: {
  currentDraft: string;
  incomingContents: string;
  editing: boolean;
}): string {
  if (input.editing && input.currentDraft !== input.incomingContents) {
    return input.currentDraft;
  }
  return input.incomingContents;
}

export default function FileViewPanel({ mode, surface, onClose }: FileViewPanelProps) {
  const wordWrap = useDiffWordWrap();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { resolvedTheme } = useTheme();
  const viewerRef = useRef<HTMLDivElement>(null);
  const autoSaveTimerRef = useRef<number | null>(null);
  const routeThreadId = useParams({
    strict: false,
    select: (params) => (params.threadId ? ThreadId.makeUnsafe(params.threadId) : null),
  });
  const fileSearch = useSearch({ strict: false, select: (search) => parseDiffRouteSearch(search) });
  const activeThreadId = routeThreadId;
  const activeThread = useStore((store) =>
    activeThreadId ? store.threads.find((thread) => thread.id === activeThreadId) : undefined,
  );
  const draftThread = useComposerDraftStore((store) =>
    activeThreadId ? (store.draftThreadsByThreadId[activeThreadId] ?? null) : null,
  );
  const activeProjectId = activeThread?.projectId ?? draftThread?.projectId ?? null;
  const activeProject = useStore((store) =>
    activeProjectId ? store.projects.find((project) => project.id === activeProjectId) : undefined,
  );
  const workspaceRoot =
    activeThread?.worktreePath ?? draftThread?.worktreePath ?? activeProject?.cwd;
  const filePath = surface?.relativePath ?? fileSearch.fileViewPath;
  const fileLine = surface?.line ?? fileSearch.fileLine;
  const fileEndLine = surface?.endLine ?? fileSearch.fileEndLine;
  const fileColumn = surface?.column ?? fileSearch.fileColumn;
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
  const [editing, setEditing] = useState(false);
  const [draftContents, setDraftContents] = useState("");
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saveConflict, setSaveConflict] = useState(false);
  const canEditFile =
    Boolean(workspaceRoot && filePath && canDisplayFileInPanel) &&
    Boolean(fileQuery.data?.contentSha256) &&
    fileQuery.data?.truncated === false;
  const dirty = Boolean(fileQuery.data && draftContents !== fileQuery.data.contents);

  useEffect(() => {
    if (!fileQuery.data) {
      setDraftContents("");
      setEditing(false);
      setSaveError(null);
      setSaveConflict(false);
      return;
    }
    const nextContents = fileQuery.data.contents;
    setDraftContents((current) => {
      return reconcileDraftContents({
        currentDraft: current,
        incomingContents: nextContents,
        editing,
      });
    });
    setSaveError(null);
    setSaveConflict(false);
  }, [editing, fileQuery.data?.contentSha256, fileQuery.data?.contents, fileQuery.data]);

  useEffect(() => {
    setEditing(false);
  }, [filePath]);

  useEffect(() => {
    if (fileQuery.data?.truncated) {
      setEditing(false);
    }
  }, [fileQuery.data?.truncated]);

  const saveDraft = useCallback(async () => {
    if (
      !workspaceRoot ||
      !filePath ||
      !fileQuery.data ||
      !fileQuery.data.contentSha256 ||
      fileQuery.data.truncated ||
      !dirty ||
      saving ||
      saveConflict
    ) {
      return;
    }

    const api = readNativeApi();
    if (!api) {
      setSaveError("Native API not found. Unable to save file.");
      return;
    }

    const savedContents = draftContents;
    const expectedContentSha256 = fileQuery.data.contentSha256;
    const requestedFilePath = filePath;

    setSaving(true);
    setSaveError(null);
    try {
      const result = await api.projects.writeFile({
        cwd: workspaceRoot,
        relativePath: requestedFilePath,
        contents: savedContents,
        expectedContentSha256,
      });
      const savedData = {
        relativePath: result.relativePath,
        contents: savedContents,
        byteLength: result.byteLength,
        truncated: false,
        contentSha256: result.contentSha256,
      };
      queryClient.setQueryData(
        providerQueryKeys.fileContent({ cwd: workspaceRoot, relativePath: result.relativePath }),
        savedData,
      );
      if (result.relativePath !== requestedFilePath) {
        queryClient.setQueryData(
          providerQueryKeys.fileContent({ cwd: workspaceRoot, relativePath: requestedFilePath }),
          savedData,
        );
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to save file.";
      setSaveError(message);
      if (message.toLowerCase().includes("changed before save")) {
        setSaveConflict(true);
      }
    } finally {
      setSaving(false);
    }
  }, [
    dirty,
    draftContents,
    filePath,
    fileQuery.data,
    queryClient,
    saveConflict,
    saving,
    workspaceRoot,
  ]);

  useEffect(() => {
    if (autoSaveTimerRef.current !== null) {
      window.clearTimeout(autoSaveTimerRef.current);
      autoSaveTimerRef.current = null;
    }
    if (!editing || !dirty || !canEditFile || saving || saveConflict) {
      return;
    }

    autoSaveTimerRef.current = window.setTimeout(() => {
      autoSaveTimerRef.current = null;
      void saveDraft();
    }, 900);

    return () => {
      if (autoSaveTimerRef.current !== null) {
        window.clearTimeout(autoSaveTimerRef.current);
        autoSaveTimerRef.current = null;
      }
    };
  }, [canEditFile, dirty, editing, saveConflict, saveDraft, saving]);

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

  const showFileContextMenu = useCallback(
    (event: ReactMouseEvent<HTMLElement>) => {
      if (!filePath || !workspaceRoot || !activeThreadId) return;
      event.preventDefault();
      event.stopPropagation();
      const api = readNativeApi();
      if (!api) return;
      void showFileEntryContextMenu({
        api,
        cwd: workspaceRoot,
        entry: { path: filePath, kind: "file" },
        position: { x: event.clientX, y: event.clientY },
        onAddToChat: (relativePath) => insertFileMentionIntoComposer(activeThreadId, relativePath),
      });
    },
    [activeThreadId, filePath, workspaceRoot],
  );

  const closeFileView = useCallback(() => {
    if (onClose) {
      onClose();
      return;
    }
    if (!routeThreadId) {
      return;
    }
    if (filePath) {
      useRightPanelStore.getState().closeSurface(routeThreadId, `file:${filePath}`);
    }
    void navigate({
      to: "/$threadId",
      params: { threadId: routeThreadId },
      search: (previous) => {
        const parsed = parseDiffRouteSearch(previous);
        return parsed.fileViewPath === filePath ? clearFileViewSearchParams(previous) : previous;
      },
    });
  }, [filePath, navigate, onClose, routeThreadId]);

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
        {fileQuery.data?.truncated ? (
          <span className="rounded-md border border-amber-500/30 bg-amber-500/10 px-1.5 py-0.5 text-[10px] font-medium text-amber-700 dark:text-amber-300">
            Read-only preview
          </span>
        ) : null}
        <Button
          size="icon-xs"
          variant={editing ? "secondary" : "outline"}
          onClick={() => setEditing((current) => !current)}
          disabled={!canEditFile}
          aria-label={editing ? "View rendered file" : "Edit file"}
        >
          <PencilIcon className="size-3.5" />
        </Button>
        {editing ? (
          <Button
            size="icon-xs"
            variant="outline"
            onClick={() => void saveDraft()}
            disabled={!dirty || saving || saveConflict}
            aria-label="Save file"
          >
            {saving ? (
              <RefreshCwIcon className="size-3.5 animate-spin" />
            ) : (
              <SaveIcon className="size-3.5" />
            )}
          </Button>
        ) : null}
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
          {fileQuery.data.truncated ? (
            <div className="mb-2 flex items-start gap-2 rounded-md border border-amber-500/30 bg-amber-500/10 p-2 text-xs text-amber-800 dark:text-amber-200">
              <AlertTriangleIcon className="mt-0.5 size-3.5 shrink-0" />
              <div className="min-w-0">
                <p className="font-medium">Large file preview</p>
                <p className="mt-0.5 text-amber-800/80 dark:text-amber-200/80">
                  Showing the first {fileQuery.data.contents.length.toLocaleString()} characters of{" "}
                  {fileQuery.data.byteLength.toLocaleString()} bytes. Editing is disabled.
                </p>
              </div>
            </div>
          ) : null}
          {saveError ? (
            <div className="mb-2 flex items-start justify-between gap-3 rounded-md border border-destructive/30 bg-destructive/10 p-2 text-xs text-destructive">
              <div className="min-w-0">
                <p className="font-medium">
                  {saveConflict ? "File changed outside this editor" : "Save failed"}
                </p>
                <p className="mt-0.5 break-words text-destructive/80">{saveError}</p>
              </div>
              {saveConflict ? (
                <Button
                  size="xs"
                  variant="outline"
                  onClick={() => {
                    setEditing(false);
                    setDraftContents("");
                    setSaveConflict(false);
                    setSaveError(null);
                    void fileQuery.refetch();
                  }}
                >
                  <RefreshCwIcon className="size-3.5" />
                  Reload
                </Button>
              ) : null}
            </div>
          ) : null}
          <div
            className="file-view-surface flex min-h-0 flex-1 flex-col overflow-hidden rounded-md border border-border/60 bg-card/25"
            onContextMenu={showFileContextMenu}
          >
            {editing && canEditFile ? (
              <Textarea
                unstyled
                spellCheck={false}
                value={draftContents}
                onChange={(event) => setDraftContents(event.currentTarget.value)}
                className="min-h-0 flex-1 rounded-none border-0 bg-background/40 shadow-none [&_[data-slot=textarea]]:h-full [&_[data-slot=textarea]]:min-h-0 [&_[data-slot=textarea]]:resize-none [&_[data-slot=textarea]]:font-mono [&_[data-slot=textarea]]:text-xs [&_[data-slot=textarea]]:leading-5"
                aria-label="File source editor"
              />
            ) : (
              <div ref={viewerRef} className="min-h-0 flex-1 overflow-auto">
                <FileViewer
                  file={{ name: fileQuery.data.relativePath, contents: fileQuery.data.contents }}
                  selectedLines={selectedLines}
                  options={{
                    disableFileHeader: true,
                    overflow: wordWrap ? "wrap" : "scroll",
                    theme: resolveDiffThemeName(resolvedTheme),
                    themeType: resolvedTheme,
                    unsafeCSS: DIFF_PANEL_UNSAFE_CSS,
                  }}
                />
              </div>
            )}
          </div>
        </div>
      )}
    </DiffPanelShell>
  );
}
