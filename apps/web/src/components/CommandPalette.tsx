"use client";

import {
  DEFAULT_MODEL_BY_PROVIDER,
  type FilesystemBrowseResult,
  type ProjectId,
  type ResolvedKeybindingsConfig,
} from "@t3tools/contracts";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useLocation, useNavigate } from "@tanstack/react-router";
import {
  ArrowDownIcon,
  ArrowLeftIcon,
  ArrowUpIcon,
  CornerLeftUpIcon,
  FolderIcon,
  FolderPlusIcon,
  MessageSquareIcon,
  RocketIcon,
  SettingsIcon,
  SquarePenIcon,
} from "lucide-react";
import {
  useCallback,
  useDeferredValue,
  useEffect,
  useMemo,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { useCommandPaletteStore } from "../commandPaletteStore";
import { useHandleNewThread } from "../hooks/useHandleNewThread";
import { useAppSettings } from "../appSettings";
import { ensureNativeApi, readNativeApi } from "../nativeApi";
import { serverConfigQueryOptions } from "../lib/serverReactQuery";
import { isTerminalFocused } from "../lib/terminalFocus";
import { compareThreadsByActivity, getMostRecentThreadForProject } from "../lib/threadOrdering";
import {
  appendBrowsePathSegment,
  canNavigateUp,
  ensureBrowseDirectoryPath,
  findProjectByPath,
  getBrowseDirectoryPath,
  getBrowseLeafPathSegment,
  getBrowseParentPath,
  hasTrailingPathSeparator,
  inferProjectTitleFromPath,
  isExplicitRelativeProjectPath,
  isFilesystemBrowseQuery,
  isUnsupportedWindowsProjectPath,
  resolveProjectPathForDispatch,
} from "../lib/projectPaths";
import { cn, isMacPlatform, newCommandId, newProjectId } from "../lib/utils";
import { filesystemBrowseQueryOptions } from "../lib/projectReactQuery";
import { resolveShortcutCommand } from "../keybindings";
import { useStore } from "../store";
import { selectThreadTerminalState, useTerminalStateStore } from "../terminalStateStore";
import { useWorkflowCreateDialogStore } from "../workflowCreateDialogStore";
import {
  ADDON_ICON_CLASS,
  buildBrowseGroups,
  buildProjectActionItems,
  buildRootGroups,
  buildThreadActionItems,
  type CommandPaletteActionItem,
  type CommandPaletteSubmenuItem,
  type CommandPaletteView,
  filterBrowseEntries,
  filterCommandPaletteGroups,
  getCommandPaletteInputPlaceholder,
  getCommandPaletteMode,
  ITEM_ICON_CLASS,
  RECENT_THREAD_LIMIT,
} from "./CommandPalette.logic";
import { CommandPaletteResults } from "./CommandPaletteResults";
import { resolveSettingsNavigationSearch } from "./settings/settingsCategories";
import {
  Command,
  CommandDialog,
  CommandDialogPopup,
  CommandFooter,
  CommandInput,
  CommandPanel,
} from "./ui/command";
import { Button } from "./ui/button";
import { Kbd, KbdGroup } from "./ui/kbd";
import { toastManager } from "./ui/toast";
/**
 * Derives the server's HTTP origin (scheme + host + port) from the same
 * sources WsTransport uses, converting ws(s) to http(s).
 */
function getServerHttpOrigin(): string {
  const bridgeUrl = window.desktopBridge?.getWsUrl();
  const envUrl = import.meta.env.VITE_WS_URL as string | undefined;
  const wsUrl =
    bridgeUrl && bridgeUrl.length > 0
      ? bridgeUrl
      : envUrl && envUrl.length > 0
        ? envUrl
        : `${window.location.protocol === "https:" ? "wss" : "ws"}://${window.location.hostname}:${window.location.port}`;
  const httpUrl = wsUrl.replace(/^wss:/, "https:").replace(/^ws:/, "http:");
  try {
    return new URL(httpUrl).origin;
  } catch {
    return httpUrl;
  }
}

const EMPTY_KEYBINDINGS: ResolvedKeybindingsConfig = [];
const EMPTY_BROWSE_ENTRIES: FilesystemBrowseResult["entries"] = [];
const BROWSE_STALE_TIME_MS = 30_000;

function getLocalFileManagerName(platform: string): string {
  if (isMacPlatform(platform)) {
    return "Finder";
  }
  if (platform.startsWith("Win")) {
    return "Explorer";
  }
  return "Files";
}

function useServerKeybindings(): ResolvedKeybindingsConfig {
  const serverConfigQuery = useQuery(serverConfigQueryOptions());
  return serverConfigQuery.data?.keybindings ?? EMPTY_KEYBINDINGS;
}

function ProjectFaviconIcon({ cwd, className }: { cwd: string; className: string }) {
  const [status, setStatus] = useState<"loading" | "loaded" | "error">("loading");
  const origin = useMemo(() => getServerHttpOrigin(), []);
  const src = `${origin}/api/project-favicon?cwd=${encodeURIComponent(cwd)}`;

  if (status === "error") {
    return <FolderIcon className={className} />;
  }

  return (
    <img
      src={src}
      alt=""
      className={cn(
        "size-4 shrink-0 rounded-sm object-contain",
        status === "loading" ? "hidden" : "",
      )}
      onLoad={() => setStatus("loaded")}
      onError={() => setStatus("error")}
    />
  );
}

export function CommandPalette({ children }: { children: ReactNode }) {
  const open = useCommandPaletteStore((store) => store.open);
  const setOpen = useCommandPaletteStore((store) => store.setOpen);
  const toggleOpen = useCommandPaletteStore((store) => store.toggleOpen);
  const keybindings = useServerKeybindings();
  const routeThreadId = useHandleNewThread().routeThreadId;
  const terminalOpen = useTerminalStateStore((state) =>
    routeThreadId
      ? selectThreadTerminalState(state.terminalStateByThreadId, routeThreadId).terminalOpen
      : false,
  );

  useEffect(() => {
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.defaultPrevented) return;
      const command = resolveShortcutCommand(event, keybindings, {
        context: {
          terminalFocus: isTerminalFocused(),
          terminalOpen,
        },
      });
      if (command !== "commandPalette.toggle") {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      toggleOpen();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [keybindings, terminalOpen, toggleOpen]);

  // Close the palette when this container unmounts (e.g. on route change).
  // Hoisted here so the cleanup fires once at unmount rather than every time
  // the conditionally-rendered dialog opens and closes.
  useEffect(() => {
    return () => {
      setOpen(false);
    };
  }, [setOpen]);

  // The palette's Dialog.Root is kept as a sibling of `children` rather than
  // wrapping them. Base UI treats any Dialog mounted inside another Dialog's
  // Root as a nested dialog, and `DialogBackdrop` suppresses its own backdrop
  // when `nested` is true (unless `forceRender` is passed). Wrapping the app
  // here therefore silently disabled the dim + backdrop-blur on every other
  // dialog in the app (e.g. the New Workflow modal). Keeping the palette root
  // as a sibling preserves the palette's open/close semantics while leaving
  // other dialogs as non-nested, so their backdrops render normally.
  return (
    <>
      {children}
      <CommandDialog open={open} onOpenChange={setOpen}>
        <CommandPaletteDialog />
      </CommandDialog>
    </>
  );
}

function CommandPaletteDialog() {
  const open = useCommandPaletteStore((store) => store.open);

  if (!open) {
    return null;
  }

  return <OpenCommandPaletteDialog />;
}

function OpenCommandPaletteDialog() {
  const location = useLocation();
  const navigate = useNavigate();
  const setOpen = useCommandPaletteStore((store) => store.setOpen);
  const openIntent = useCommandPaletteStore((store) => store.openIntent);
  const clearOpenIntent = useCommandPaletteStore((store) => store.clearOpenIntent);
  const openWorkflowCreateDialog = useWorkflowCreateDialogStore((store) => store.open);
  const [query, setQuery] = useState("");
  const deferredQuery = useDeferredValue(query);
  const isActionsOnly = deferredQuery.startsWith(">");
  const queryClient = useQueryClient();
  const [highlightedItemValue, setHighlightedItemValue] = useState<string | null>(null);
  const { settings } = useAppSettings();
  const { activeDraftThread, activeThread, handleNewThread } = useHandleNewThread();
  const projects = useStore((store) => store.projects);
  const threads = useStore((store) => store.threads);
  const planningWorkflows = useStore((store) => store.planningWorkflows);
  const codeReviewWorkflows = useStore((store) => store.codeReviewWorkflows);
  const keybindings = useServerKeybindings();
  const [viewStack, setViewStack] = useState<CommandPaletteView[]>([]);
  const currentView = viewStack.at(-1) ?? null;
  const [browseGeneration, setBrowseGeneration] = useState(0);
  const [isPickingProjectFolder, setIsPickingProjectFolder] = useState(false);

  const browsePlatform = typeof navigator === "undefined" ? "" : navigator.platform;
  const isBrowsing = isFilesystemBrowseQuery(query, browsePlatform);
  const paletteMode = getCommandPaletteMode({ currentView, isBrowsing });
  const getAddProjectInitialQuery = useCallback((): string => {
    const baseDirectory = settings.addProjectBaseDirectory?.trim() ?? "";
    if (baseDirectory.length === 0) {
      return "~/";
    }
    // Guard against a configured base directory that isn't a valid filesystem
    // browse query on this platform (e.g. a Windows path saved while running
    // on macOS). Without this fallback the palette would open in a non-
    // browsing state with a Windows-looking query and no entries, which is
    // confusing; revert to the home directory instead.
    const normalized = ensureBrowseDirectoryPath(baseDirectory);
    if (!isFilesystemBrowseQuery(normalized, browsePlatform)) {
      return "~/";
    }
    return normalized;
  }, [browsePlatform, settings.addProjectBaseDirectory]);

  const projectCwdById = useMemo(
    () => new Map<ProjectId, string>(projects.map((project) => [project.id, project.cwd])),
    [projects],
  );
  const projectTitleById = useMemo(
    () => new Map<ProjectId, string>(projects.map((project) => [project.id, project.name])),
    [projects],
  );

  const activeThreadId = activeThread?.id;
  const currentProjectId = activeThread?.projectId ?? activeDraftThread?.projectId ?? null;
  const workflowProjectId = currentProjectId ?? projects[0]?.id ?? null;
  const currentProjectCwd = currentProjectId
    ? (projectCwdById.get(currentProjectId) ?? null)
    : null;
  const relativePathNeedsActiveProject =
    isExplicitRelativeProjectPath(query.trim()) && currentProjectCwd === null;
  // Normally we strip the leaf segment from the query before hitting the server
  // so that many keystrokes in the same directory share a cache entry and the
  // client does the incremental filtering. But the server only returns
  // dot-directories when the submitted prefix itself starts with ".", so when
  // the leaf is a hidden-directory prefix we have to send the full query
  // (including the leaf) to the server — otherwise hidden directories are
  // silently filtered out of the browse results.
  const browseLeaf =
    isBrowsing && !hasTrailingPathSeparator(query) ? getBrowseLeafPathSegment(query) : "";
  const browseLeafIsHidden = browseLeaf.startsWith(".");
  const browseDirectoryPath = isBrowsing
    ? browseLeafIsHidden
      ? query
      : getBrowseDirectoryPath(query)
    : "";
  const browseFilterQuery = browseLeafIsHidden ? "" : browseLeaf;

  const { data: browseResult, isPending: isBrowsePending } = useQuery({
    ...filesystemBrowseQueryOptions({
      partialPath: browseDirectoryPath,
      cwd: currentProjectCwd,
      enabled: isBrowsing && browseDirectoryPath.length > 0 && !relativePathNeedsActiveProject,
      staleTime: BROWSE_STALE_TIME_MS,
    }),
  });
  const browseEntries = browseResult?.entries ?? EMPTY_BROWSE_ENTRIES;
  const {
    filteredEntries: filteredBrowseEntries,
    highlightedEntry: highlightedBrowseEntry,
    exactEntry: exactBrowseEntry,
  } = useMemo(
    () => filterBrowseEntries({ browseEntries, browseFilterQuery, highlightedItemValue }),
    [browseEntries, browseFilterQuery, highlightedItemValue],
  );

  const prefetchBrowsePath = useCallback(
    (partialPath: string) => {
      void queryClient.prefetchQuery(
        filesystemBrowseQueryOptions({
          partialPath,
          cwd: currentProjectCwd,
          staleTime: BROWSE_STALE_TIME_MS,
        }),
      );
    },
    [currentProjectCwd, queryClient],
  );

  // Prefetch the parent and the most likely next child so browse navigation
  // stays warm without scanning every child directory in large trees.
  useEffect(() => {
    if (!isBrowsing || filteredBrowseEntries.length === 0) return;

    if (canNavigateUp(query)) {
      prefetchBrowsePath(getBrowseParentPath(query)!);
    }

    const nextChild = highlightedBrowseEntry ?? exactBrowseEntry;
    if (nextChild) {
      prefetchBrowsePath(appendBrowsePathSegment(query, nextChild.name));
    }
  }, [
    exactBrowseEntry,
    filteredBrowseEntries.length,
    highlightedBrowseEntry,
    isBrowsing,
    prefetchBrowsePath,
    query,
  ]);

  const openProjectFromSearch = useMemo(
    () => async (project: (typeof projects)[number]) => {
      const latestThread = getMostRecentThreadForProject(
        project.id,
        threads,
        planningWorkflows,
        codeReviewWorkflows,
      );
      if (latestThread) {
        await navigate({
          to: "/$threadId",
          params: { threadId: latestThread.id },
        });
        return;
      }

      await handleNewThread(project.id, {
        envMode: settings.defaultThreadEnvMode,
      });
    },
    [
      codeReviewWorkflows,
      handleNewThread,
      navigate,
      planningWorkflows,
      settings.defaultThreadEnvMode,
      threads,
    ],
  );

  const projectIcon = useCallback(
    (project: (typeof projects)[number]) => (
      <ProjectFaviconIcon cwd={project.cwd} className={ITEM_ICON_CLASS} />
    ),
    [],
  );

  const projectSearchItems = useMemo(
    () =>
      buildProjectActionItems({
        projects,
        valuePrefix: "project",
        icon: projectIcon,
        runProject: openProjectFromSearch,
      }),
    [openProjectFromSearch, projectIcon, projects],
  );

  const projectThreadItems = useMemo(
    () =>
      buildProjectActionItems({
        projects,
        valuePrefix: "new-thread-in",
        icon: projectIcon,
        runProject: async (project) => {
          await handleNewThread(project.id, {
            envMode: settings.defaultThreadEnvMode,
          });
        },
      }),
    [handleNewThread, projectIcon, projects, settings.defaultThreadEnvMode],
  );

  const sortedActiveThreads = useMemo(
    () => threads.filter((thread) => thread.archivedAt === null).toSorted(compareThreadsByActivity),
    [threads],
  );

  const allThreadItems = useMemo(
    () =>
      buildThreadActionItems({
        threads: sortedActiveThreads,
        ...(activeThreadId ? { activeThreadId } : {}),
        projectTitleById,
        icon: <MessageSquareIcon className={ITEM_ICON_CLASS} />,
        runThread: async (thread) => {
          await navigate({
            to: "/$threadId",
            params: { threadId: thread.id },
          });
        },
      }),
    [activeThreadId, navigate, projectTitleById, sortedActiveThreads],
  );
  const recentThreadItems = allThreadItems.slice(0, RECENT_THREAD_LIMIT);

  function pushPaletteView(view: CommandPaletteView): void {
    setViewStack((previousViews) => [
      ...previousViews,
      {
        addonIcon: view.addonIcon,
        groups: view.groups,
        ...(view.initialQuery ? { initialQuery: view.initialQuery } : {}),
      },
    ]);
    setHighlightedItemValue(null);
    setQuery(view.initialQuery ?? "");
  }

  function pushView(item: CommandPaletteSubmenuItem): void {
    pushPaletteView({
      addonIcon: item.addonIcon,
      groups: item.groups,
      ...(item.initialQuery ? { initialQuery: item.initialQuery } : {}),
    });
  }

  function popView(): void {
    setViewStack((previousViews) => previousViews.slice(0, -1));
    setHighlightedItemValue(null);
    setQuery("");
  }

  function handleQueryChange(nextQuery: string): void {
    setHighlightedItemValue(null);
    setQuery(nextQuery);
    if (nextQuery === "" && currentView?.initialQuery) {
      popView();
    }
  }

  const openAddProjectFlow = useCallback(() => {
    pushPaletteView({
      addonIcon: <FolderPlusIcon className={ADDON_ICON_CLASS} />,
      groups: [],
      initialQuery: getAddProjectInitialQuery(),
    });
  }, [getAddProjectInitialQuery]);

  useEffect(() => {
    if (openIntent?.kind !== "add-project") {
      return;
    }
    clearOpenIntent();
    openAddProjectFlow();
  }, [clearOpenIntent, openAddProjectFlow, openIntent]);

  const actionItems: Array<CommandPaletteActionItem | CommandPaletteSubmenuItem> = [];

  if (projects.length > 0) {
    const activeProjectTitle = currentProjectId
      ? (projectTitleById.get(currentProjectId) ?? null)
      : null;
    const workflowProjectTitle = workflowProjectId
      ? (projectTitleById.get(workflowProjectId) ?? null)
      : null;

    if (activeProjectTitle) {
      actionItems.push({
        kind: "action",
        value: "action:new-thread",
        searchTerms: ["new thread", "chat", "create", "draft"],
        title: (
          <>
            New thread in <span className="font-semibold">{activeProjectTitle}</span>
          </>
        ),
        icon: <SquarePenIcon className={ITEM_ICON_CLASS} />,
        shortcutCommand: "chat.new",
        run: async () => {
          if (!currentProjectId) return;
          if (settings.defaultThreadEnvMode === "worktree") {
            await handleNewThread(currentProjectId, { envMode: "worktree" });
            return;
          }
          await handleNewThread(currentProjectId, {
            branch: activeThread?.branch ?? activeDraftThread?.branch ?? null,
            worktreePath: activeThread?.worktreePath ?? activeDraftThread?.worktreePath ?? null,
            envMode:
              activeDraftThread?.envMode ?? (activeThread?.worktreePath ? "worktree" : "local"),
          });
        },
      });
    }

    if (workflowProjectId && workflowProjectTitle) {
      actionItems.push({
        kind: "action",
        value: "action:new-workflow",
        searchTerms: ["new workflow", "workflow", "planning", "code review", "feature"],
        title: (
          <>
            New workflow in <span className="font-semibold">{workflowProjectTitle}</span>
          </>
        ),
        icon: <RocketIcon className={ITEM_ICON_CLASS} />,
        shortcutCommand: "workflow.new",
        run: async () => {
          openWorkflowCreateDialog(workflowProjectId);
        },
      });
    }

    actionItems.push({
      kind: "submenu",
      value: "action:new-thread-in",
      searchTerms: ["new thread", "project", "pick", "choose", "select"],
      title: "New thread in...",
      icon: <SquarePenIcon className={ITEM_ICON_CLASS} />,
      addonIcon: <SquarePenIcon className={ADDON_ICON_CLASS} />,
      groups: [{ value: "projects", label: "Projects", items: projectThreadItems }],
    });
  }

  actionItems.push({
    kind: "action",
    value: "action:add-project",
    searchTerms: ["add project", "folder", "directory", "browse"],
    title: "Add project",
    icon: <FolderPlusIcon className={ITEM_ICON_CLASS} />,
    keepOpen: true,
    run: async () => {
      openAddProjectFlow();
    },
  });

  actionItems.push({
    kind: "action",
    value: "action:settings",
    searchTerms: ["settings", "preferences", "configuration", "keybindings"],
    title: "Open settings",
    icon: <SettingsIcon className={ITEM_ICON_CLASS} />,
    run: async () => {
      await navigate({
        to: "/settings",
        search: resolveSettingsNavigationSearch(location),
      });
    },
  });

  const rootGroups = buildRootGroups({ actionItems, recentThreadItems });
  const activeGroups = currentView ? currentView.groups : rootGroups;

  const filteredGroups = filterCommandPaletteGroups({
    activeGroups,
    query: deferredQuery,
    isInSubmenu: currentView !== null,
    projectSearchItems: projectSearchItems,
    threadSearchItems: allThreadItems,
  });

  const handleAddProject = useCallback(
    async (rawCwd: string) => {
      const api = readNativeApi();
      if (!api) return;

      if (isUnsupportedWindowsProjectPath(rawCwd.trim(), browsePlatform)) {
        toastManager.add({
          type: "error",
          title: "Failed to add project",
          description: "Windows-style paths are only supported on Windows.",
        });
        return;
      }

      if (isExplicitRelativeProjectPath(rawCwd.trim()) && !currentProjectCwd) {
        toastManager.add({
          type: "error",
          title: "Failed to add project",
          description: "Relative paths require an active project.",
        });
        return;
      }

      const cwd = resolveProjectPathForDispatch(rawCwd, currentProjectCwd);
      if (cwd.length === 0) return;

      const existing = findProjectByPath(projects, cwd);
      if (existing) {
        const latestThread = getMostRecentThreadForProject(
          existing.id,
          threads,
          planningWorkflows,
          codeReviewWorkflows,
        );
        if (latestThread) {
          await navigate({
            to: "/$threadId",
            params: { threadId: latestThread.id },
          });
        } else {
          await handleNewThread(existing.id, {
            envMode: settings.defaultThreadEnvMode,
          }).catch(() => undefined);
        }
        setOpen(false);
        return;
      }

      try {
        const projectId = newProjectId();
        await api.orchestration.dispatchCommand({
          type: "project.create",
          commandId: newCommandId(),
          projectId,
          title: inferProjectTitleFromPath(cwd),
          workspaceRoot: cwd,
          defaultModel: DEFAULT_MODEL_BY_PROVIDER.codex,
          createdAt: new Date().toISOString(),
        });
        await handleNewThread(projectId, {
          envMode: settings.defaultThreadEnvMode,
        }).catch(() => undefined);
        setOpen(false);
      } catch (error) {
        toastManager.add({
          type: "error",
          title: "Failed to add project",
          description: error instanceof Error ? error.message : "An error occurred.",
        });
      }
    },
    [
      browsePlatform,
      codeReviewWorkflows,
      currentProjectCwd,
      handleNewThread,
      navigate,
      planningWorkflows,
      projects,
      setOpen,
      settings.defaultThreadEnvMode,
      threads,
    ],
  );

  function browseTo(name: string): void {
    const nextQuery = appendBrowsePathSegment(query, name);
    setHighlightedItemValue(null);
    setQuery(nextQuery);
    setBrowseGeneration((generation) => generation + 1);
  }

  function browseUp(): void {
    const parentPath = getBrowseParentPath(query);
    if (parentPath === null) {
      return;
    }

    setHighlightedItemValue(null);
    setQuery(parentPath);
    setBrowseGeneration((generation) => generation + 1);
  }

  // Resolve the add-project path from browse data when available. When the
  // query has a trailing separator (e.g. "~/projects/foo/"), parentPath is the
  // directory itself. Otherwise the user typed a partial leaf name, so we need
  // the exact browse entry's fullPath. As a fallback we combine the server's
  // resolved parentPath (absolute, `~` already expanded) with the typed leaf —
  // this keeps project dedupe correct for paths like `~/repo` that don't match
  // any existing browse entry: without this, dedupe compares the unexpanded
  // `~/repo` against stored absolute cwd values, misses, and the server then
  // creates a duplicate project at the same canonical location.
  const canonicalPendingLeafPath =
    !hasTrailingPathSeparator(query) && browseResult && browseLeaf.length > 0
      ? appendBrowsePathSegment(browseResult.parentPath, browseLeaf)
      : null;
  const resolvedAddProjectPath = hasTrailingPathSeparator(query)
    ? (browseResult?.parentPath ?? query.trim())
    : (exactBrowseEntry?.fullPath ?? canonicalPendingLeafPath ?? query.trim());

  const canBrowseUp =
    isBrowsing && !relativePathNeedsActiveProject && canNavigateUp(browseDirectoryPath);

  const browseGroups = buildBrowseGroups({
    browseEntries: filteredBrowseEntries,
    browseQuery: query,
    canBrowseUp,
    upIcon: <CornerLeftUpIcon className={ITEM_ICON_CLASS} />,
    directoryIcon: <FolderIcon className={ITEM_ICON_CLASS} />,
    browseUp,
    browseTo,
  });

  let displayedGroups = filteredGroups;
  if (isBrowsing) {
    displayedGroups = relativePathNeedsActiveProject ? [] : browseGroups;
  }

  const inputPlaceholder = getCommandPaletteInputPlaceholder(paletteMode);
  const isSubmenu = paletteMode === "submenu" || paletteMode === "submenu-browse";
  const hasHighlightedBrowseItem = highlightedItemValue?.startsWith("browse:") ?? false;
  const canSubmitBrowsePath = isBrowsing && !relativePathNeedsActiveProject;
  const willCreateProjectPath =
    canSubmitBrowsePath &&
    !isBrowsePending &&
    query.trim().length > 0 &&
    !hasHighlightedBrowseItem &&
    (hasTrailingPathSeparator(query) ? !browseResult : exactBrowseEntry === null);
  const useMetaForMod = isMacPlatform(browsePlatform);
  const submitModifierLabel = useMetaForMod ? "\u2318" : "Ctrl";
  const submitActionLabel = willCreateProjectPath ? "Create & Add" : "Add";
  const addShortcutLabel = hasHighlightedBrowseItem ? `${submitModifierLabel} Enter` : "Enter";
  const fileManagerName = getLocalFileManagerName(browsePlatform);
  const canOpenProjectFromFileManager =
    isBrowsing && typeof window !== "undefined" && window.desktopBridge !== undefined;

  function isPrimaryModifierPressed(event: KeyboardEvent<HTMLInputElement>): boolean {
    return useMetaForMod ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
  }

  function handleKeyDown(event: KeyboardEvent<HTMLInputElement>): void {
    const shouldSubmitBrowsePath =
      canSubmitBrowsePath &&
      event.key === "Enter" &&
      // Match the rendered button gating: don't dispatch project.create with a
      // stale or unresolved path while the browse fetch is still in flight.
      !isBrowsePending &&
      (!hasHighlightedBrowseItem || isPrimaryModifierPressed(event));

    if (shouldSubmitBrowsePath) {
      event.preventDefault();
      void handleAddProject(resolvedAddProjectPath);
      return;
    }

    if (event.key === "Backspace" && query === "" && isSubmenu) {
      event.preventDefault();
      popView();
    }
  }

  function executeItem(item: CommandPaletteActionItem | CommandPaletteSubmenuItem): void {
    if (item.kind === "submenu") {
      pushView(item);
      return;
    }

    if (!item.keepOpen) {
      setOpen(false);
    }

    void item.run().catch((error: unknown) => {
      toastManager.add({
        type: "error",
        title: "Unable to run command",
        description: error instanceof Error ? error.message : "An unexpected error occurred.",
      });
    });
  }

  const handleOpenProjectFromFileManager = useCallback(async () => {
    if (!canOpenProjectFromFileManager || isPickingProjectFolder) {
      return;
    }
    const api = ensureNativeApi();

    setIsPickingProjectFolder(true);
    let pickedPath: string | null = null;
    try {
      pickedPath = await api.dialogs.pickFolder();
    } catch {
      // Ignore picker failures and leave the palette open.
      setIsPickingProjectFolder(false);
      return;
    }
    setIsPickingProjectFolder(false);
    if (!pickedPath) {
      return;
    }
    await handleAddProject(pickedPath);
  }, [canOpenProjectFromFileManager, handleAddProject, isPickingProjectFolder]);

  return (
    <CommandDialogPopup
      aria-label="Command palette"
      className="overflow-hidden p-0"
      data-testid="command-palette"
    >
      <Command
        key={`${viewStack.length}-${browseGeneration}-${isBrowsing}`}
        aria-label="Command palette"
        autoHighlight={isBrowsing ? false : "always"}
        mode="none"
        onItemHighlighted={(value) => {
          setHighlightedItemValue(typeof value === "string" ? value : null);
        }}
        onValueChange={handleQueryChange}
        value={query}
      >
        <div className="relative">
          <CommandInput
            className={isBrowsing ? (willCreateProjectPath ? "pe-36" : "pe-16") : undefined}
            placeholder={inputPlaceholder}
            wrapperClassName={
              isSubmenu ? "[&_[data-slot=autocomplete-start-addon]]:pointer-events-auto" : undefined
            }
            {...(isSubmenu
              ? {
                  startAddon: (
                    <button
                      type="button"
                      className="flex cursor-pointer items-center"
                      aria-label="Back"
                      onClick={popView}
                    >
                      <ArrowLeftIcon />
                    </button>
                  ),
                }
              : isBrowsing && !isSubmenu
                ? {
                    startAddon: <FolderPlusIcon />,
                  }
                : {})}
            onKeyDown={handleKeyDown}
          />
          {isBrowsing ? (
            <Button
              variant="outline"
              size="xs"
              tabIndex={-1}
              className={cn(
                "absolute end-2.5 top-1/2 pe-1 ps-2 -translate-y-1/2",
                hasHighlightedBrowseItem ? "gap-1" : "gap-1.5",
              )}
              aria-label={`${submitActionLabel} (${addShortcutLabel})`}
              disabled={relativePathNeedsActiveProject}
              onMouseDown={(event) => {
                event.preventDefault();
              }}
              onClick={() => {
                if (relativePathNeedsActiveProject) {
                  return;
                }
                void handleAddProject(resolvedAddProjectPath);
              }}
              title={`${submitActionLabel} (${addShortcutLabel})`}
            >
              <span>{submitActionLabel}</span>
              <KbdGroup className="pointer-events-none -me-0.5 items-center gap-1">
                <Kbd>{hasHighlightedBrowseItem ? `${submitModifierLabel} Enter` : "Enter"}</Kbd>
              </KbdGroup>
            </Button>
          ) : null}
        </div>
        <CommandPanel className="max-h-[min(28rem,70vh)]">
          <CommandPaletteResults
            groups={displayedGroups}
            highlightedItemValue={highlightedItemValue}
            isActionsOnly={isActionsOnly}
            keybindings={keybindings}
            onExecuteItem={executeItem}
            {...(relativePathNeedsActiveProject
              ? { emptyStateMessage: "Relative paths require an active project." }
              : willCreateProjectPath
                ? {
                    emptyStateMessage: "Press Enter to create this folder and add it as a project.",
                  }
                : {})}
          />
        </CommandPanel>
        <CommandFooter className="gap-3 max-sm:flex-col max-sm:items-start">
          <div className="flex items-center gap-3">
            <KbdGroup className="items-center gap-1.5">
              <Kbd>
                <ArrowUpIcon />
              </Kbd>
              <Kbd>
                <ArrowDownIcon />
              </Kbd>
              <span className={cn("text-muted-foreground/80")}>Navigate</span>
            </KbdGroup>
            {!canSubmitBrowsePath || hasHighlightedBrowseItem ? (
              <KbdGroup className="items-center gap-1.5">
                <Kbd>Enter</Kbd>
                <span className={cn("text-muted-foreground/80")}>Select</span>
              </KbdGroup>
            ) : null}
            {isSubmenu ? (
              <KbdGroup className="items-center gap-1.5">
                <Kbd>Backspace</Kbd>
                <span className={cn("text-muted-foreground/80")}>Back</span>
              </KbdGroup>
            ) : null}
            <KbdGroup className="items-center gap-1.5">
              <Kbd>Esc</Kbd>
              <span className={cn("text-muted-foreground/80")}>Close</span>
            </KbdGroup>
          </div>
          {canOpenProjectFromFileManager ? (
            <Button
              variant="ghost"
              size="xs"
              className="h-auto px-2 text-xs text-muted-foreground/80 hover:bg-transparent hover:text-foreground"
              disabled={isPickingProjectFolder}
              onClick={() => {
                void handleOpenProjectFromFileManager();
              }}
            >
              {`Open in ${fileManagerName}`}
            </Button>
          ) : null}
        </CommandFooter>
      </Command>
    </CommandDialogPopup>
  );
}
