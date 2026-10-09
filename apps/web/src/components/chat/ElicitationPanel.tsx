import { useState } from "react";
import type {
  ElicitationAction,
  ElicitationField,
  ElicitationValue,
  PendingUserInput,
  ThreadId,
} from "@t3tools/contracts";
import { validateElicitationContent } from "@t3tools/shared/elicitationForm";
import { readNativeApi } from "~/nativeApi";
import { Button } from "../ui/button";
import { COMPOSER_TRAY_PANEL_CLASS_NAME, type ComposerPanelVariant } from "./composer/ComposerTray";

type DraftValue = string | boolean | string[] | undefined;

/** Visible suggestions only: nothing is submitted unless it is shown in the form. */
function initialDraft(fields: ReadonlyArray<ElicitationField>): Record<string, DraftValue> {
  const draft: Record<string, DraftValue> = {};
  for (const field of fields) {
    const suggested = field.suggestedValue;
    if (suggested === undefined) continue;
    draft[field.key] =
      typeof suggested === "number"
        ? String(suggested)
        : (suggested as Exclude<DraftValue, undefined>);
  }
  return draft;
}

/** Builds typed content from what the user sees; empty entries are omitted. */
export function elicitationContentFromDraft(
  fields: ReadonlyArray<ElicitationField>,
  draft: Readonly<Record<string, DraftValue>>,
): Record<string, unknown> {
  const content: Record<string, unknown> = {};
  for (const field of fields) {
    const value = draft[field.key];
    if (value === undefined || value === "") continue;
    if ((field.type === "number" || field.type === "integer") && typeof value === "string") {
      const parsed = Number(value.trim());
      // Keep unparseable text so validation names the field instead of dropping it.
      content[field.key] = value.trim() !== "" && Number.isFinite(parsed) ? parsed : value;
      continue;
    }
    content[field.key] = value;
  }
  return content;
}

function fieldLabel(field: ElicitationField): string {
  return field.required ? `${field.title} *` : field.title;
}

function ChoiceButton(props: {
  selected: boolean;
  disabled: boolean;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      disabled={props.disabled}
      aria-pressed={props.selected}
      className="h-7 rounded-md border border-border px-2 text-ui text-muted-foreground outline-none transition-colors duration-(--duration-fast) hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50 aria-pressed:border-primary/60 aria-pressed:bg-primary/10 aria-pressed:text-foreground"
      onClick={props.onClick}
    >
      {props.label}
    </button>
  );
}

function FieldInput(props: {
  field: ElicitationField;
  value: DraftValue;
  disabled: boolean;
  onChange: (value: DraftValue) => void;
}) {
  const { field, value, disabled, onChange } = props;
  switch (field.type) {
    case "boolean":
      return (
        <div className="flex gap-1.5">
          {([true, false] as const).map((choice) => (
            <ChoiceButton
              key={String(choice)}
              selected={value === choice}
              disabled={disabled}
              label={choice ? "Yes" : "No"}
              onClick={() => onChange(value === choice ? undefined : choice)}
            />
          ))}
        </div>
      );
    case "enum":
      return (
        <div className="flex flex-wrap gap-1.5">
          {field.options?.map((option) => (
            <ChoiceButton
              key={option.value}
              selected={value === option.value}
              disabled={disabled}
              label={option.label}
              onClick={() => onChange(value === option.value ? undefined : option.value)}
            />
          ))}
        </div>
      );
    case "multiselect": {
      const selected = Array.isArray(value) ? value : [];
      return (
        <div className="flex flex-wrap gap-1.5">
          {field.options?.map((option) => (
            <ChoiceButton
              key={option.value}
              selected={selected.includes(option.value)}
              disabled={disabled}
              label={option.label}
              onClick={() =>
                onChange(
                  selected.includes(option.value)
                    ? selected.filter((entry) => entry !== option.value)
                    : [...selected, option.value],
                )
              }
            />
          ))}
        </div>
      );
    }
    default:
      return (
        <input
          aria-label={field.title}
          // Never let the browser remember what a provider asked for.
          autoComplete="off"
          className="h-8 w-full rounded-md border border-input bg-background px-2 text-ui outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/30"
          disabled={disabled}
          inputMode={field.type === "string" ? undefined : "decimal"}
          type={
            field.type === "string"
              ? field.format === "email"
                ? "email"
                : field.format === "date"
                  ? "date"
                  : "text"
              : "text"
          }
          value={typeof value === "string" ? value : ""}
          onChange={(event) => onChange(event.target.value)}
        />
      );
  }
}

/**
 * Provider form/URL request. Values stay in this component's state and go to
 * the server only through the private elicitation RPC: they are never part of
 * drafts, orchestration commands or the thread history.
 */
