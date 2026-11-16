import { MAX_WORKTREE_CLEANUP_MIN_IDLE_HOURS, type WorktreeCleanupRules } from "@t3tools/contracts";
import { useEffect, useState } from "react";

import { Input } from "../ui/input";
import { Switch } from "../ui/switch";

export const MAX_RETENTION_DAYS = 3650;

/** Parses a retention field: empty means "never", otherwise 1 to 3650 whole days. */
export function parseRetentionDays(
  value: string,
  maxDays = MAX_RETENTION_DAYS,
): number | null | "invalid" {
  const trimmed = value.trim();
  if (trimmed === "") return null;
  if (!/^\d+$/.test(trimmed)) return "invalid";
  const days = Number(trimmed);
  return days >= 1 && days <= maxDays ? days : "invalid";
}

/** Parses the content rules' wait: required, 1 to 720 whole hours. */
export function parseMinIdleHours(value: string): number | "invalid" {
  const trimmed = value.trim();
  if (!/^\d+$/.test(trimmed)) return "invalid";
  const hours = Number(trimmed);
  return hours >= 1 && hours <= MAX_WORKTREE_CLEANUP_MIN_IDLE_HOURS ? hours : "invalid";
}

/** A whole-number field that commits on blur or Enter and marks values `parse` rejects. */
function CommittedNumberInput<T extends number | null>(props: {
  readonly label: string;
  readonly value: T;
  readonly unit: string;
  readonly parse: (value: string) => T | "invalid";
  readonly disabled?: boolean;
  readonly placeholder?: string;
  readonly onCommit: (value: T) => void;
}) {
  const [draft, setDraft] = useState(props.value === null ? "" : String(props.value));
  const [invalid, setInvalid] = useState(false);
  useEffect(() => {
    setDraft(props.value === null ? "" : String(props.value));
    setInvalid(false);
  }, [props.value]);
  const commit = () => {
    const parsed = props.parse(draft);
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
        placeholder={props.placeholder}
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === "Enter") commit();
        }}
      />
      <span className="text-xs text-muted-foreground">{props.unit}</span>
    </span>
  );
}

/** A days field that commits on blur or Enter; empty clears it. */
export function RetentionDaysInput(props: {
  readonly label: string;
  readonly maxDays?: number;
  readonly value: number | null;
  readonly disabled?: boolean;
  readonly placeholder?: string;
  readonly onCommit: (days: number | null) => void;
}) {
  const { maxDays, ...rest } = props;
  return (
    <CommittedNumberInput
      {...rest}
      unit="days"
      parse={(value) => parseRetentionDays(value, maxDays)}
      placeholder={props.placeholder ?? "Never"}
    />
  );
}

const RULE_TOGGLES = [
  {
    key: "onSettle",
    label: "When the thread is settled",
    description:
      "Run enabled settlement scripts first and retain the existing cleanup safety checks.",
  },
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
            checked={rules[toggle.key] ?? false}
            onCheckedChange={(checked) => props.onChange({ ...rules, [toggle.key]: checked })}
          />
        </label>
      ))}
      <label className="flex items-center justify-between gap-4 py-2 text-sm">
        <span>
          Wait before removing unchanged or merged worktrees
          <span className="block text-xs text-muted-foreground">
            Hours since any thread using the worktree was last active. Keeps worktrees you are still
            using.
          </span>
        </span>
        <CommittedNumberInput
          label="Wait before removing unchanged or merged worktrees"
          value={rules.minIdleHours}
          unit="hours"
          parse={parseMinIdleHours}
          // Only the merged and no-new-commits rules wait.
          disabled={(disabled ?? false) || (!rules.unchanged && !rules.onMerge)}
          onCommit={(minIdleHours) => props.onChange({ ...rules, minIdleHours })}
        />
      </label>
    </div>
  );
}
