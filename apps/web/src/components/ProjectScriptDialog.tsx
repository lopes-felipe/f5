import type {
  ProjectScript,
  ProjectScriptIcon,
  ResolvedKeybindingsConfig,
} from "@t3tools/contracts";
import {
  BugIcon,
  FlaskConicalIcon,
  HammerIcon,
  ListChecksIcon,
  PlayIcon,
  WrenchIcon,
} from "lucide-react";
import React, { type FormEvent, type KeyboardEvent, useCallback, useMemo, useState } from "react";

import {
  keybindingValueForCommand,
  decodeProjectScriptKeybindingRule,
} from "~/lib/projectScriptKeybindings";
import {
  findConflictsForCandidateKeybinding,
  formatKeybindingCommandLabel,
  parseKeybindingShortcutValue,
} from "~/lib/keybindingConflicts";
import { commandForProjectScript, nextProjectScriptId } from "~/projectScripts";
import { formatShortcutLabel } from "~/keybindings";
import { isMacPlatform } from "~/lib/utils";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "./ui/alert-dialog";
import { Button } from "./ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "./ui/dialog";
import { Input } from "./ui/input";
import { Label } from "./ui/label";
import { Popover, PopoverPopup, PopoverTrigger } from "./ui/popover";
import { Switch } from "./ui/switch";
import { Textarea } from "./ui/textarea";

const SCRIPT_ICONS: Array<{ id: ProjectScriptIcon; label: string }> = [
  { id: "play", label: "Play" },
  { id: "test", label: "Test" },
  { id: "lint", label: "Lint" },
  { id: "configure", label: "Configure" },
  { id: "build", label: "Build" },
  { id: "debug", label: "Debug" },
];

export function ScriptIcon({
  icon,
  className = "size-3.5",
}: {
  icon: ProjectScriptIcon;
  className?: string;
}) {
  if (icon === "test") return <FlaskConicalIcon className={className} />;
  if (icon === "lint") return <ListChecksIcon className={className} />;
  if (icon === "configure") return <WrenchIcon className={className} />;
  if (icon === "build") return <HammerIcon className={className} />;
  if (icon === "debug") return <BugIcon className={className} />;
  return <PlayIcon className={className} />;
}

export interface NewProjectScriptInput {
  name: string;
  command: string;
  icon: ProjectScriptIcon;
  runOnWorktreeCreate: boolean;
  runOnWorktreeSettle?: boolean;
  /** False when the agent waits for the setup script to finish. */
  async: boolean;
  keybinding: string | null;
}

interface ProjectScriptDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The action being edited, or null to add a new one. */
  editingScript: ProjectScript | null;
  scripts: ReadonlyArray<ProjectScript>;
  keybindings: ResolvedKeybindingsConfig;
  onAddScript: (input: NewProjectScriptInput) => Promise<void> | void;
  onUpdateScript: (scriptId: string, input: NewProjectScriptInput) => Promise<void> | void;
  onDeleteScript: (scriptId: string) => Promise<void> | void;
}

function normalizeShortcutKeyToken(key: string): string | null {
  const normalized = key.toLowerCase();
  if (
    normalized === "meta" ||
    normalized === "control" ||
    normalized === "ctrl" ||
    normalized === "shift" ||
    normalized === "alt" ||
    normalized === "option"
  ) {
    return null;
  }
  if (normalized === " ") return "space";
  if (normalized === "escape") return "esc";
  if (normalized === "arrowup") return "arrowup";
  if (normalized === "arrowdown") return "arrowdown";
  if (normalized === "arrowleft") return "arrowleft";
  if (normalized === "arrowright") return "arrowright";
  if (normalized.length === 1) return normalized;
  if (normalized.startsWith("f") && normalized.length <= 3) return normalized;
  if (normalized === "enter" || normalized === "tab" || normalized === "backspace") {
    return normalized;
  }
  if (normalized === "delete" || normalized === "home" || normalized === "end") {
    return normalized;
  }
  if (normalized === "pageup" || normalized === "pagedown") return normalized;
  return null;
}

