import { useRef, useState } from "react";
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
  const [field, setField] = useState({ saved: value, draft: String(value) });
  const revision = useRef(0);
  if (field.saved !== value) {
    revision.current++;
    setField({ saved: value, draft: String(value) });
  }
  const commit = async () => {
    const parsed = Number(field.draft);
    if (!field.draft.trim() || !Number.isFinite(parsed)) {
      setField({ saved: value, draft: String(value) });
      return;
    }
    const seconds = Math.max(min, Math.min(max, Math.round(parsed)));
    setField((current) => ({ ...current, draft: String(seconds) }));
    if (seconds === value) return;
    const attempt = ++revision.current;
    try {
      await onCommit(seconds);
    } catch (error) {
      if (revision.current === attempt) {
        setField((current) => ({ ...current, draft: String(current.saved) }));
      }
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
        revision.current++;
        setField((current) => ({ ...current, draft }));
      }}
      onBlur={() => void commit()}
      onKeyDown={(event) => {
        if (event.key === "Enter") event.currentTarget.blur();
      }}
    />
  );
}
