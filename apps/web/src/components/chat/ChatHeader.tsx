import { ScheduledOriginBadge } from "../scheduled/ScheduledOriginBadge";
import { ThreadSettlementControl } from "../thread/ThreadSettlementControl";
import { ThreadPrLinks } from "../prHub/ThreadPrLinks";
import {
  type EditorId,
  type ProjectId,
  type ProjectScript,
  type ResolvedKeybindingsConfig,
  type ThreadId,
} from "@t3tools/contracts";
import { memo, useState, type ComponentType, type ReactNode } from "react";
import GitActionsControl from "../GitActionsControl";
import {
  BotIcon,
  ChevronRightIcon,
  DiffIcon,
  EllipsisIcon,
  FilesIcon,
  Globe2Icon,
  PanelRightIcon,
  SettingsIcon,
  SquarePenIcon,
  TerminalSquareIcon,
} from "lucide-react";
import ProjectScriptsControl, { type NewProjectScriptInput } from "../ProjectScriptsControl";
import { OpenInPicker } from "./OpenInPicker";
import { ThreadQueueCountBadge } from "../thread/ThreadQueueCountBadge";
import { ThreadStatusPillBadge } from "../thread/ThreadStatusPillBadge";
import { Button } from "../ui/button";
import {
  Menu,
  MenuCheckboxItem,
  MenuGroup,
  MenuGroupLabel,
  MenuItem,
  MenuPopup,
  MenuSeparator,
  MenuTrigger,
} from "../ui/menu";
import { Separator } from "../ui/separator";
import { ToolbarToggle } from "../ui/toolbar-toggle";
import { InlineTitleEditor } from "../InlineTitleEditor";
import { ProjectIcon } from "../ProjectIcon";
import type { ThreadActionId, ThreadActionMenuItem } from "../../hooks/useThreadActionController";
import {
  WORKFLOW_TYPE_ICON,
  WORKFLOW_TYPE_ICON_CLASS,
  type WorkflowTypeValue,
} from "../../lib/workflowType";
import { cn } from "../../lib/utils";
import type { ThreadStatusPill } from "../../threadStatus";
import type { Project } from "../../types";
import type { RightPanelSurfaceHeaderState } from "../../rightPanelStore";

interface ChatHeaderProps {
  activeThreadId: ThreadId;
  isServerThread: boolean;
  activeThreadTitle: string;
  nativeGoalSummary?: string | undefined;
  scheduledOrigin?: import("@t3tools/contracts").ScheduledOrigin | null | undefined;
  activeProjectId?: ProjectId | undefined;
  activeProjectIcon?: Project["icon"] | undefined;
  activeProjectName: string | undefined;
  onNewThreadInProject?: (() => void) | undefined;
  onOpenProjectSettings?: (() => void) | undefined;
  workflowTitle?: string | undefined;
  workflowType?: WorkflowTypeValue | undefined;
  onOpenWorkflow?: (() => void) | undefined;
  threadStatus?: ThreadStatusPill | null | undefined;
  /** Runtime info and details, folded in from their own row (compact chat layout). */
  runtimeControls?: ReactNode;
  isGitRepo: boolean;
  openInCwd: string | null;
  activeProjectScripts: ProjectScript[] | undefined;
  preferredScriptId: string | null;
  keybindings: ResolvedKeybindingsConfig;
  availableEditors: ReadonlyArray<EditorId>;
  terminalAvailable: boolean;
  terminalOpen: boolean;
  workspaceFilesAvailable: boolean;
  filesState: RightPanelSurfaceHeaderState;
  agentsState: RightPanelSurfaceHeaderState;
  previewState: RightPanelSurfaceHeaderState;
  previewAvailable: boolean;
  liveAgentCount: number;
  terminalToggleShortcutLabel: string | null;
  diffToggleShortcutLabel: string | null;
  gitCwd: string | null;
  diffState: RightPanelSurfaceHeaderState;
  threadActionItems: ReadonlyArray<ThreadActionMenuItem>;
  onThreadAction: (actionId: ThreadActionId) => void;
  onRenameThread: (title: string) => void;
  onRunProjectScript: (script: ProjectScript) => void;
  onAddProjectScript: (input: NewProjectScriptInput) => Promise<void>;
  onUpdateProjectScript: (scriptId: string, input: NewProjectScriptInput) => Promise<void>;
  onDeleteProjectScript: (scriptId: string) => Promise<void>;
  onToggleTerminal: () => void;
  onToggleFiles: () => void;
  onToggleAgents: () => void;
  onTogglePreview: () => void;
  onToggleDiff: () => void;
}