function keybindingFromEvent(event: KeyboardEvent<HTMLInputElement>): string | null {
  const keyToken = normalizeShortcutKeyToken(event.key);
  if (!keyToken) return null;

  const parts: string[] = [];
  if (isMacPlatform(navigator.platform)) {
    if (event.metaKey) parts.push("mod");
    if (event.ctrlKey) parts.push("ctrl");
  } else {
    if (event.ctrlKey) parts.push("mod");
    if (event.metaKey) parts.push("meta");
  }
  if (event.altKey) parts.push("alt");
  if (event.shiftKey) parts.push("shift");
  if (parts.length === 0) {
    return null;
  }
  parts.push(keyToken);
  return parts.join("+");
}

function joinLabels(labels: ReadonlyArray<string>): string {
  if (labels.length <= 1) {
    return labels[0] ?? "";
  }
  if (labels.length === 2) {
    return `${labels[0]} and ${labels[1]}`;
  }
  return `${labels.slice(0, -1).join(", ")}, and ${labels[labels.length - 1]}`;
}

const NEW_SCRIPT_SESSION_KEY = "\u0000new";

/** Add/edit dialog for a project action, plus its delete confirmation. */
export default function ProjectScriptDialog({
  open,
  onOpenChange,
  editingScript,
  scripts,
  keybindings,
  onAddScript,
  onUpdateScript,
  onDeleteScript,
}: ProjectScriptDialogProps) {
  const addScriptFormId = React.useId();
  const [loadedSessionKey, setLoadedSessionKey] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [command, setCommand] = useState("");
  const [icon, setIcon] = useState<ProjectScriptIcon>("play");
  const [iconPickerOpen, setIconPickerOpen] = useState(false);
  const [runOnWorktreeCreate, setRunOnWorktreeCreate] = useState(false);
  const [runOnWorktreeSettle, setRunOnWorktreeSettle] = useState(false);
  const [agentWaits, setAgentWaits] = useState(false);
  const [keybinding, setKeybinding] = useState("");
  const [validationError, setValidationError] = useState<string | null>(null);
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);

  // Load the form when the dialog opens, or when it switches to another action while open.
  const sessionKey = open ? (editingScript?.id ?? NEW_SCRIPT_SESSION_KEY) : null;
  if (sessionKey !== loadedSessionKey) {
    setLoadedSessionKey(sessionKey);
    if (sessionKey !== null) {
      setName(editingScript?.name ?? "");
      setCommand(editingScript?.command ?? "");
      setIcon(editingScript?.icon ?? "play");
      setIconPickerOpen(false);
      setRunOnWorktreeCreate(editingScript?.runOnWorktreeCreate ?? false);
      setRunOnWorktreeSettle(editingScript?.runOnWorktreeSettle ?? false);
      setAgentWaits(editingScript?.async === false);
      setKeybinding(
        editingScript
          ? (keybindingValueForCommand(keybindings, commandForProjectScript(editingScript.id)) ??
              "")
          : "",
      );
      setValidationError(null);
    }
  }

  const editingScriptId = editingScript?.id ?? null;
  const pendingScriptId = useMemo(
    () =>
      editingScriptId ??
      nextProjectScriptId(
        name.trim(),
        scripts.map((script) => script.id),
      ),
    [editingScriptId, name, scripts],
  );
  const pendingScriptCommand = useMemo(
    () => commandForProjectScript(pendingScriptId),
    [pendingScriptId],
  );
  const persistedEditingKeybinding = useMemo(
    () =>
      editingScriptId
        ? keybindingValueForCommand(keybindings, commandForProjectScript(editingScriptId))
        : null,
    [editingScriptId, keybindings],
  );
  const keybindingConflictMessage = useMemo(() => {
    try {
      const keybindingRule = decodeProjectScriptKeybindingRule({
        keybinding,
        command: pendingScriptCommand,
      });
      if (!keybindingRule) {
        return null;
      }
      if (persistedEditingKeybinding === keybindingRule.key) {
        return null;
      }

      const shortcut = parseKeybindingShortcutValue(keybindingRule.key);
      if (!shortcut) {
        return null;
      }

      if (pendingScriptCommand === null) return null;
      const conflicts = findConflictsForCandidateKeybinding(keybindings, {
        command: pendingScriptCommand,
        shortcut,
      });
      if (conflicts.length === 0) {
        return null;
      }

      const labels = [
        ...new Set(
          conflicts.map((binding) => formatKeybindingCommandLabel(binding.command, scripts)),
        ),
      ];
      return `${formatShortcutLabel(shortcut)} conflicts with ${joinLabels(labels)}. Choose a different shortcut or edit keybindings.json manually.`;
    } catch {
      return null;
    }
  }, [keybinding, keybindings, pendingScriptCommand, persistedEditingKeybinding, scripts]);
  const displayedValidationMessage = validationError ?? keybindingConflictMessage;
  const isEditing = editingScriptId !== null;

  const captureKeybinding = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Tab") return;
    event.preventDefault();
    if (event.key === "Backspace" || event.key === "Delete") {
      setKeybinding("");
      setValidationError(null);
      return;
    }
    const next = keybindingFromEvent(event);
    if (!next) return;
    setKeybinding(next);
    setValidationError(null);
  };

  const submitAddScript = useCallback(
    async (event: FormEvent) => {
      event.preventDefault();
      const trimmedName = name.trim();
      const trimmedCommand = command.trim();
      if (trimmedName.length === 0) {
        setValidationError("Name is required.");
        return;
      }
      if (trimmedCommand.length === 0) {
        setValidationError("Command is required.");
        return;
      }
      if (keybindingConflictMessage) {
        setValidationError(keybindingConflictMessage);
        return;
      }

      setValidationError(null);
      try {
        const keybindingRule = decodeProjectScriptKeybindingRule({
          keybinding,
          command: pendingScriptCommand,
        });
        const payload = {
          name: trimmedName,
          command: trimmedCommand,
          icon,
          runOnWorktreeCreate,
          ...(runOnWorktreeSettle ? { runOnWorktreeSettle: true } : {}),
          async: !agentWaits,
          keybinding: keybindingRule?.key ?? null,
        } satisfies NewProjectScriptInput;
        if (editingScriptId) {
          await onUpdateScript(editingScriptId, payload);
        } else {
          await onAddScript(payload);
        }
        onOpenChange(false);
        setIconPickerOpen(false);
      } catch (error) {
        setValidationError(error instanceof Error ? error.message : "Failed to save action.");
      }
    },
    [
      command,
      editingScriptId,
      icon,
      keybinding,
      keybindingConflictMessage,
      name,
      onAddScript,
      onOpenChange,
      onUpdateScript,
      pendingScriptCommand,
      runOnWorktreeCreate,
      runOnWorktreeSettle,
      agentWaits,
    ],
  );

  const confirmDeleteScript = useCallback(() => {
    if (!editingScriptId) return;
    setDeleteConfirmOpen(false);
    onOpenChange(false);
    void onDeleteScript(editingScriptId);
  }, [editingScriptId, onDeleteScript, onOpenChange]);

  return (
    <>
      <Dialog
        onOpenChange={(nextOpen) => {
          onOpenChange(nextOpen);
          if (!nextOpen) {
            setIconPickerOpen(false);
          }
        }}
        open={open}
      >
        <DialogPopup>
          <DialogHeader>
            <DialogTitle>{isEditing ? "Edit Action" : "Add Action"}</DialogTitle>
            <DialogDescription>
              Actions are project-scoped commands you can run from the top bar or keybindings.
            </DialogDescription>
          </DialogHeader>
          <DialogPanel>
            <form id={addScriptFormId} className="space-y-4" onSubmit={submitAddScript}>
              <div className="space-y-1.5">
                <Label htmlFor="script-name">Name</Label>
                <div className="flex items-center gap-2">
                  <Popover onOpenChange={setIconPickerOpen} open={iconPickerOpen}>
                    <PopoverTrigger
                      render={
                        <Button
                          type="button"
                          variant="outline"
                          className="size-9 shrink-0 hover:bg-popover active:bg-popover data-pressed:bg-popover data-pressed:shadow-xs/5 data-pressed:before:shadow-[0_1px_--theme(--color-black/4%)] dark:data-pressed:before:shadow-[0_-1px_--theme(--color-white/6%)]"
                          aria-label="Choose icon"
                        />
                      }
                    >
                      <ScriptIcon icon={icon} className="size-4.5" />
                    </PopoverTrigger>
                    <PopoverPopup align="start">
                      <div className="grid grid-cols-3 gap-2">
                        {SCRIPT_ICONS.map((entry) => {
                          const isSelected = entry.id === icon;
                          return (
                            <button
                              key={entry.id}
                              type="button"
                              className={`relative flex flex-col items-center gap-2 rounded-md border px-2 py-2 text-xs ${
                                isSelected
                                  ? "border-primary/70 bg-primary/10"
                                  : "border-border/70 hover:bg-accent/60"
                              }`}
                              onClick={() => {
                                setIcon(entry.id);
                                setIconPickerOpen(false);
                              }}
                            >
                              <ScriptIcon icon={entry.id} className="size-4" />
                              <span>{entry.label}</span>
                            </button>
                          );
                        })}
                      </div>
                    </PopoverPopup>
                  </Popover>
                  <Input
                    id="script-name"
                    autoFocus
                    placeholder="Test"
                    value={name}
                    onChange={(event) => {
                      setName(event.target.value);
                      setValidationError(null);
                    }}
                  />
                </div>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="script-keybinding">Keybinding</Label>
                <Input
                  id="script-keybinding"
                  placeholder="Press shortcut"
                  value={keybinding}
                  readOnly
                  onKeyDown={captureKeybinding}
                />
                <p className="text-xs text-muted-foreground">
                  Press a shortcut. Use <code>Backspace</code> to clear.
                </p>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="script-command">Command</Label>
                <Textarea
                  id="script-command"
                  placeholder="bun test"
                  value={command}
                  onChange={(event) => {
                    setCommand(event.target.value);
                    setValidationError(null);
                  }}
                />
              </div>
              <label className="flex items-center justify-between gap-3 rounded-md border border-border/70 px-3 py-2 text-sm">
                <span>Run automatically on worktree creation</span>
                <Switch
                  checked={runOnWorktreeCreate}
                  onCheckedChange={(checked) => setRunOnWorktreeCreate(Boolean(checked))}
                />
              </label>
              <label className="flex items-center justify-between gap-3 rounded-md border border-border/70 px-3 py-2 text-sm">
                <span>
                  Run when the worktree thread settles
                  <span className="block text-xs text-muted-foreground">
                    Finishes before automatic cleanup. Off by default.
                  </span>
                </span>
                <Switch
                  aria-label="Run on worktree settlement"
                  checked={runOnWorktreeSettle}
                  onCheckedChange={setRunOnWorktreeSettle}
                />
              </label>
              {runOnWorktreeCreate ? (
                <label className="flex items-center justify-between gap-3 rounded-md border border-border/70 px-3 py-2 text-sm">
                  <span>
                    Agent waits for this script
                    <span className="block text-xs text-muted-foreground">
                      Off: the agent starts while the script keeps running.
                    </span>
                  </span>
                  <Switch
                    aria-label="Agent waits for this script"
                    checked={agentWaits}
                    onCheckedChange={(checked) => setAgentWaits(Boolean(checked))}
                  />
                </label>
              ) : null}
              {displayedValidationMessage ? (
                <p className="text-sm text-destructive">{displayedValidationMessage}</p>
              ) : null}
            </form>
          </DialogPanel>
          <DialogFooter>
            {isEditing && (
              <Button
                type="button"
                variant="destructive-outline"
                className="mr-auto"
                onClick={() => setDeleteConfirmOpen(true)}
              >
                Delete
              </Button>
            )}
            <Button
              type="button"
              variant="outline"
              onClick={() => {
                onOpenChange(false);
              }}
            >
              Cancel
            </Button>
            <Button
              form={addScriptFormId}
              type="submit"
              disabled={Boolean(keybindingConflictMessage)}
            >
              {isEditing ? "Save changes" : "Save action"}
            </Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>

      <AlertDialog open={deleteConfirmOpen} onOpenChange={setDeleteConfirmOpen}>
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete action "{name}"?</AlertDialogTitle>
            <AlertDialogDescription>This action cannot be undone.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline" />}>Cancel</AlertDialogClose>
            <Button variant="destructive" onClick={confirmDeleteScript}>
              Delete action
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </>
  );
}
