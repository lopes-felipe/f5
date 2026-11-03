import { useState } from "react";
import { Input } from "../ui/input";
import { toastManager } from "../ui/toast";

/** Keep partial edits local until editing ends; empty drafts never disable polling. */
export function IntervalSecondsField({
  value,
  min,
  max,
  step,
  disabled,
  label,
  onCommit,
}: {
  value: number;
  min: number;
  max: number;
  step: number;
  disabled: boolean;
  label: string;
  onCommit: (seconds: number) => void | Promise<void>;
}) {
  const [field, setField] = useState({
    saved: value,
    draft: String(value),
    revision: 0,
    submitted: null as { value: number; revision: number } | null,
  });
  if (field.saved !== value) {
    const acknowledged = field.submitted?.value === value;
    const replaceDraft = acknowledged
      ? field.revision === field.submitted?.revision
      : field.draft === String(field.saved);
    setField({
      ...field,
      saved: value,
      draft: replaceDraft ? String(value) : field.draft,
      submitted: acknowledged ? null : field.submitted,
    });
  }
  const commit = async () => {
    const parsed = Number(field.draft);
    if (!field.draft.trim() || !Number.isFinite(parsed)) {
      setField((current) => ({ ...current, draft: String(current.saved) }));
      return;
    }
    const seconds = Math.max(min, Math.min(max, Math.round(parsed)));
    setField((current) => ({ ...current, draft: String(seconds) }));
    if (seconds === value) return;
    const attempt = field.revision + 1;
    setField((current) => ({
      ...current,
      revision: attempt,
      submitted: { value: seconds, revision: attempt },
    }));
    try {
      await onCommit(seconds);
    } catch (error) {
      setField((current) =>
        current.submitted?.revision !== attempt
          ? current
          : {
              ...current,
              submitted: null,
              draft: current.revision === attempt ? String(current.saved) : current.draft,
            },
      );
      toastManager.add({
        type: "error",
        title: "Interval not saved",
        description: error instanceof Error ? error.message : String(error),
      });
    }
  };
  return (
    <Input
      className="h-8 w-20"
      type="number"
      min={min}
      max={max}
      step={step}
      disabled={disabled}
      value={field.draft}
      aria-label={label}
      onChange={(event) => {
        const draft = event.currentTarget.value;
        setField((current) => ({ ...current, draft, revision: current.revision + 1 }));
      }}
      onBlur={() => void commit()}
      onKeyDown={(event) => {
        if (event.key === "Enter") event.currentTarget.blur();
      }}
    />
  );
}
