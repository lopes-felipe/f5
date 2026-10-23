import { useEffect, useId, useRef, useState } from "react";
import {
  CRON_EXPRESSION_MAX_LENGTH,
  CRON_SCHEDULE_FIELDS,
  normalizeCron,
  ScheduleError,
} from "@t3tools/shared/cronSchedule";
import { Button } from "../ui/button";
import { CheckIcon, CopyIcon } from "lucide-react";
import { useCopyToClipboard } from "../../hooks/useCopyToClipboard";

export function inspectCronInput(value: string) {
  try {
    return { cron: normalizeCron(value), error: null };
  } catch (error) {
    return {
      cron: null,
      error: error instanceof ScheduleError ? error : new ScheduleError("Invalid cron expression."),
    };
  }
}

export function CronScheduleEditor(props: {
  value: string;
  onChange: (value: string) => void;
  validation: ReturnType<typeof inspectCronInput>;
}) {
  const inputs = useRef<Array<HTMLInputElement | null>>([]);
  const pendingFocus = useRef<number | null>(null);
  const { copyToClipboard, isCopied } = useCopyToClipboard();
  const [pasteError, setPasteError] = useState<string | null>(null);
  const id = useId();
  // Preserve empty sections while editing: an empty minute must not shift the hour left.
  const values = props.value.split(" ");
  const oneShot = values.length === 7;
  const fields = oneShot
    ? [
        { label: "Second", range: "0 for a one-shot schedule" },
        ...CRON_SCHEDULE_FIELDS,
        { label: "Year", range: "a four-digit year" },
      ]
    : CRON_SCHEDULE_FIELDS;
  const error = props.validation.error;
  useEffect(() => {
    const index = pendingFocus.current;
    if (index === null) return;
    pendingFocus.current = null;
    inputs.current[index]?.focus();
    inputs.current[index]?.select();
  }, [props.value]);
  return (
    <div className="space-y-2" role="group" aria-label="Cron expression">
      <div className="flex items-center gap-2 rounded-lg border border-input bg-background px-3 py-3 focus-within:border-ring focus-within:ring-2 focus-within:ring-ring/20 has-aria-invalid:border-destructive">
        <div className="min-w-0 flex-1 overflow-x-auto">
          <div className="flex w-max min-w-full items-center justify-center gap-1">
            {fields.map((field, index) => {
              const otherLength = values.reduce(
                (total, value, i) => total + (i === index ? 0 : value.length),
                fields.length - 1,
              );
              const maxLength = Math.max(0, CRON_EXPRESSION_MAX_LENGTH - otherLength);
              return (
                <input
                  key={field.label}
                  type="text"
                  ref={(input) => {
                    inputs.current[index] = input;
                  }}
                  aria-label={field.label}
                  aria-invalid={
                    !!error && (error.fieldIndex === undefined || error.fieldIndex === index)
                  }
                  aria-describedby={`${id}-help${error || pasteError ? ` ${id}-error` : ""}`}
                  className="h-12 min-w-9 shrink-0 rounded-sm border-0 bg-transparent px-1 text-center font-mono text-2xl text-foreground outline-none focus:bg-primary/10 aria-invalid:text-destructive"
                  style={{
                    width: `${Math.min(16, Math.max(2, (values[index]?.length ?? 1) + 1))}ch`,
                  }}
                  value={values[index] ?? ""}
                  title={`${field.label}: ${field.range}`}
                  maxLength={maxLength}
                  placeholder="*"
                  spellCheck={false}
                  autoComplete="off"
                  onFocus={(e) => {
                    e.currentTarget.select();
                  }}
                  onChange={(e) => {
                    if (/\s/.test(e.target.value)) return;
                    const next = Array.from({ length: fields.length }, (_, i) =>
                      i === index ? e.target.value : (values[i] ?? ""),
                    );
                    setPasteError(null);
                    props.onChange(next.join(" "));
                  }}
                  onPaste={(e) => {
                    const text = e.clipboardData.getData("text").trim();
                    const expression = /\s/.test(text) || text.startsWith("@");
                    if (text.length > (expression ? CRON_EXPRESSION_MAX_LENGTH : maxLength)) {
                      e.preventDefault();
                      setPasteError("The pasted value is too long. Shorten it before pasting.");
                      return;
                    }
                    setPasteError(null);
                    if (!expression) return;
                    e.preventDefault();
                    let next = text.replace(/\s+/g, " ");
                    try {
                      next = normalizeCron(next);
                    } catch {
                      // Distribute invalid five/seven-field input too, so errors can identify its field.
                    }
                    const tokens = next.split(" ");
                    if (tokens.length !== 5 && tokens.length !== 7) {
                      setPasteError(
                        "Paste five cron fields, or seven fields for a one-shot schedule.",
                      );
                      return;
                    }
                    if (next === props.value) {
                      e.currentTarget.select();
                      return;
                    }
                    pendingFocus.current = Math.min(index, tokens.length - 1);
                    props.onChange(next);
                  }}
                />
              );
            })}
          </div>
        </div>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={isCopied ? "Cron expression copied" : "Copy cron expression"}
          title={isCopied ? "Copied" : "Copy cron expression"}
          disabled={!!error}
          onClick={() => copyToClipboard(props.validation.cron ?? props.value, undefined)}
        >
          {isCopied ? <CheckIcon /> : <CopyIcon />}
        </Button>
      </div>
      <p id={`${id}-help`} className="sr-only">
        Use Tab to move between cron fields. Paste a complete cron expression into any field.
      </p>
      {(pasteError || error) && (
        <p id={`${id}-error`} role="alert" className="text-sm text-destructive">
          {pasteError ?? error?.message}
        </p>
      )}
    </div>
  );
}
