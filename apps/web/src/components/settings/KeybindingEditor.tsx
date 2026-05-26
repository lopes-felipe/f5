import {
  MAX_KEYBINDING_WHEN_LENGTH,
  STATIC_KEYBINDING_COMMANDS,
  type KeybindingCommand,
  type KeybindingRule,
  type ProjectScript,
  type ResolvedKeybindingRule,
  type ServerKeybindingMutationResult,
} from "@t3tools/contracts";
import {
  DEFAULT_KEYBINDINGS,
  compileResolvedKeybindingRule,
  encodeKeybindingShortcut,
  encodeWhenAst,
  formatShortcutLabel,
  parseKeybindingShortcut,
  parseWhenAst,
  shortcutSignature,
} from "@t3tools/shared/keybindings";
import { Edit2Icon, PlusIcon, RotateCcwIcon, SearchIcon, Trash2Icon } from "lucide-react";
import { useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";

import { ensureNativeApi } from "../../nativeApi";
import { serverQueryKeys } from "../../lib/serverReactQuery";
import { cn } from "../../lib/utils";
import { formatKeybindingCommandLabel } from "../../lib/keybindingConflicts";
import { Button } from "../ui/button";
import { Badge } from "../ui/badge";
import { Input } from "../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { useSettingsRouteContext } from "./SettingsRouteContext";

interface KeybindingRow {
  readonly id: string;
  readonly binding: ResolvedKeybindingRule;
  readonly command: KeybindingCommand;
  readonly key: string;
  readonly when: string;
  readonly target: KeybindingRule | null;
  readonly source: "custom" | "default";
  readonly hasConflict: boolean;
}

interface DraftRule {
  readonly command: KeybindingCommand;
  readonly key: string;
  readonly when: string;
}

const EMPTY_DRAFT: DraftRule = {
  command: "commandPalette.toggle",
  key: "",
  when: "",
};

function resolvedWhenExpression(binding: ResolvedKeybindingRule): string {
  return binding.whenAst ? encodeWhenAst(binding.whenAst) : "";
}

function resolvedMatchesRule(binding: ResolvedKeybindingRule, rule: KeybindingRule): boolean {
  const compiled = compileResolvedKeybindingRule(rule);
  if (!compiled || compiled.command !== binding.command) {
    return false;
  }
  return (
    shortcutSignature(compiled.shortcut) === shortcutSignature(binding.shortcut) &&
    resolvedWhenExpression(compiled) === resolvedWhenExpression(binding)
  );
}

function resolvedIdentity(binding: ResolvedKeybindingRule): string {
  return `${binding.command}\u0000${shortcutSignature(binding.shortcut)}\u0000${resolvedWhenExpression(
    binding,
  )}`;
}

function keybindingRuleFromResolved(binding: ResolvedKeybindingRule): KeybindingRule {
  const encoded = encodeKeybindingShortcut(binding.shortcut) ?? binding.shortcut.key;
  const when = binding.whenAst ? encodeWhenAst(binding.whenAst) : undefined;
  return {
    key: encoded,
    command: binding.command,
    ...(when !== undefined ? { when } : {}),
  };
}

function uniqueCommands(
  projectScripts: ReadonlyArray<ProjectScript>,
): ReadonlyArray<KeybindingCommand> {
  const commands = new Set<KeybindingCommand>(STATIC_KEYBINDING_COMMANDS);
  for (const script of projectScripts) {
    commands.add(`script.${script.id}.run` as KeybindingCommand);
  }
  return [...commands].toSorted((left, right) =>
    formatKeybindingCommandLabel(left, projectScripts).localeCompare(
      formatKeybindingCommandLabel(right, projectScripts),
    ),
  );
}

function validateDraftRule(draft: DraftRule): { rule: KeybindingRule } | { error: string } {
  const key = draft.key.trim();
  if (!key || !parseKeybindingShortcut(key)) {
    return { error: "Enter a valid shortcut such as mod+k or ctrl+shift+p." };
  }

  const when = draft.when.trim();
  if (when.length > MAX_KEYBINDING_WHEN_LENGTH) {
    return { error: `When expressions must be ${MAX_KEYBINDING_WHEN_LENGTH} characters or less.` };
  }
  if (when && !parseWhenAst(when)) {
    return { error: "Use variables with !, &&, ||, and parentheses." };
  }

  return {
    rule: {
      key,
      command: draft.command,
      ...(when ? { when } : {}),
    },
  };
}

function applyKeybindingMutationResult(
  queryClient: ReturnType<typeof useQueryClient>,
  result: ServerKeybindingMutationResult,
) {
  queryClient.setQueryData(serverQueryKeys.config(), (previous) =>
    previous
      ? {
          ...previous,
          keybindings: result.keybindings,
          customKeybindings: result.customKeybindings,
          issues: result.issues,
        }
      : previous,
  );
}

export function KeybindingEditor() {
  const { keybindings, customKeybindings, keybindingConflicts, projects } =
    useSettingsRouteContext();
  const queryClient = useQueryClient();
  const projectScripts = useMemo(() => projects.flatMap((project) => project.scripts), [projects]);
  const commandOptions = useMemo(() => uniqueCommands(projectScripts), [projectScripts]);
  const conflictIds = useMemo(() => {
    const ids = new Set<string>();
    for (const conflict of keybindingConflicts) {
      ids.add(resolvedIdentity(conflict.shadowed));
      ids.add(resolvedIdentity(conflict.winner));
    }
    return ids;
  }, [keybindingConflicts]);
  const [searchQuery, setSearchQuery] = useState("");
  const [editingTarget, setEditingTarget] = useState<KeybindingRule | null>(null);
  const [editingDefaultRow, setEditingDefaultRow] = useState(false);
  const [draftRule, setDraftRule] = useState<DraftRule | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [isMutating, setIsMutating] = useState(false);

  const rows = useMemo(() => {
    const normalizedQuery = searchQuery.trim().toLowerCase();
    const builtRows = keybindings.map((binding, index): KeybindingRow => {
      const customTarget =
        customKeybindings.find((rule) => resolvedMatchesRule(binding, rule)) ?? null;
      const defaultRule = DEFAULT_KEYBINDINGS.find((rule) => resolvedMatchesRule(binding, rule));
      const sourceRule = customTarget ?? defaultRule ?? keybindingRuleFromResolved(binding);
      const row: KeybindingRow = {
        id: `${resolvedIdentity(binding)}\u0000${index}`,
        binding,
        command: binding.command,
        key: sourceRule.key,
        when: sourceRule.when ?? "",
        target: customTarget,
        source: customTarget ? "custom" : "default",
        hasConflict: conflictIds.has(resolvedIdentity(binding)),
      };
      return row;
    });

    builtRows.sort((left, right) => {
      const labelCompare = formatKeybindingCommandLabel(left.command, projectScripts).localeCompare(
        formatKeybindingCommandLabel(right.command, projectScripts),
      );
      if (labelCompare !== 0) return labelCompare;
      return left.key.localeCompare(right.key);
    });

    if (!normalizedQuery) {
      return builtRows;
    }

    return builtRows.filter((row) => {
      const label = formatKeybindingCommandLabel(row.command, projectScripts).toLowerCase();
      return (
        row.command.toLowerCase().includes(normalizedQuery) ||
        label.includes(normalizedQuery) ||
        row.key.toLowerCase().includes(normalizedQuery) ||
        formatShortcutLabel(row.binding.shortcut).toLowerCase().includes(normalizedQuery) ||
        row.when.toLowerCase().includes(normalizedQuery)
      );
    });
  }, [conflictIds, customKeybindings, keybindings, projectScripts, searchQuery]);

  const beginAdd = () => {
    setEditingTarget(null);
    setEditingDefaultRow(false);
    setDraftRule(EMPTY_DRAFT);
    setSubmitError(null);
  };

  const beginEdit = (row: KeybindingRow) => {
    setEditingTarget(row.target);
    setEditingDefaultRow(row.target === null);
    setDraftRule({
      command: row.command,
      key: row.key,
      when: row.when,
    });
    setSubmitError(null);
  };

  const submitDraft = async () => {
    if (!draftRule) return;
    const validation = validateDraftRule(draftRule);
    if ("error" in validation) {
      setSubmitError(validation.error);
      return;
    }

    setSubmitError(null);
    setIsMutating(true);
    try {
      const api = ensureNativeApi();
      const result = editingTarget
        ? await api.server.updateKeybinding({ target: editingTarget, rule: validation.rule })
        : await api.server.addKeybinding({ rule: validation.rule });
      applyKeybindingMutationResult(queryClient, result);
      setDraftRule(null);
      setEditingTarget(null);
      setEditingDefaultRow(false);
    } catch (error) {
      setSubmitError(error instanceof Error ? error.message : "Failed to save keybinding.");
    } finally {
      setIsMutating(false);
    }
  };

  const removeRule = async (target: KeybindingRule) => {
    setSubmitError(null);
    setIsMutating(true);
    try {
      const result = await ensureNativeApi().server.removeKeybinding({ target });
      applyKeybindingMutationResult(queryClient, result);
      if (
        editingTarget &&
        editingTarget.command === target.command &&
        editingTarget.key === target.key &&
        (editingTarget.when ?? "") === (target.when ?? "")
      ) {
        setDraftRule(null);
        setEditingTarget(null);
        setEditingDefaultRow(false);
      }
    } catch (error) {
      setSubmitError(error instanceof Error ? error.message : "Failed to remove keybinding.");
    } finally {
      setIsMutating(false);
    }
  };

  const resetKeybindings = async () => {
    if (typeof window.confirm === "function" && !window.confirm("Reset all custom keybindings?")) {
      return;
    }
    setSubmitError(null);
    setIsMutating(true);
    try {
      const result = await ensureNativeApi().server.resetKeybindings();
      applyKeybindingMutationResult(queryClient, result);
      setDraftRule(null);
      setEditingTarget(null);
      setEditingDefaultRow(false);
    } catch (error) {
      setSubmitError(error instanceof Error ? error.message : "Failed to reset keybindings.");
    } finally {
      setIsMutating(false);
    }
  };

  return (
    <div className="space-y-3" data-keybinding-editor="true">
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-56 flex-1">
          <SearchIcon className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            type="search"
            size="sm"
            className="rounded-lg [&_[data-slot=input]]:pl-8"
            value={searchQuery}
            onChange={(event) => setSearchQuery(event.currentTarget.value)}
            placeholder="Search keybindings"
            aria-label="Search keybindings"
          />
        </div>
        <Button type="button" size="xs" variant="outline" onClick={beginAdd}>
          <PlusIcon className="size-3" />
          Add
        </Button>
        <Button
          type="button"
          size="xs"
          variant="outline"
          onClick={resetKeybindings}
          disabled={isMutating || customKeybindings.length === 0}
        >
          <RotateCcwIcon className="size-3" />
          Reset all
        </Button>
      </div>

      {draftRule ? (
        <div className="space-y-3 rounded-lg border border-border bg-background px-3 py-3">
          <div className="grid gap-3 md:grid-cols-[minmax(0,1.3fr)_minmax(0,0.8fr)_minmax(0,1fr)]">
            <label className="space-y-1.5">
              <span className="text-xs font-medium text-foreground">Command</span>
              <Select
                value={draftRule.command}
                onValueChange={(value) =>
                  setDraftRule((current) =>
                    current ? { ...current, command: value as KeybindingCommand } : current,
                  )
                }
                disabled={editingDefaultRow}
              >
                <SelectTrigger aria-label="Keybinding command">
                  <SelectValue>
                    {formatKeybindingCommandLabel(draftRule.command, projectScripts)}
                  </SelectValue>
                </SelectTrigger>
                <SelectPopup align="start">
                  {commandOptions.map((command) => (
                    <SelectItem key={command} value={command}>
                      {formatKeybindingCommandLabel(command, projectScripts)}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
            </label>
            <label className="space-y-1.5">
              <span className="text-xs font-medium text-foreground">Shortcut</span>
              <Input
                size="sm"
                value={draftRule.key}
                onChange={(event) =>
                  setDraftRule((current) =>
                    current ? { ...current, key: event.currentTarget.value } : current,
                  )
                }
                placeholder="mod+k"
                aria-label="Shortcut"
              />
              <p className="text-[11px] text-muted-foreground/70">
                Use mod for Cmd on macOS and Ctrl elsewhere.
              </p>
            </label>
            <label className="space-y-1.5">
              <span className="text-xs font-medium text-foreground">When</span>
              <Input
                size="sm"
                value={draftRule.when}
                maxLength={MAX_KEYBINDING_WHEN_LENGTH}
                onChange={(event) =>
                  setDraftRule((current) =>
                    current ? { ...current, when: event.currentTarget.value } : current,
                  )
                }
                placeholder="!terminalFocus"
                aria-label="When expression"
              />
            </label>
          </div>
          {submitError ? <p className="text-xs text-destructive">{submitError}</p> : null}
          <div className="flex justify-end gap-2">
            <Button
              type="button"
              size="xs"
              variant="ghost"
              onClick={() => {
                setDraftRule(null);
                setEditingTarget(null);
                setEditingDefaultRow(false);
                setSubmitError(null);
              }}
              disabled={isMutating}
            >
              Cancel
            </Button>
            <Button type="button" size="xs" onClick={submitDraft} disabled={isMutating}>
              {editingTarget || editingDefaultRow ? "Save" : "Add keybinding"}
            </Button>
          </div>
        </div>
      ) : null}

      {submitError && !draftRule ? <p className="text-xs text-destructive">{submitError}</p> : null}

      <div className="overflow-hidden rounded-lg border border-border">
        {rows.length === 0 ? (
          <p className="bg-background px-3 py-3 text-xs text-muted-foreground">
            {searchQuery.trim()
              ? "No keybindings match the current search."
              : "No keybindings available."}
          </p>
        ) : (
          <div className="divide-y divide-border">
            {rows.map((row) => (
              <div
                key={row.id}
                className="grid gap-2 bg-background px-3 py-2 md:grid-cols-[minmax(0,1.2fr)_minmax(0,0.8fr)_minmax(0,0.8fr)_auto]"
              >
                <div className="min-w-0">
                  <div className="flex min-w-0 items-center gap-2">
                    <p className="truncate text-sm font-medium text-foreground">
                      {formatKeybindingCommandLabel(row.command, projectScripts)}
                    </p>
                    <Badge variant={row.source === "custom" ? "info" : "outline"} size="sm">
                      {row.source === "custom" ? "Custom" : "Default"}
                    </Badge>
                    {row.hasConflict ? (
                      <Badge variant="warning" size="sm">
                        Conflict
                      </Badge>
                    ) : null}
                  </div>
                  <p className="mt-0.5 truncate font-mono text-[11px] text-muted-foreground">
                    {row.command}
                  </p>
                </div>
                <div className="flex items-center">
                  <code className="rounded-sm border border-border bg-card px-1.5 py-0.5 text-xs text-foreground">
                    {formatShortcutLabel(row.binding.shortcut)}
                  </code>
                </div>
                <p
                  className={cn(
                    "truncate self-center font-mono text-[11px]",
                    row.when ? "text-muted-foreground" : "text-muted-foreground/50",
                  )}
                  title={row.when || "Always"}
                >
                  {row.when || "Always"}
                </p>
                <div className="flex items-center justify-end gap-1">
                  <Button
                    type="button"
                    size="icon-xs"
                    variant="ghost"
                    aria-label={`Edit ${formatKeybindingCommandLabel(row.command, projectScripts)}`}
                    onClick={() => beginEdit(row)}
                    disabled={isMutating}
                  >
                    <Edit2Icon className="size-3" />
                  </Button>
                  {row.target ? (
                    <Button
                      type="button"
                      size="icon-xs"
                      variant="ghost"
                      aria-label={`Remove ${formatKeybindingCommandLabel(
                        row.command,
                        projectScripts,
                      )}`}
                      onClick={() => void removeRule(row.target!)}
                      disabled={isMutating}
                    >
                      <Trash2Icon className="size-3" />
                    </Button>
                  ) : null}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
