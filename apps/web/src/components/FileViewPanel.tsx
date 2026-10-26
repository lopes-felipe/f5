import {
  editorDraftRecoveryAvailable,
  editorDrafts,
  editorBranch,
  editorFileKey,
  type EditorDraft,
} from "../editorDrafts";
import { useProfileState } from "../profileState";
import { useServerMutationsAvailable } from "../wsConnectionState";
import { FileBreadcrumbs } from "./FileBreadcrumbs";
import { WorkspaceMediaView, workspaceMediaKind } from "./WorkspaceMediaView";
import ChatMarkdown from "./ChatMarkdown";
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
import { PREFERRED_HIGHLIGHTER, resolveDiffThemeName } from "../lib/diffRendering";
import { looksLikeAbsoluteFilePath } from "../lib/normalizeFilePathForDiff";
import { fileContentQueryOptions, providerQueryKeys } from "../lib/providerReactQuery";
import { useWatchedWorkspacePaths } from "../lib/workspaceWatch";
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
import { threadWorkspaceCwd } from "@t3tools/shared/threadWorkspace";

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
  const workspaceRoot = threadWorkspaceCwd(activeThread ?? draftThread, activeProject);
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
  const [showSource, setShowSource] = useState(false);
  const mediaKind = filePath ? workspaceMediaKind(filePath) : null;
  const renderedMarkdown = Boolean(
    filePath && /\.(?:md|mdown|markdown)$/iu.test(filePath) && !showSource,
  );
  const watchedFilePath =
    canDisplayFileInPanel && (!mediaKind || showSource) ? filePath : undefined;
  const fileQuery = useQuery(
    fileContentQueryOptions({ cwd: workspaceRoot, relativePath: watchedFilePath }),
  );
  // External edits refetch the file; a dirty draft turns into a conflict below.
  useWatchedWorkspacePaths(workspaceRoot, watchedFilePath ? [watchedFilePath] : [], []);
  const [editing, setEditing] = useState(false);
  const [draftContents, setDraftContents] = useState("");
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saveConflict, setSaveConflict] = useState(false);
  const profileId = useProfileState((state) => state.active?.id ?? "default");
  const mutationsAvailable = useServerMutationsAvailable();
  const [draftRecoveryError, setDraftRecoveryError] = useState<string | null>(null);
  const [recoverableDrafts, setRecoverableDrafts] = useState<EditorDraft[]>([]);
  const [draftReady, setDraftReady] = useState(false);
  const draftRevisionRef = useRef(0);
  const durableDraftRef = useRef<EditorDraft | null>(null);
  const draftBranchRef = useRef<string | null>(null);
  const durableFileKey = editorFileKey(
    profileId,
    fileQuery.data?.workspaceIdentity ?? workspaceRoot ?? "",
    fileQuery.data?.fileIdentity ?? filePath ?? "",
  );
  const durableKeyRef = useRef(durableFileKey);
  durableKeyRef.current = durableFileKey;

  const canEditFile =
    Boolean(workspaceRoot && filePath && canDisplayFileInPanel) &&
    Boolean(fileQuery.data?.contentSha256) &&
    fileQuery.data?.truncated === false;
  const fileKey = JSON.stringify([profileId, workspaceRoot, filePath]);
  const fileScopeRef = useRef({ key: fileKey });
  if (fileScopeRef.current.key !== fileKey) fileScopeRef.current = { key: fileKey };
  const fileScope = fileScopeRef.current;
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);
  const draftBaseRef = useRef<{ key: string; contents: string; hash: string | undefined } | null>(
    null,
  );
  const dirty = Boolean(
    draftBaseRef.current?.key === fileKey && draftContents !== draftBaseRef.current.contents,
  );

  useEffect(() => {
    const previous = draftBaseRef.current;
    const sameFile = previous?.key === fileKey;
    if (sameFile && editing && draftContents !== previous.contents) {
      if (fileQuery.data && fileQuery.data.contentSha256 !== previous.hash) {
        setSaveConflict(true);
        setSaveError(
          "The file changed outside this editor. Reload it before saving; your draft has been preserved.",
        );
      }
      return;
    }
    if (!sameFile) {
      setEditing(false);
      setSaving(false);
    }
    const data = fileQuery.data;
    draftBaseRef.current = data
      ? { key: fileKey, contents: data.contents, hash: data.contentSha256 }
      : null;
    setDraftContents(data?.contents ?? "");
    // A conflict is cleared only by a successful save or explicit reload.
    if (!sameFile || !editing) {
      setSaveError(null);
      setSaveConflict(false);
    }
  }, [editing, fileKey, fileQuery.data]);

  useEffect(() => {
    if (fileQuery.data?.truncated) {
      setEditing(false);
    }
  }, [fileQuery.data?.truncated]);

  useEffect(() => {
    let disposed = false;
    durableDraftRef.current = null;
    draftBranchRef.current = null;
    setDraftReady(false);
    setRecoverableDrafts([]);
    if (!workspaceRoot || !filePath) return;
    void editorBranch(profileId)
      .then(async (branchId) => {
        const drafts = await editorDrafts.list(durableFileKey, true);
        if (disposed) return;
        draftBranchRef.current = branchId;
        if (!editorDraftRecoveryAvailable())
          setDraftRecoveryError(
            "Persistent draft recovery is unavailable. These drafts are only held in this window.",
          );
        // Every stored branch is offered explicitly. Even this window's branch
        // may be based on an older version of the file after reload.
        draftRevisionRef.current = Math.max(
          0,
          ...drafts.filter((draft) => draft.branchId === branchId).map((draft) => draft.revision),
        );
        setRecoverableDrafts(drafts.filter((draft) => draft.saveStatus !== "saved"));
        setDraftReady(true);
      })
      .catch(() => {
        if (!disposed) {
          setDraftRecoveryError(
            "Draft recovery is unavailable. Keep this window open or copy your edits before closing it.",
          );
          setDraftReady(true);
        }
      });
    return () => {
      disposed = true;
    };
  }, [durableFileKey, profileId, workspaceRoot, filePath]);

  useEffect(() => {
    const discover = (event: Event) => {
      const detail = (event as CustomEvent<{ fileKey: string; branch: string }>).detail;
      if (detail.fileKey !== durableFileKey || detail.branch === draftBranchRef.current) return;
      void editorDrafts
        .list(durableFileKey)
        .then((drafts) => {
          if (durableKeyRef.current === durableFileKey)
            setRecoverableDrafts(
              drafts.filter((draft) => draft.branchId !== draftBranchRef.current),
            );
        })
        .catch(() => setDraftRecoveryError("Concurrent draft discovery is unavailable."));
    };
    window.addEventListener("f5-editor-draft", discover);
    return () => window.removeEventListener("f5-editor-draft", discover);
  }, [durableFileKey]);

  const editDraft = (text: string) => {
    setDraftContents(text);
    const base = draftBaseRef.current;
    if (!base?.hash) return;
    const branchId = draftBranchRef.current ?? crypto.randomUUID();
    draftBranchRef.current = branchId;
    const record: EditorDraft = {
      key: JSON.stringify([durableFileKey, branchId]),
      fileKey: durableFileKey,
      branchId,
      revision: ++draftRevisionRef.current,
      text,
      baseHash: base.hash,
      baseContents: base.contents,
      saveStatus: "dirty",
      updatedAt: Date.now(),
    };
    durableDraftRef.current = record;
    void editorDrafts
      .put(record)
      .catch(() =>
        setDraftRecoveryError(
          "Draft recovery is unavailable. Your edits remain in this window; copy them before closing it.",
        ),
      );
  };

  const saveDraft = useCallback(async () => {
    if (
      !mountedRef.current ||
      fileScopeRef.current !== fileScope ||
      !workspaceRoot ||
      !filePath ||
      !fileQuery.data ||
      !fileQuery.data.contentSha256 ||
      fileQuery.data.truncated ||
      !dirty ||
      saving ||
      saveConflict ||
      !mutationsAvailable
    ) {
      return;
    }

    const api = readNativeApi();
    if (!api) {
      setSaveError("Native API not found. Unable to save file.");
      return;
    }

    const savedContents = draftContents;
    const savedDraft = durableDraftRef.current;
    const savedDraftFileKey = durableFileKey;
    const base = draftBaseRef.current;
    if (base?.key !== fileKey || !base.hash) return;
    if (base.hash !== fileQuery.data.contentSha256) {
      setSaveConflict(true);
      setSaveError(
        "The file changed outside this editor. Reload it before saving; your draft has been preserved.",
      );
      return;
    }
    const expectedContentSha256 = base.hash;
    const requestedFilePath = filePath;

    setSaving(true);
    setSaveError(null);
    try {
      const result = await api.projects.writeFile({
        cwd: workspaceRoot,
        relativePath: requestedFilePath,
        contents: savedContents,
        condition: { type: "match", contentSha256: expectedContentSha256! },
      });
      if ("conflict" in result)
        throw new Error(
          `Workspace file changed before save. Current hash: ${result.currentContentSha256 ?? "unavailable"}`,
        );
      if (savedDraft) {
        await editorDrafts.acknowledge(savedDraft, result.contentSha256).catch(() => {
          setDraftRecoveryError("The file was saved, but its recovery draft could not be cleared.");
        });
        if (durableKeyRef.current === savedDraftFileKey && durableDraftRef.current) {
          if (durableDraftRef.current.revision === savedDraft.revision)
            durableDraftRef.current = null;
          else
            durableDraftRef.current = {
              ...durableDraftRef.current,
              baseContents: savedContents,
              baseHash: result.contentSha256,
            };
        }
      }
      if (!mountedRef.current || fileScopeRef.current !== fileScope) {
        // The RPC may already have reached disk. Refresh its cache without installing
        // an obsolete response into a new visit to the same file.
        void queryClient.invalidateQueries({
          queryKey: providerQueryKeys.fileContent({
            cwd: workspaceRoot,
            relativePath: requestedFilePath,
          }),
        });
        return;
      }
      {
        draftBaseRef.current = {
          key: fileKey,
          contents: savedContents,
          hash: result.contentSha256,
        };
        setSaveConflict(false);
      }
      const savedData = {
        workspaceIdentity: fileQuery.data?.workspaceIdentity,
        fileIdentity: fileQuery.data?.fileIdentity,
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
      if (!mountedRef.current || fileScopeRef.current !== fileScope) return;
      const message = error instanceof Error ? error.message : "Failed to save file.";
      setSaveError(message);
      if (message.toLowerCase().includes("changed before save")) {
        setSaveConflict(true);
      }
    } finally {
      if (mountedRef.current && fileScopeRef.current === fileScope) setSaving(false);
    }
  }, [
    dirty,
    durableFileKey,
    draftContents,
    fileKey,
    fileScope,
    filePath,
    fileQuery.data,
    queryClient,
    saveConflict,
    mutationsAvailable,
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
      if (!filePath || !workspaceRoot || !activeThreadId || !activeProjectId) return;
      event.preventDefault();
      event.stopPropagation();
      const api = readNativeApi();
      if (!api) return;
      void showFileEntryContextMenu({
        api,
        cwd: workspaceRoot,
        projectId: activeProjectId,
        threadId: activeThreadId,
        entry: { path: filePath, kind: "file" },
        position: { x: event.clientX, y: event.clientY },
        onAddToChat: (relativePath) => insertFileMentionIntoComposer(activeThreadId, relativePath),
      });
    },
    [activeProjectId, activeThreadId, filePath, workspaceRoot],
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
            <span className="shrink-0 rounded-md border border-border/70 bg-background/70 px-1.5 py-0.5 font-mono text-2xs text-muted-foreground">
              {positionBadge}
            </span>
          ) : null}
        </div>
        {filePath ? (
          <FileBreadcrumbs
            path={filePath}
            {...(activeThreadId ? { threadId: activeThreadId } : {})}
          />
        ) : null}
      </div>
      <div className="flex shrink-0 items-center gap-1">
        {(mediaKind === "html" || /\.(?:md|mdown|markdown)$/iu.test(filePath ?? "")) && (
          <Button
            size="xs"
            variant="outline"
            onClick={() => {
              setEditing(false);
              setShowSource(!showSource);
            }}
          >
            {showSource ? "Rendered" : "Source"}
          </Button>
        )}
        {fileQuery.data?.truncated ? (
          <span className="rounded-md border border-warning/30 bg-warning/10 px-1.5 py-0.5 text-2xs font-medium text-warning-foreground">
            Read-only preview
          </span>
        ) : null}
        <Button
          size="icon-xs"
          variant={editing ? "secondary" : "outline"}
          onClick={() => setEditing((current) => !current)}
          disabled={!canEditFile || !draftReady}
          aria-label={editing ? "View rendered file" : "Edit file"}
        >
          <PencilIcon className="size-3.5" />
        </Button>
        {editing ? (
          <Button
            size="icon-xs"
            variant="outline"
            onClick={() => void saveDraft()}
            disabled={!dirty || saving || saveConflict || !mutationsAvailable}
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
        <div className="flex flex-1 items-center justify-center px-5 text-center text-xs text-muted-foreground">
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
      ) : (mediaKind ||
          (fileQuery.isError &&
            /Binary file cannot be displayed/iu.test(String(fileQuery.error)))) &&
        !showSource &&
        activeProjectId &&
        filePath ? (
        <WorkspaceMediaView
          name={filePath}
          projectId={activeProjectId}
          {...(activeThread ? { threadId: activeThread.id } : {})}
        />
      ) : renderedMarkdown && fileQuery.data && !editing ? (
        <div className="overflow-auto p-4">
          <ChatMarkdown
            text={fileQuery.data.contents}
            cwd={
              workspaceRoot && filePath?.includes("/")
                ? `${workspaceRoot}/${filePath.slice(0, filePath.lastIndexOf("/"))}`
                : workspaceRoot
            }
          />
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
            {/* A wrong link usually means a wrong path, so show which path was tried and where. */}
            {watchedFilePath ? (
              <p className="mt-2 text-xs text-muted-foreground">
                Attempted path{" "}
                <code className="break-all font-mono text-foreground select-all">
                  {watchedFilePath}
                </code>
                {workspaceRoot ? (
                  <>
                    {" "}
                    in workspace folder{" "}
                    <code className="break-all font-mono select-all">{workspaceRoot}</code>
                  </>
                ) : null}
              </p>
            ) : null}
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
        <div className="flex flex-1 items-center justify-center px-5 text-center text-xs text-muted-foreground">
          File contents are unavailable.
        </div>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col p-2">
          {fileQuery.data.truncated ? (
            <div className="mb-2 flex items-start gap-2 rounded-md border border-warning/30 bg-warning/10 p-2 text-xs text-warning-foreground">
              <AlertTriangleIcon className="mt-0.5 size-3.5 shrink-0" />
              <div className="min-w-0">
                <p className="font-medium">Large file preview</p>
                <p className="mt-0.5 text-warning-foreground/80">
                  Showing the first {fileQuery.data.contents.length.toLocaleString()} characters of{" "}
                  {fileQuery.data.byteLength.toLocaleString()} bytes. Editing is disabled.
                </p>
              </div>
            </div>
          ) : null}
          {draftRecoveryError ? (
            <p role="alert" className="mb-2 text-xs text-destructive">
              {draftRecoveryError}
            </p>
          ) : null}
          {recoverableDrafts.length > 0 ? (
            <div className="mb-2 space-y-2 rounded border border-warning/30 p-2 text-xs">
              <p>Recoverable editor drafts. Other windows may still be editing these branches.</p>
              {recoverableDrafts.map((draft) => (
                <div key={draft.key} className="flex items-center gap-2">
                  <span>
                    Revision {draft.revision} · {new Date(draft.updatedAt).toLocaleString()}
                  </span>
                  <Button
                    size="xs"
                    onClick={() => {
                      // Recover into this window's branch; preserve the source branch.
                      const branchId =
                        durableDraftRef.current && durableDraftRef.current.text !== draft.text
                          ? crypto.randomUUID()
                          : (draftBranchRef.current ?? crypto.randomUUID());
                      draftBranchRef.current = branchId;
                      const recovered = {
                        ...draft,
                        branchId,
                        key: JSON.stringify([durableFileKey, branchId]),
                        revision:
                          Math.max(
                            draftRevisionRef.current,
                            durableDraftRef.current?.revision ?? 0,
                            draft.revision,
                          ) + 1,
                      };
                      draftRevisionRef.current = recovered.revision;
                      durableDraftRef.current = recovered;
                      draftBaseRef.current = {
                        key: fileKey,
                        hash: draft.baseHash,
                        contents: draft.baseContents,
                      };
                      setDraftContents(draft.text);
                      setEditing(true);
                      const conflict = fileQuery.data?.contentSha256 !== draft.baseHash;
                      setSaveConflict(conflict);
                      setSaveError(
                        conflict
                          ? "The file changed since this draft was saved. Your base and draft are preserved."
                          : null,
                      );
                      setRecoverableDrafts([]);
                      void editorDrafts
                        .put(recovered)
                        .catch(() => setDraftRecoveryError("Draft recovery is unavailable."));
                    }}
                  >
                    Recover
                  </Button>
                  <Button
                    size="xs"
                    variant="outline"
                    onClick={() => {
                      void editorDrafts
                        .discard(draft.key, draft.revision)
                        .then(() =>
                          setRecoverableDrafts((all) =>
                            all.filter((entry) => entry.key !== draft.key),
                          ),
                        )
                        .catch(() => setDraftRecoveryError("Could not discard the draft."));
                    }}
                  >
                    Discard
                  </Button>
                </div>
              ))}
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
                onChange={(event) => editDraft(event.currentTarget.value)}
                className="min-h-0 flex-1 rounded-none border-0 bg-background/40 shadow-none [&_[data-slot=textarea]]:h-full [&_[data-slot=textarea]]:min-h-0 [&_[data-slot=textarea]]:resize-none [&_[data-slot=textarea]]:font-mono [&_[data-slot=textarea]]:text-xs [&_[data-slot=textarea]]:leading-5"
                aria-label="File source editor"
              />
            ) : (
              <div ref={viewerRef} className="min-h-0 flex-1 overflow-auto">
                <FileViewer
                  key={`${fileKey}:${fileQuery.data.contentSha256 ?? ""}`}
                  file={{ name: fileQuery.data.relativePath, contents: fileQuery.data.contents }}
                  selectedLines={selectedLines}
                  options={{
                    disableFileHeader: true,
                    overflow: wordWrap ? "wrap" : "scroll",
                    theme: resolveDiffThemeName(resolvedTheme),
                    preferredHighlighter: PREFERRED_HIGHLIGHTER,
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
