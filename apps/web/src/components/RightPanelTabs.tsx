import type { ContextMenuItem } from "@t3tools/contracts";
import {
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

import { isElectron } from "../env";
import { cn } from "../lib/utils";
import { readNativeApi } from "../nativeApi";
import type { RightPanelSurface } from "../rightPanelStore";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "./ui/menu";
import { ScrollArea } from "./ui/scroll-area";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";

type AddableSurface = "preview" | "files" | "diff" | "plan";
type TabContextMenuAction = "copy-path" | "close" | "close-others" | "close-to-right" | "close-all";

const SURFACE_DISABLED_REASONS = {
  preview: "Preview is not available in this build.",
  files: "Workspace files are available after opening a project thread.",
  diff: "Diff is available after opening a thread.",
  plan: "Plan is available after opening a thread.",
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
}) {
  const item = (
    <MenuItem
      className={!props.available ? "data-disabled:pointer-events-auto" : undefined}
      disabled={!props.available}
      onClick={props.available ? props.onClick : undefined}
    >
      {props.children}
    </MenuItem>
  );

  if (props.available) {
    return item;
  }
  return <DisabledReasonTooltip reason={props.disabledReason} trigger={item} />;
}

function surfaceTitle(surface: RightPanelSurface): string {
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
      return "Preview";
  }
}

function SurfaceIcon({ surface }: { surface: RightPanelSurface }) {
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
      return <Globe2Icon className="size-3.5 shrink-0" />;
  }
}

function RightPanelEmptyState(props: {
  onAddPreview: () => void;
  onAddFiles: () => void;
  onAddDiff: () => void;
  onAddPlan: () => void;
  previewAvailable: boolean;
  filesAvailable: boolean;
  diffAvailable: boolean;
  planAvailable: boolean;
}) {
  const actions = [
    {
      kind: "diff",
      label: "Diff",
      icon: FileDiffIcon,
      available: props.diffAvailable,
      disabledReason: SURFACE_DISABLED_REASONS.diff,
      onClick: props.onAddDiff,
    },
    {
      kind: "plan",
      label: "Plan",
      icon: ClipboardListIcon,
      available: props.planAvailable,
      disabledReason: SURFACE_DISABLED_REASONS.plan,
      onClick: props.onAddPlan,
    },
    {
      kind: "files",
      label: "Files",
      icon: FilesIcon,
      available: props.filesAvailable,
      disabledReason: SURFACE_DISABLED_REASONS.files,
      onClick: props.onAddFiles,
    },
    {
      kind: "preview",
      label: "Preview",
      icon: Globe2Icon,
      available: props.previewAvailable,
      disabledReason: SURFACE_DISABLED_REASONS.preview,
      onClick: props.onAddPreview,
    },
  ] as const;

  return (
    <div className="flex min-h-0 flex-1 items-center justify-center p-6">
      <div className="grid w-full max-w-md grid-cols-2 gap-2">
        {actions.map((action) => {
          const Icon = action.icon;
          const content = (
            <>
              <Icon className="size-4" />
              <span className="text-sm font-medium">{action.label}</span>
            </>
          );
          if (action.available) {
            return (
              <button
                key={action.kind}
                type="button"
                onClick={action.onClick}
                className="flex h-20 flex-col items-start justify-center gap-2 rounded-md border border-border/80 bg-card/40 px-4 text-left transition hover:border-border hover:bg-accent/60"
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
                  className="flex h-20 cursor-not-allowed flex-col items-start justify-center gap-2 rounded-md border border-border/80 bg-card/40 px-4 text-left opacity-45"
                >
                  {content}
                </button>
              }
            />
          );
        })}
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
  previewAvailable: boolean;
  filesAvailable: boolean;
  diffAvailable: boolean;
  planAvailable: boolean;
  children: ReactNode;
}) {
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
          "flex h-10 shrink-0 items-center border-b border-border bg-card/70 px-2",
          ownsDesktopTitleBar && "drag-region",
        )}
      >
        <div ref={tabListRef} className="min-w-0 flex-1">
          <ScrollArea hideScrollbars scrollFade className="min-w-0 rounded-none">
            <div className="flex h-full w-max min-w-full items-center gap-1">
              {props.surfaces.map((surface) => {
                const active = surface.id === props.activeSurfaceId;
                const title = surfaceTitle(surface);
                return (
                  <div
                    key={surface.id}
                    data-active-tab={active}
                    onMouseDown={handleTabMouseDown}
                    onAuxClick={(event) => handleTabAuxClick(event, surface)}
                    onContextMenu={(event) => void handleTabContextMenu(event, surface)}
                    className={cn(
                      "group flex h-7 min-w-24 max-w-44 shrink-0 items-center gap-1.5 rounded-md px-2 text-sm [-webkit-app-region:no-drag]",
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
                            <SurfaceIcon surface={surface} />
                            <span className="truncate">{title}</span>
                          </button>
                        }
                      />
                      <TooltipPopup>
                        {surface.kind === "file" ? surface.relativePath : title}
                      </TooltipPopup>
                    </Tooltip>
                    <button
                      type="button"
                      className="flex size-4 shrink-0 items-center justify-center rounded opacity-0 hover:bg-muted focus:opacity-100 group-hover:opacity-100"
                      aria-label={`Close ${title}`}
                      onClick={() => props.onCloseSurface(surface)}
                    >
                      <XIcon className="size-3" />
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
            previewAvailable={props.previewAvailable}
            filesAvailable={props.filesAvailable}
            diffAvailable={props.diffAvailable}
            planAvailable={props.planAvailable}
          />
        ) : (
          props.children
        )}
      </div>
    </div>
  );
}
