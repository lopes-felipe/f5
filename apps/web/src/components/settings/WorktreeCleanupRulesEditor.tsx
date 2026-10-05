import type { WorktreeCleanupRules } from "@t3tools/contracts";
import { useEffect, useState } from "react";

import { Input } from "../ui/input";
import { Switch } from "../ui/switch";

export const MAX_RETENTION_DAYS = 3650;

/** Parses a retention field: empty means "never", otherwise 1 to 3650 whole days. */
export function parseRetentionDays(value: string): number | null | "invalid" {
  const trimmed = value.trim();
  if (trimmed === "") return null;
  if (!/^\d+$/.test(trimmed)) return "invalid";
  const days = Number(trimmed);
  return days >= 1 && days <= MAX_RETENTION_DAYS ? days : "invalid";
}

/** A days field that commits on blur or Enter; empty clears it. */
export function RetentionDaysInput(props: {
  readonly label: string;
  readonly value: number | null;
  readonly disabled?: boolean;
  readonly placeholder?: string;
  readonly onCommit: (days: number | null) => void;
}) {
  const [draft, setDraft] = useState(props.value === null ? "" : String(props.value));
  const [invalid, setInvalid] = useState(false);
  useEffect(() => {
    setDraft(props.value === null ? "" : String(props.value));
    setInvalid(false);
  }, [props.value]);
  const commit = () => {
    const parsed = parseRetentionDays(draft);
    if (parsed === "invalid") {
      setInvalid(true);
      return;
    }
    setInvalid(false);
    if (parsed !== props.value) props.onCommit(parsed);
  };
  return (
    <span className="flex items-center gap-2">
      <Input
        aria-label={props.label}
        aria-invalid={invalid || undefined}
        className="w-24"
        inputMode="numeric"
        disabled={props.disabled}
        placeholder={props.placeholder ?? "Never"}
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === "Enter") commit();
        }}
      />
      <span className="text-xs text-muted-foreground">days</span>
    </span>
  );
}

const RULE_TOGGLES = [
  {
    key: "onMerge",
    label: "When the pull request is merged",
    description: "Only once the worktree's commits are in the default branch.",
  },
  {
    key: "onDelete",
    label: "When the thread is deleted",
    description: "Deleted threads keep their branch.",
  },
  {
    key: "unchanged",
    label: "When the branch has no new commits",
    description: "Nothing beyond the default branch was committed.",
  },
] as const;

export function WorktreeCleanupRulesEditor(props: {
  readonly rules: WorktreeCleanupRules;
  readonly disabled?: boolean;
  readonly onChange: (rules: WorktreeCleanupRules) => void;
}) {
  const { rules, disabled } = props;
  return (
    <div className="space-y-1">
      <label className="flex items-center justify-between gap-4 py-2 text-sm">
        <span>
          Remove idle worktrees after
          <span className="block text-xs text-muted-foreground">
            Counted from the thread's last message. Leave empty to keep idle worktrees.
          </span>
        </span>
        <RetentionDaysInput
          label="Remove idle worktrees after"
          value={rules.afterDays}
          disabled={disabled ?? false}
          onCommit={(afterDays) => props.onChange({ ...rules, afterDays })}
        />
      </label>
      {RULE_TOGGLES.map((toggle) => (
        <label key={toggle.key} className="flex items-center justify-between gap-4 py-2 text-sm">
          <span>
            {toggle.label}
            <span className="block text-xs text-muted-foreground">{toggle.description}</span>
          </span>
          <Switch
            aria-label={toggle.label}
            disabled={disabled ?? false}
            checked={rules[toggle.key]}
            onCheckedChange={(checked) => props.onChange({ ...rules, [toggle.key]: checked })}
          />
        </label>
      ))}
    </div>
  );
}
