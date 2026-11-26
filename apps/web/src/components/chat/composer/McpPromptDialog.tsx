import type { McpComposerPrompt, ThreadId } from "@t3tools/contracts";
import { useEffect, useId, useRef, useState } from "react";

import { Button } from "~/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "~/components/ui/dialog";
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
import { ensureNativeApi } from "~/nativeApi";

const COMPLETION_DEBOUNCE_MS = 200;

export interface McpPromptRequest {
  readonly serverName: string;
  readonly prompt: McpComposerPrompt;
}

/**
 * Fills a prompt's arguments, with the server's suggestions where it offers them.
 * The prompt's text goes into the composer for review; nothing is sent from here.
 */
export function McpPromptDialog(props: {
  threadId: ThreadId;
  request: McpPromptRequest | null;
  onOpenChange: (open: boolean) => void;
  /** Fetches the filled prompt into the composer; false keeps the dialog open. */
  onInsert: (values: Record<string, string>) => Promise<boolean>;
}) {
  const request = props.request;
  const [values, setValues] = useState<Record<string, string>>({});
  const [suggestions, setSuggestions] = useState<Record<string, readonly string[]>>({});
  const [submitting, setSubmitting] = useState(false);
  const formId = useId();
  const completionTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const completionSequence = useRef(0);

  // A new prompt starts from an empty form.
  useEffect(() => {
    setValues({});
    setSuggestions({});
    setSubmitting(false);
  }, [request]);
  useEffect(() => () => clearTimeout(completionTimer.current), []);

  const prompt = request?.prompt;
  const missing = prompt?.arguments.some(
    (argument) => argument.required && !values[argument.name]?.trim(),
  );

  const requestCompletion = (argument: string, value: string, filled: Record<string, string>) => {
    if (!request) return;
    clearTimeout(completionTimer.current);
    const sequence = ++completionSequence.current;
    completionTimer.current = setTimeout(() => {
      ensureNativeApi()
        .mcp.completeComposerPrompt({
          threadId: props.threadId,
          serverName: request.serverName,
          name: request.prompt.name,
          argument,
          value,
          arguments: filled,
        })
        .then((result) => {
          if (sequence !== completionSequence.current) return;
          setSuggestions((current) => ({ ...current, [argument]: result.values }));
        })
        // Suggestions are optional; typing still works without them.
        .catch(() => undefined);
    }, COMPLETION_DEBOUNCE_MS);
  };

  const submit = async () => {
    if (!request || missing || submitting) return;
    setSubmitting(true);
    try {
      const filled = Object.fromEntries(
        Object.entries(values).filter(([, value]) => value.trim().length > 0),
      );
      if (await props.onInsert(filled)) props.onOpenChange(false);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={request !== null} onOpenChange={props.onOpenChange}>
      <DialogPopup className="max-w-md">
        <form
          className="contents"
          onSubmit={(event) => {
            event.preventDefault();
            // The popup is portaled, but React still bubbles this submit to the composer form.
            event.stopPropagation();
            void submit();
          }}
        >
          <DialogHeader>
            <DialogTitle className="text-base">
              /{request?.serverName}:{prompt?.name}
            </DialogTitle>
            <DialogDescription>
              {prompt?.description ||
                prompt?.title ||
                "The prompt's text goes into the composer, where you can edit it before sending."}
            </DialogDescription>
          </DialogHeader>
          <DialogPanel className="space-y-4">
            {prompt?.arguments.map((argument) => {
              const inputId = `${formId}-${argument.name}`;
              const listId = `${inputId}-suggestions`;
              const options = suggestions[argument.name] ?? [];
              return (
                <div key={argument.name} className="grid gap-1.5">
                  <Label htmlFor={inputId}>
                    {argument.name}
                    {argument.required ? (
                      <span className="text-muted-foreground"> (required)</span>
                    ) : null}
                  </Label>
                  <Input
                    id={inputId}
                    list={options.length > 0 ? listId : undefined}
                    value={values[argument.name] ?? ""}
                    autoComplete="off"
                    onChange={(event) => {
                      const value = event.currentTarget.value;
                      const next = { ...values, [argument.name]: value };
                      setValues(next);
                      requestCompletion(argument.name, value, next);
                    }}
                    onFocus={() =>
                      requestCompletion(argument.name, values[argument.name] ?? "", values)
                    }
                  />
                  {options.length > 0 ? (
                    <datalist id={listId}>
                      {options.map((option) => (
                        <option key={option} value={option} />
                      ))}
                    </datalist>
                  ) : null}
                  {argument.description ? (
                    <p className="text-muted-foreground text-xs">{argument.description}</p>
                  ) : null}
                </div>
              );
            })}
          </DialogPanel>
          <DialogFooter variant="bare">
            <DialogClose render={<Button type="button" variant="outline" />}>Cancel</DialogClose>
            <Button type="submit" disabled={missing || submitting}>
              {submitting ? "Inserting…" : "Insert prompt"}
            </Button>
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  );
}