interface PanelToggleSpec {
  key: string;
  icon: ComponentType<{ className?: string }>;
  label: string;
  ariaLabel: string;
  shortcutLabel: string | null;
  state: RightPanelSurfaceHeaderState;
  disabled: boolean;
  disabledReason: string;
  badgeCount?: number;
  onToggle: () => void;
}

const CRUMB_SEPARATOR = (
  <ChevronRightIcon aria-hidden="true" className="size-3.5 shrink-0 text-faint-foreground" />
);

export const ChatHeader = memo(function ChatHeader({
  activeThreadId,
  isServerThread,
  activeThreadTitle,
  nativeGoalSummary,
  scheduledOrigin,
  activeProjectId,
  activeProjectIcon,
  activeProjectName,
  onNewThreadInProject,
  onOpenProjectSettings,
  workflowTitle,
  workflowType,
  onOpenWorkflow,
  threadStatus,
  runtimeControls,
  isGitRepo,
  openInCwd,
  activeProjectScripts,
  preferredScriptId,
  keybindings,
  availableEditors,
  terminalAvailable,
  terminalOpen,
  workspaceFilesAvailable,
  filesState,
  agentsState,
  previewState,
  previewAvailable,
  liveAgentCount,
  terminalToggleShortcutLabel,
  diffToggleShortcutLabel,
  gitCwd,
  diffState,
  threadActionItems,
  onThreadAction,
  onRenameThread,
  onRunProjectScript,
  onAddProjectScript,
  onUpdateProjectScript,
  onDeleteProjectScript,
  onToggleTerminal,
  onToggleFiles,
  onToggleAgents,
  onTogglePreview,
  onToggleDiff,
}: ChatHeaderProps) {
  "use memo";
  const [renamingThreadId, setRenamingThreadId] = useState<ThreadId | null>(null);
  const isRenaming = renamingThreadId === activeThreadId;
  const agentsWorkingLabel =
    liveAgentCount > 0
      ? `${liveAgentCount} ${liveAgentCount === 1 ? "agent" : "agents"} working`
      : null;

  // Right-panel tabs: clicking a background tab brings it to front rather than closing it.
  const sidePanels: PanelToggleSpec[] = [
    {
      key: "files",
      icon: FilesIcon,
      label: "Files",
      ariaLabel: "Toggle workspace files",
      shortcutLabel: null,
      state: filesState,
      disabled: !workspaceFilesAvailable,
      disabledReason: "Workspace files are unavailable until this thread has an active project.",
      onToggle: onToggleFiles,
    },
    {
      key: "diff",
      icon: DiffIcon,
      label: "Diff",
      ariaLabel: "Toggle diff panel",
      shortcutLabel: diffToggleShortcutLabel,
      state: diffState,
      disabled: !isGitRepo && diffState === "closed",
      disabledReason: "Diff panel is unavailable because this project is not a git repository.",
      onToggle: onToggleDiff,
    },
    ...(previewAvailable
      ? [
          {
            key: "preview",
            icon: Globe2Icon,
            label: "Preview",
            ariaLabel: "Toggle preview",
            shortcutLabel: null,
            state: previewState,
            disabled: false,
            disabledReason: "",
            onToggle: onTogglePreview,
          } satisfies PanelToggleSpec,
        ]
      : []),
    {
      key: "agents",
      icon: BotIcon,
      label: agentsWorkingLabel ? `Agents · ${agentsWorkingLabel}` : "Agents",
      ariaLabel: agentsWorkingLabel
        ? `Toggle Agents panel, ${agentsWorkingLabel}`
        : "Toggle Agents panel",
      shortcutLabel: null,
      state: agentsState,
      disabled: false,
      disabledReason: "",
      badgeCount: liveAgentCount,
      onToggle: onToggleAgents,
    },
  ];
  // The terminal is a bottom drawer, so it sits apart from the side-panel tabs.
  const terminalPanel: PanelToggleSpec = {
    key: "terminal",
    icon: TerminalSquareIcon,
    label: "Terminal",
    ariaLabel: "Toggle terminal drawer",
    shortcutLabel: terminalToggleShortcutLabel,
    state: terminalOpen ? "active" : "closed",
    disabled: !terminalAvailable,
    disabledReason: "Terminal is unavailable until this thread has an active project.",
    onToggle: onToggleTerminal,
  };

  const WorkflowIcon = workflowType ? WORKFLOW_TYPE_ICON[workflowType] : null;

  return (
    <div className="@container/header-actions flex min-w-0 flex-1 items-center gap-2">
      <nav
        aria-label="Breadcrumb"
        className="flex min-w-0 flex-1 items-center gap-1.5 overflow-hidden"
      >
        {activeProjectName && onNewThreadInProject && onOpenProjectSettings ? (
          <Menu>
            <MenuTrigger
              render={
                <button
                  type="button"
                  className="flex min-w-0 max-w-44 shrink cursor-pointer items-center gap-1.5 rounded-md px-1 py-0.5 text-ui text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
                  aria-label={`Project actions for ${activeProjectName}`}
                />
              }
            >
              {activeProjectId ? (
                <ProjectIcon
                  projectId={activeProjectId}
                  name={activeProjectName}
                  icon={activeProjectIcon}
                  className="size-4 shrink-0"
                />
              ) : null}
              <span className="hidden truncate @md/header-actions:inline">{activeProjectName}</span>
            </MenuTrigger>
            <MenuPopup side="bottom" align="start">
              <MenuItem onClick={onNewThreadInProject}>
                <SquarePenIcon aria-hidden="true" />
                New thread in {activeProjectName}
              </MenuItem>
              <MenuItem onClick={onOpenProjectSettings}>
                <SettingsIcon aria-hidden="true" />
                Project settings
              </MenuItem>
            </MenuPopup>
          </Menu>
        ) : activeProjectName ? (
          <span className="flex min-w-0 shrink items-center gap-1.5 px-1 text-ui text-muted-foreground">
            {activeProjectId ? (
              <ProjectIcon
                projectId={activeProjectId}
                name={activeProjectName}
                icon={activeProjectIcon}
                className="size-4 shrink-0"
              />
            ) : null}
            <span className="truncate">{activeProjectName}</span>
          </span>
        ) : null}
        {activeProjectName ? CRUMB_SEPARATOR : null}
        {workflowTitle && onOpenWorkflow ? (
          <>
            <button
              type="button"
              onClick={onOpenWorkflow}
              title={workflowTitle}
              className="flex min-w-0 max-w-40 shrink items-center gap-1.5 rounded-md px-1 py-0.5 text-ui text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
            >
              {WorkflowIcon && workflowType ? (
                <WorkflowIcon
                  aria-hidden="true"
                  className={cn("size-4 shrink-0", WORKFLOW_TYPE_ICON_CLASS[workflowType])}
                />
              ) : null}
              <span className="truncate">{workflowTitle}</span>
            </button>
            {CRUMB_SEPARATOR}
          </>
        ) : null}
        {isRenaming ? (
          <InlineTitleEditor
            key={activeThreadId}
            ariaLabel="Rename thread"
            className="min-w-24 max-w-72 flex-1 truncate rounded-sm border border-ring bg-transparent px-1 text-sm font-medium text-foreground outline-none"
            initialValue={activeThreadTitle}
            onCancel={() => setRenamingThreadId(null)}
            onCommit={(title) => {
              setRenamingThreadId(null);
              onRenameThread(title);
            }}
          />
        ) : (
          <h2
            className="min-w-0 shrink truncate px-1 text-sm font-medium text-foreground"
            title={activeThreadTitle}
            onDoubleClick={() => {
              if (threadActionItems.some((item) => item.id === "rename" && !item.disabled))
                setRenamingThreadId(activeThreadId);
            }}
          >
            {activeThreadTitle}
          </h2>
        )}
        <ScheduledOriginBadge origin={scheduledOrigin} />
        {nativeGoalSummary && (
          <span
            className="max-w-64 truncate text-xs text-muted-foreground"
            title={nativeGoalSummary}
          >
            {nativeGoalSummary}
          </span>
        )}
        {isServerThread ? (
          <>
            <ThreadPrLinks threadId={activeThreadId} />
            <ThreadSettlementControl threadId={activeThreadId} />
          </>
        ) : null}
        {threadStatus ? (
          <ThreadStatusPillBadge
            pill={threadStatus}
            variant="chip"
            live={false}
            hideLabelBelowMd
            className="shrink-0"
          />
        ) : null}
        {/* Full wording when there is room; icon and count when the header is narrow. */}
        <ThreadQueueCountBadge
          threadId={activeThreadId}
          className="hidden @xl/header-actions:inline-flex"
        />
        <ThreadQueueCountBadge
          compact
          threadId={activeThreadId}
          className="@xl/header-actions:hidden"
        />
        {runtimeControls ? (
          <div data-slot="header-runtime-controls" className="flex shrink-0 items-center gap-1">
            {runtimeControls}
          </div>
        ) : null}
      </nav>
      <div className="flex shrink-0 items-center justify-end gap-2">
        {activeProjectScripts && (
          <ProjectScriptsControl
            scripts={activeProjectScripts}
            keybindings={keybindings}
            preferredScriptId={preferredScriptId}
            onRunScript={onRunProjectScript}
            onAddScript={onAddProjectScript}
            onUpdateScript={onUpdateProjectScript}
            onDeleteScript={onDeleteProjectScript}
          />
        )}
        {activeProjectName && (
          <OpenInPicker
            keybindings={keybindings}
            availableEditors={availableEditors}
            openInCwd={openInCwd}
          />
        )}
        {activeProjectName && (
          <GitActionsControl
            gitCwd={gitCwd}
            activeThreadId={activeThreadId}
            isServerThread={isServerThread}
          />
        )}
        {activeProjectName ? (
          <Separator orientation="vertical" className="mx-0.5 h-4 self-center" />
        ) : null}
        <div className="hidden items-center gap-2 @xl/header-actions:flex">
          <div
            role="group"
            aria-label="Side panel"
            className="flex items-center gap-px rounded-lg border border-border/70 bg-muted/40 p-0.5"
          >
            {sidePanels.map((panel) => (
              <PanelToggle key={panel.key} panel={panel} variant="segmented" />
            ))}
          </div>
          <Separator orientation="vertical" className="mx-0.5 h-4 self-center" />
          <PanelToggle panel={terminalPanel} />
        </div>
        <Menu>
          <MenuTrigger
            render={
              <Button
                type="button"
                size="icon-sm"
                variant="ghost"
                aria-label="Panels"
                className="relative text-muted-foreground @xl/header-actions:hidden"
              />
            }
          >
            <PanelRightIcon aria-hidden="true" className="size-4" />
            {liveAgentCount > 0 ? (
              <span
                aria-hidden="true"
                className="absolute -top-1 -right-1 size-2 rounded-full bg-info"
              />
            ) : null}
          </MenuTrigger>
          <MenuPopup side="bottom" align="end" className="min-w-52">
            <MenuGroup>
              <MenuGroupLabel>Side panel</MenuGroupLabel>
              {sidePanels.map((panel) => (
                <PanelMenuItem key={panel.key} panel={panel} />
              ))}
            </MenuGroup>
            <MenuSeparator />
            <MenuGroup>
              <MenuGroupLabel>Bottom</MenuGroupLabel>
              <PanelMenuItem panel={terminalPanel} />
            </MenuGroup>
          </MenuPopup>
        </Menu>
        <Menu>
          <MenuTrigger
            render={
              <Button
                type="button"
                size="icon-sm"
                variant="ghost"
                aria-label="Thread actions"
                title="Thread actions"
                className="text-muted-foreground"
              />
            }
          >
            <EllipsisIcon aria-hidden="true" className="size-4" />
          </MenuTrigger>
          <MenuPopup side="bottom" align="end">
            {threadActionItems.map((item, index) => (
              <ThreadActionMenuEntry
                key={item.id}
                item={item}
                separatorBefore={
                  item.separatorBefore === true ||
                  (item.destructive === true &&
                    index > 0 &&
                    threadActionItems[index - 1]?.destructive !== true)
                }
                onSelect={() => {
                  if (item.id === "rename") {
                    setRenamingThreadId(activeThreadId);
                    return;
                  }
                  onThreadAction(item.id);
                }}
              />
            ))}
          </MenuPopup>
        </Menu>
      </div>
    </div>
  );
});

