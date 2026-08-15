import {
  type EditorId,
  type ProjectScript,
  type ProviderKind,
  type ResolvedKeybindingsConfig,
  type ThreadId,
} from "@t3tools/contracts";
import { memo, useState } from "react";
import GitActionsControl from "../GitActionsControl";
import { DiffIcon, EllipsisIcon, FilesIcon, TerminalSquareIcon } from "lucide-react";
import { Badge } from "../ui/badge";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import ProjectScriptsControl, { type NewProjectScriptInput } from "../ProjectScriptsControl";
import { Toggle } from "../ui/toggle";
import { SidebarTrigger } from "../ui/sidebar";
import { OpenInPicker } from "./OpenInPicker";
import ContextWindowBadge from "./ContextWindowBadge";
import ThinkingTokenBadge from "./ThinkingTokenBadge";
import { ThreadQueueCountBadge } from "../thread/ThreadQueueCountBadge";
import { Button } from "../ui/button";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { InlineTitleEditor } from "../InlineTitleEditor";
import type { ThreadActionId, ThreadActionMenuItem } from "../../hooks/useThreadActionController";

interface ChatHeaderProps {
  activeThreadId: ThreadId;
  activeThreadTitle: string;
  estimatedContextTokens: number | null;
  estimatedThinkingTokens: number | null;
  modelContextWindowTokens: number | null;
  model: string;
  provider: ProviderKind | null;
  tokenUsageSource?: "provider" | "estimated" | null | undefined;
  activeProjectName: string | undefined;
  workflowTitle?: string | undefined;
  onOpenWorkflow?: (() => void) | undefined;
  isGitRepo: boolean;
  openInCwd: string | null;
  activeProjectScripts: ProjectScript[] | undefined;
  preferredScriptId: string | null;
  keybindings: ResolvedKeybindingsConfig;
  availableEditors: ReadonlyArray<EditorId>;
  terminalAvailable: boolean;
  terminalOpen: boolean;
  workspaceFilesAvailable: boolean;
  filesOpen: boolean;
  terminalToggleShortcutLabel: string | null;
  diffToggleShortcutLabel: string | null;
  gitCwd: string | null;
  diffOpen: boolean;
  threadActionItems: ReadonlyArray<ThreadActionMenuItem>;
  onThreadAction: (actionId: ThreadActionId) => void;
  onRenameThread: (title: string) => void;
  onRunProjectScript: (script: ProjectScript) => void;
  onAddProjectScript: (input: NewProjectScriptInput) => Promise<void>;
  onUpdateProjectScript: (scriptId: string, input: NewProjectScriptInput) => Promise<void>;
  onDeleteProjectScript: (scriptId: string) => Promise<void>;
  onToggleTerminal: () => void;
  onToggleFiles: () => void;
  onToggleDiff: () => void;
}

