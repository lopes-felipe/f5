import type { ContextMenuItem } from "@t3tools/contracts";
import {
  BotIcon,
  ClipboardListIcon,
  FileDiffIcon,
  FilesIcon,
  Globe2Icon,
  PlusIcon,
  XIcon,
} from "lucide-react";
import {
  type MouseEvent as ReactMouseEvent,
  type ReactElement,
  type ReactNode,
  useCallback,
  useEffect,
  useRef,
} from "react";

import { shortcutLabelForCommand, useServerKeybindings } from "../keybindings";
import { isElectron } from "../env";
import { cn } from "../lib/utils";
import { readNativeApi } from "../nativeApi";
import type { PreviewPresentation } from "../previewPresentationStore";
import type { RightPanelSurface } from "../rightPanelStore";
import { Kbd } from "./ui/kbd";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "./ui/menu";
import { ScrollArea } from "./ui/scroll-area";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";

type AddableSurface = "preview" | "files" | "diff" | "plan" | "agents";
type TabContextMenuAction = "copy-path" | "close" | "close-others" | "close-to-right" | "close-all";

const SURFACE_DISABLED_REASONS = {
  preview: "Preview is not available in this build.",
  files: "Workspace files are available after opening a project thread.",
  diff: "Diff is available after opening a thread.",
  plan: "Plan is available after opening a thread.",
  agents: "Agent activity is unavailable until the server connection is ready.",
} as const satisfies Record<AddableSurface, string>;

function DisabledReasonTooltip(props: { reason: string; trigger: ReactElement }) {
  return (
    <Tooltip>
      <TooltipTrigger render={props.trigger} />
      <TooltipPopup side="top">{props.reason}</TooltipPopup>
    </Tooltip>
  );
}

function SurfaceMenuItem(props: {
  available: boolean;
  disabledReason: string;
  onClick: () => void;
  children: ReactNode;
  shortcut?: string | null;
}) {
  const item = (
    <MenuItem
      className={!props.available ? "data-disabled:pointer-events-auto" : undefined}
      disabled={!props.available}
      onClick={props.available ? props.onClick : undefined}
    >
      {props.children}
      {props.shortcut ? (
        <span className="ml-auto pl-3 text-xs text-muted-foreground">{props.shortcut}</span>
      ) : null}
    </MenuItem>
  );

  if (props.available) {
    return item;
  }
  return <DisabledReasonTooltip reason={props.disabledReason} trigger={item} />;
}

function surfaceTitle(
  surface: RightPanelSurface,
  previewPresentation?: PreviewPresentation,
): string {
  switch (surface.kind) {
    case "diff":
      return "Diff";
    case "files":
      return "Files";
    case "file":
      return surface.relativePath.slice(surface.relativePath.lastIndexOf("/") + 1) || "File";
    case "plan":
      return "Plan";
    case "preview":
      return previewPresentation?.title || "Preview";
    case "agents":
      return "Agents";
  }
}

function SurfaceIcon({
  surface,
  previewPresentation,
}: {
  surface: RightPanelSurface;
  previewPresentation: PreviewPresentation | undefined;
}) {
  switch (surface.kind) {
    case "diff":
      return <FileDiffIcon className="size-3.5 shrink-0" />;
    case "files":
      return <FilesIcon className="size-3.5 shrink-0" />;
    case "file":
      return <FilesIcon className="size-3.5 shrink-0" />;
    case "plan":
      return <ClipboardListIcon className="size-3.5 shrink-0" />;
    case "preview":
      return previewPresentation?.faviconDataUrl ? (
        <img
          src={previewPresentation.faviconDataUrl}
          alt=""
          className="size-3.5 shrink-0 rounded-sm object-contain"
        />
      ) : (
        <Globe2Icon className="size-3.5 shrink-0" />
      );
    case "agents":
      return <BotIcon className="size-3.5 shrink-0" />;
  }
}