export function ElicitationPanel({
  threadId,
  input,
  variant = "standalone",
}: {
  threadId: ThreadId;
  input: Pick<PendingUserInput, "requestId" | "elicitation" | "receipt">;
  variant?: ComposerPanelVariant;
}) {
  const descriptor = input.elicitation;
  const fields = descriptor?.fields ?? [];
  const [draft, setDraft] = useState<Record<string, DraftValue>>(() => initialDraft(fields));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!descriptor) return null;

  const send = async (action: ElicitationAction, content?: Record<string, unknown>) => {
    const api = readNativeApi();
    if (!api || busy) return;
    setBusy(true);
    setError(null);
    try {
      await api.elicitation.submit({
        threadId,
        requestId: input.requestId,
        generation: descriptor.generation ?? 0,
        action,
        ...(content ? { content } : {}),
      });
      if (action !== "accept") setDraft({});
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  const submitForm = () => {
    const content = elicitationContentFromDraft(fields, draft);
    const validated = validateElicitationContent(fields, content);
    if (!validated.ok) {
      setError(validated.reason);
      return;
    }
    void send("accept", validated.value as Record<string, ElicitationValue>);
  };

  const openLink = async () => {
    const api = readNativeApi();
    if (!api || !descriptor.url) return;
    try {
      await api.shell.openExternal(descriptor.url);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      return;
    }
    await send("accept");
  };

  const source = descriptor.serverName ? `MCP server “${descriptor.serverName}”` : "The provider";
  const receipt = input.receipt;
  let host: string | undefined;
  try {
    host = descriptor.url ? new URL(descriptor.url).host : undefined;
  } catch {
    host = undefined;
  }

  return (
    <section
      className={
        variant === "tray"
          ? COMPOSER_TRAY_PANEL_CLASS_NAME
          : "mx-auto mb-2 w-full max-w-(--chat-content-max-width) rounded-xl border border-border bg-card p-3"
      }
      aria-label={descriptor.mode === "url" ? "Link request from provider" : "Form from provider"}
    >
      <p className="text-xs text-muted-foreground">
        {source} {descriptor.mode === "url" ? "asks you to open a link" : "asks for input"}
      </p>
      {descriptor.title ? (
        <p className="mt-1 text-ui font-medium text-foreground">{descriptor.title}</p>
      ) : null}
      {descriptor.message ? (
        <p className="mt-1 whitespace-pre-wrap text-ui text-foreground">{descriptor.message}</p>
      ) : null}

      {receipt === "submitted" ? (
        <p role="status" className="mt-2 text-xs text-muted-foreground">
          Sent. Waiting for the provider to confirm.
        </p>
      ) : receipt === "indeterminate" ? (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <p role="alert" className="text-xs text-destructive-foreground">
            F5 lost the provider connection before it confirmed this answer. It will not be sent
            again.
          </p>
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={busy}
            onClick={() => void send("cancel")}
          >
            Dismiss
          </Button>
        </div>
      ) : descriptor.mode === "url" ? (
        <>
          {descriptor.url ? (
            <div className="mt-2 rounded-md border border-border/70 bg-muted/40 p-2 text-xs">
              {host ? <p className="font-medium text-foreground">{host}</p> : null}
              <code className="break-all text-muted-foreground">{descriptor.url}</code>
            </div>
          ) : null}
          <div className="mt-2 flex flex-wrap gap-2">
            <Button type="button" size="sm" disabled={busy} onClick={() => void openLink()}>
              Open link
            </Button>
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={() => void send("decline")}
            >
              Decline
            </Button>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              disabled={busy}
              onClick={() => void send("cancel")}
            >
              Cancel
            </Button>
          </div>
        </>
      ) : (
        <form
          className="mt-2"
          autoComplete="off"
          onSubmit={(event) => {
            event.preventDefault();
            submitForm();
          }}
        >
          {fields.map((field) => (
            <div key={field.key} className="mb-2.5">
              <p className="mb-1 text-xs font-medium text-foreground">{fieldLabel(field)}</p>
              {field.description ? (
                <p className="mb-1 text-xs text-muted-foreground">{field.description}</p>
              ) : null}
              <FieldInput
                field={field}
                value={draft[field.key]}
                disabled={busy}
                onChange={(value) => setDraft((current) => ({ ...current, [field.key]: value }))}
              />
            </div>
          ))}
          <div className="flex flex-wrap gap-2">
            <Button type="submit" size="sm" disabled={busy}>
              Submit
            </Button>
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={() => void send("decline")}
            >
              Decline
            </Button>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              disabled={busy}
              onClick={() => void send("cancel")}
            >
              Cancel
            </Button>
          </div>
        </form>
      )}
      {error ? (
        <p role="alert" className="mt-2 text-xs text-destructive-foreground">
          {error}
        </p>
      ) : null}
    </section>
  );
}