export const ChatHeader = memo(function ChatHeader({
  activeThreadId,
  activeThreadTitle,
  estimatedContextTokens,
  estimatedThinkingTokens,
  modelContextWindowTokens,
  model,
  provider,
  tokenUsageSource,
  activeProjectName,
  workflowTitle,
  onOpenWorkflow,
  isGitRepo,
  openInCwd,
  activeProjectScripts,
  preferredScriptId,
  keybindings,
  availableEditors,
  terminalAvailable,
  terminalOpen,
  workspaceFilesAvailable,
  filesOpen,
  terminalToggleShortcutLabel,
  diffToggleShortcutLabel,
  gitCwd,
  diffOpen,
  threadActionItems,
  onThreadAction,
  onRenameThread,
  onRunProjectScript,
  onAddProjectScript,
  onUpdateProjectScript,
  onDeleteProjectScript,
  onToggleTerminal,
  onToggleFiles,
  onToggleDiff,
}: ChatHeaderProps) {
  const [renamingThreadId, setRenamingThreadId] = useState<ThreadId | null>(null);
  const isRenaming = renamingThreadId === activeThreadId;

  return (
    <div className="flex min-w-0 flex-1 items-center gap-2">
      <div className="flex min-w-0 flex-1 items-center gap-2 overflow-hidden sm:gap-3">
        <SidebarTrigger className="size-7 shrink-0 md:hidden" />
        {isRenaming ? (
          <InlineTitleEditor
            key={activeThreadId}
            ariaLabel="Rename thread"
            className="min-w-24 max-w-72 flex-1 truncate rounded border border-ring bg-transparent px-1 text-sm font-medium text-foreground outline-none"
            initialValue={activeThreadTitle}
            onCancel={() => setRenamingThreadId(null)}
            onCommit={(title) => {
              setRenamingThreadId(null);
              onRenameThread(title);
            }}
          />
        ) : (
          <h2
            className="min-w-0 shrink truncate text-sm font-medium text-foreground"
            title={activeThreadTitle}
          >
            {activeThreadTitle}
          </h2>
        )}
        <ThreadQueueCountBadge threadId={activeThreadId} />
        {activeProjectName && (
          <Badge variant="outline" className="min-w-0 shrink truncate">
            {activeProjectName}
          </Badge>
        )}
        {workflowTitle && onOpenWorkflow ? (
          <button type="button" onClick={onOpenWorkflow} className="min-w-0 shrink">
            <Badge variant="outline" className="min-w-0 shrink truncate">
              {workflowTitle}
            </Badge>
          </button>
        ) : null}
        <ContextWindowBadge
          estimatedContextTokens={estimatedContextTokens}
          modelContextWindowTokens={modelContextWindowTokens}
          model={model}
          provider={provider}
          tokenUsageSource={tokenUsageSource}
        />
        <ThinkingTokenBadge estimatedThinkingTokens={estimatedThinkingTokens} />
        {activeProjectName && !isGitRepo && (
          <Badge variant="outline" className="shrink-0 text-[10px] text-amber-700">
            No Git
          </Badge>
        )}
      </div>
      <div className="@container/header-actions flex min-w-0 flex-1 items-center justify-end gap-2 @sm/header-actions:gap-3">
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
        {activeProjectName && <GitActionsControl gitCwd={gitCwd} activeThreadId={activeThreadId} />}
        <Tooltip>
          <TooltipTrigger
            render={
              <Toggle
                className="shrink-0"
                pressed={terminalOpen}
                onPressedChange={onToggleTerminal}
                aria-label="Toggle terminal drawer"
                variant="outline"
                size="xs"
                disabled={!terminalAvailable}
              >
                <TerminalSquareIcon className="size-3" />
              </Toggle>
            }
          />
          <TooltipPopup side="bottom">
            {!terminalAvailable
              ? "Terminal is unavailable until this thread has an active project."
              : terminalToggleShortcutLabel
                ? `Toggle terminal drawer (${terminalToggleShortcutLabel})`
                : "Toggle terminal drawer"}
          </TooltipPopup>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger
            render={
              <Toggle
                className="shrink-0"
                pressed={filesOpen}
                onPressedChange={onToggleFiles}
                aria-label="Toggle workspace files"
                variant="outline"
                size="xs"
                disabled={!workspaceFilesAvailable}
              >
                <FilesIcon className="size-3" />
              </Toggle>
            }
          />
          <TooltipPopup side="bottom">
            {workspaceFilesAvailable
              ? "Toggle workspace files"
              : "Workspace files are unavailable until this thread has an active project."}
          </TooltipPopup>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger
            render={
              <Toggle
                className="shrink-0"
                pressed={diffOpen}
                onPressedChange={onToggleDiff}
                aria-label="Toggle diff panel"
                variant="outline"
                size="xs"
                disabled={!isGitRepo && !diffOpen}
              >
                <DiffIcon className="size-3" />
              </Toggle>
            }
          />
          <TooltipPopup side="bottom">
            {!isGitRepo && !diffOpen
              ? "Diff panel is unavailable because this project is not a git repository."
              : diffToggleShortcutLabel
                ? `Toggle diff panel (${diffToggleShortcutLabel})`
                : "Toggle diff panel"}
          </TooltipPopup>
        </Tooltip>
        <Menu>
          <MenuTrigger
            render={
              <Button
                type="button"
                size="icon-xs"
                variant="outline"
                aria-label="Thread actions"
                title="Thread actions"
              />
            }
          >
            <EllipsisIcon aria-hidden="true" className="size-3.5" />
          </MenuTrigger>
          <MenuPopup side="bottom" align="end">
            {threadActionItems.map((item) => (
              <MenuItem
                key={item.id}
                disabled={item.disabled}
                variant={item.destructive ? "destructive" : "default"}
                onClick={() => {
                  if (item.id === "rename") {
                    setRenamingThreadId(activeThreadId);
                    return;
                  }
                  onThreadAction(item.id);
                }}
              >
                {item.label}
              </MenuItem>
            ))}
          </MenuPopup>
        </Menu>
      </div>
    </div>
  );
});