function RightPanelEmptyState(props: {
  onAddPreview: () => void;
  onAddFiles: () => void;
  onAddDiff: () => void;
  onAddPlan: () => void;
  onAddAgents: () => void;
  previewAvailable: boolean;
  filesAvailable: boolean;
  diffAvailable: boolean;
  planAvailable: boolean;
  agentsAvailable: boolean;
  liveAgentCount: number;
  diffShortcutLabel: string | null;
}) {
  const actions = [
    {
      kind: "agents",
      label: "Agents",
      description: "Follow subagents and background workflows.",
      icon: BotIcon,
      available: props.agentsAvailable,
      disabledReason: SURFACE_DISABLED_REASONS.agents,
      onClick: props.onAddAgents,
      shortcut: null,
    },
    {
      kind: "diff",
      label: "Diff",
      description: "Review the files changed by this thread.",
      icon: FileDiffIcon,
      available: props.diffAvailable,
      disabledReason: SURFACE_DISABLED_REASONS.diff,
      onClick: props.onAddDiff,
      shortcut: props.diffShortcutLabel,
    },
    {
      kind: "plan",
      label: "Plan",
      description: "Keep the current implementation plan visible.",
      icon: ClipboardListIcon,
      available: props.planAvailable,
      disabledReason: SURFACE_DISABLED_REASONS.plan,
      onClick: props.onAddPlan,
      shortcut: null,
    },
    {
      kind: "files",
      label: "Files",
      description: "Browse and read files in this workspace.",
      icon: FilesIcon,
      available: props.filesAvailable,
      disabledReason: SURFACE_DISABLED_REASONS.files,
      onClick: props.onAddFiles,
      shortcut: null,
    },
    {
      kind: "preview",
      label: "Preview",
      description: "Open a local app or web page.",
      icon: Globe2Icon,
      available: props.previewAvailable,
      disabledReason: SURFACE_DISABLED_REASONS.preview,
      onClick: props.onAddPreview,
      shortcut: null,
    },
  ] as const;

  return (
    <div className="flex min-h-0 flex-1 items-center justify-center overflow-y-auto p-6">
      <div className="w-full max-w-lg">
        <div className="mb-5 text-center">
          <h3 className="text-sm font-medium text-foreground">Open a panel</h3>
          <p className="mt-1 text-ui text-muted-foreground">
            Choose what to keep alongside this conversation.
          </p>
        </div>
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          {actions.map((action) => {
            const Icon = action.icon;
            const content = (
              <>
                <span className="flex w-full items-center gap-2">
                  <Icon className="size-4 text-muted-foreground" />
                  <span className="text-sm font-medium text-foreground">{action.label}</span>
                  {action.kind === "agents" && props.liveAgentCount > 0 ? (
                    <span className="rounded-full bg-info/15 px-1.5 py-0.5 text-2xs font-medium text-info-foreground tabular-nums">
                      {props.liveAgentCount} working
                    </span>
                  ) : null}
                  {action.shortcut && action.available ? (
                    <Kbd className="ml-auto">{action.shortcut}</Kbd>
                  ) : null}
                </span>
                <span className="text-ui leading-relaxed text-muted-foreground">
                  {action.available ? action.description : action.disabledReason}
                </span>
              </>
            );
            if (action.available) {
              return (
                <button
                  key={action.kind}
                  type="button"
                  onClick={action.onClick}
                  className="flex min-h-24 flex-col items-start justify-center gap-2 rounded-xl border border-border bg-card px-4 text-left transition-colors duration-(--duration-fast) hover:bg-accent/60 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
                >
                  {content}
                </button>
              );
            }
            return (
              <DisabledReasonTooltip
                key={action.kind}
                reason={action.disabledReason}
                trigger={
                  <button
                    type="button"
                    aria-disabled="true"
                    className="flex min-h-24 cursor-not-allowed flex-col items-start justify-center gap-2 rounded-xl border border-dashed border-border bg-transparent px-4 text-left opacity-60"
                  >
                    {content}
                  </button>
                }
              />
            );
          })}
        </div>
      </div>
    </div>
  );
}