function PanelToggle(props: { panel: PanelToggleSpec; variant?: "default" | "segmented" }) {
  const { panel } = props;
  return (
    <ToolbarToggle
      icon={panel.icon}
      label={panel.label}
      ariaLabel={panel.ariaLabel}
      shortcutLabel={panel.shortcutLabel}
      pressed={panel.state === "active"}
      inBackground={panel.state === "background"}
      variant={props.variant}
      onPressedChange={() => panel.onToggle()}
      disabled={panel.disabled}
      disabledReason={panel.disabledReason}
      badgeCount={panel.badgeCount}
    />
  );
}

function PanelMenuItem(props: { panel: PanelToggleSpec }) {
  const { panel } = props;
  const Icon = panel.icon;
  return (
    <MenuCheckboxItem
      checked={panel.state === "active"}
      disabled={panel.disabled}
      aria-label={`${panel.ariaLabel}${panel.state === "background" ? ", open in background" : ""}`}
      onCheckedChange={() => panel.onToggle()}
    >
      <span className="flex w-full items-center gap-2">
        <Icon aria-hidden="true" className="size-4 text-muted-foreground" />
        <span className="truncate">{panel.label}</span>
        {panel.state === "background" ? (
          <span className="ml-auto pl-3 text-xs text-muted-foreground">in background</span>
        ) : null}
        {panel.badgeCount && panel.badgeCount > 0 ? (
          <span
            aria-hidden="true"
            className={cn(
              "flex h-4 min-w-4 items-center justify-center rounded-full bg-info px-1 text-2xs leading-none font-semibold text-white tabular-nums",
              panel.state !== "background" && "ml-auto",
            )}
          >
            {panel.badgeCount}
          </span>
        ) : null}
      </span>
    </MenuCheckboxItem>
  );
}

function ThreadActionMenuEntry(props: {
  item: ThreadActionMenuItem;
  separatorBefore: boolean;
  onSelect: () => void;
}) {
  return (
    <>
      {props.separatorBefore ? <MenuSeparator /> : null}
      <MenuItem
        disabled={props.item.disabled}
        variant={props.item.destructive ? "destructive" : "default"}
        onClick={props.onSelect}
      >
        {props.item.label}
      </MenuItem>
    </>
  );
}