export function RightPanelTabs(props: {
  mode: "sidebar" | "sheet";
  surfaces: readonly RightPanelSurface[];
  activeSurfaceId: string | null;
  onActivate: (surface: RightPanelSurface) => void;
  onCloseSurface: (surface: RightPanelSurface) => void;
  onCloseOtherSurfaces: (surface: RightPanelSurface) => void;
  onCloseSurfacesToRight: (surface: RightPanelSurface) => void;
  onCloseAllSurfaces: () => void;
  onCopyFilePath: (relativePath: string) => void;
  onAddPreview: () => void;
  onAddFiles: () => void;
  onAddDiff: () => void;
  onAddPlan: () => void;
  onAddAgents: () => void;
  previewAvailable: boolean;
  filesAvailable: boolean;
  diffAvailable: boolean;
  planAvailable: boolean;
  agentsAvailable: boolean;
  liveAgentCount: number;
  previewPresentation?: PreviewPresentation | undefined;
  children: ReactNode;
}) {
  const keybindings = useServerKeybindings();
  const tabListRef = useRef<HTMLDivElement>(null);
  const ownsDesktopTitleBar = isElectron && props.mode === "sidebar";

  useEffect(() => {
    const activeTab = tabListRef.current?.querySelector<HTMLElement>("[data-active-tab='true']");
    activeTab?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [props.activeSurfaceId]);

  const handleTabContextMenu = useCallback(
    async (event: ReactMouseEvent, surface: RightPanelSurface) => {
      event.preventDefault();
      event.stopPropagation();

      const api = readNativeApi();
      if (!api) {
        return;
      }

      const surfaceIndex = props.surfaces.findIndex((entry) => entry.id === surface.id);
      if (surfaceIndex < 0) {
        return;
      }

      const items: ContextMenuItem<TabContextMenuAction>[] = [];
      if (surface.kind === "file") {
        items.push({ id: "copy-path", label: "Copy path" });
      }
      items.push({ id: "close", label: "Close" });
      if (props.surfaces.length > 1) {
        items.push({ id: "close-others", label: "Close others" });
      }
      if (surfaceIndex < props.surfaces.length - 1) {
        items.push({ id: "close-to-right", label: "Close to the right" });
      }
      items.push({ id: "close-all", label: "Close all" });

      const action = await api.contextMenu.show(items, { x: event.clientX, y: event.clientY });
      switch (action) {
        case "copy-path":
          if (surface.kind === "file") {
            props.onCopyFilePath(surface.relativePath);
          }
          break;
        case "close":
          props.onCloseSurface(surface);
          break;
        case "close-others":
          props.onCloseOtherSurfaces(surface);
          break;
        case "close-to-right":
          props.onCloseSurfacesToRight(surface);
          break;
        case "close-all":
          props.onCloseAllSurfaces();
          break;
        case null:
          break;
      }
    },
    [props],
  );

  const handleTabMouseDown = useCallback((event: ReactMouseEvent) => {
    if (event.button !== 1) return;
    event.preventDefault();
  }, []);

  const handleTabAuxClick = useCallback(
    (event: ReactMouseEvent, surface: RightPanelSurface) => {
      if (event.button !== 1) return;
      event.preventDefault();
      event.stopPropagation();
      props.onCloseSurface(surface);
    },
    [props],
  );

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col bg-background">
      <div
        className={cn(
          "flex shrink-0 items-center border-b border-border px-2",
          // The inline panel owns the desktop title bar strip above it, so it
          // matches the canvas title bar height; the sheet keeps its own.
          ownsDesktopTitleBar ? "drag-region h-(--app-header-height)" : "h-10",
        )}
      >
        <div ref={tabListRef} className="min-w-0 flex-1">
          <ScrollArea scrollFade className="min-w-0 rounded-none">
            <div className="flex h-full w-max min-w-full items-center gap-1">
              {props.surfaces.map((surface) => {
                const active = surface.id === props.activeSurfaceId;
                const title = surfaceTitle(surface, props.previewPresentation);
                return (
                  <div
                    key={surface.id}
                    data-active-tab={active}
                    onMouseDown={handleTabMouseDown}
                    onAuxClick={(event) => handleTabAuxClick(event, surface)}
                    onContextMenu={(event) => void handleTabContextMenu(event, surface)}
                    className={cn(
                      "group flex h-7 min-w-24 max-w-44 shrink-0 items-center gap-1.5 rounded-md px-2 text-ui [-webkit-app-region:no-drag]",
                      active
                        ? "bg-accent text-foreground"
                        : "text-muted-foreground hover:bg-accent/60 hover:text-foreground",
                    )}
                  >
                    <Tooltip>
                      <TooltipTrigger
                        render={
                          <button
                            type="button"
                            className="flex min-w-0 flex-1 items-center gap-1.5"
                            onClick={() => props.onActivate(surface)}
                          >
                            <SurfaceIcon
                              surface={surface}
                              previewPresentation={props.previewPresentation}
                            />
                            <span className="truncate">{title}</span>
                            {surface.kind === "agents" && props.liveAgentCount > 0 ? (
                              <span className="flex h-4 min-w-4 shrink-0 items-center justify-center rounded-full bg-info px-1 text-2xs leading-none font-semibold text-white tabular-nums">
                                {props.liveAgentCount}
                              </span>
                            ) : null}
                          </button>
                        }
                      />
                      <TooltipPopup>
                        {surface.kind === "file" ? surface.relativePath : title}
                      </TooltipPopup>
                    </Tooltip>
                    <button
                      type="button"
                      className={cn(
                        "flex size-5 shrink-0 items-center justify-center rounded-sm text-muted-foreground opacity-0 outline-none hover:bg-background/70 hover:text-foreground focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-ring group-hover:opacity-100 pointer-coarse:opacity-100",
                        active && "opacity-100",
                      )}
                      aria-label={`Close ${title}`}
                      onClick={() => props.onCloseSurface(surface)}
                    >
                      <XIcon className="size-3.5" />
                    </button>
                  </div>
                );
              })}
              <Menu>
                <MenuTrigger
                  className="relative inline-flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground [-webkit-app-region:no-drag]"
                  aria-label="Add panel surface"
                >
                  <PlusIcon className="size-4" />
                </MenuTrigger>
                <MenuPopup align="start" side="bottom" sideOffset={6} className="min-w-44">
                  <SurfaceMenuItem
                    available={props.agentsAvailable}
                    disabledReason={SURFACE_DISABLED_REASONS.agents}
                    onClick={props.onAddAgents}
                  >
                    <BotIcon />
                    Agents
                  </SurfaceMenuItem>
                  <SurfaceMenuItem
                    shortcut={shortcutLabelForCommand(keybindings, "diff.toggle")}
                    available={props.diffAvailable}
                    disabledReason={SURFACE_DISABLED_REASONS.diff}
                    onClick={props.onAddDiff}
                  >
                    <FileDiffIcon />
                    Diff
                  </SurfaceMenuItem>
                  <SurfaceMenuItem
                    available={props.planAvailable}
                    disabledReason={SURFACE_DISABLED_REASONS.plan}
                    onClick={props.onAddPlan}
                  >
                    <ClipboardListIcon />
                    Plan
                  </SurfaceMenuItem>
                  <SurfaceMenuItem
                    available={props.filesAvailable}
                    disabledReason={SURFACE_DISABLED_REASONS.files}
                    onClick={props.onAddFiles}
                  >
                    <FilesIcon />
                    Files
                  </SurfaceMenuItem>
                  <SurfaceMenuItem
                    available={props.previewAvailable}
                    disabledReason={SURFACE_DISABLED_REASONS.preview}
                    onClick={props.onAddPreview}
                  >
                    <Globe2Icon />
                    Preview
                  </SurfaceMenuItem>
                </MenuPopup>
              </Menu>
            </div>
          </ScrollArea>
        </div>
      </div>
      <div className="flex min-h-0 flex-1 flex-col">
        {props.activeSurfaceId === null ? (
          <RightPanelEmptyState
            onAddPreview={props.onAddPreview}
            onAddFiles={props.onAddFiles}
            onAddDiff={props.onAddDiff}
            onAddPlan={props.onAddPlan}
            onAddAgents={props.onAddAgents}
            previewAvailable={props.previewAvailable}
            filesAvailable={props.filesAvailable}
            diffAvailable={props.diffAvailable}
            planAvailable={props.planAvailable}
            agentsAvailable={props.agentsAvailable}
            liveAgentCount={props.liveAgentCount}
            diffShortcutLabel={shortcutLabelForCommand(keybindings, "diff.toggle")}
          />
        ) : (
          props.children
        )}
      </div>
    </div>
  );
}
