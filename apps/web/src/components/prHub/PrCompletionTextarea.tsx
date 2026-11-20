import { useEffect, useId, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { PullRequestKey } from "@t3tools/contracts";
import { Textarea, type TextareaProps } from "../ui/textarea";
import { ensureNativeApi } from "../../nativeApi";
import { getPrHubAccountGeneration } from "../../lib/prHubAccount";
import { prCompletionTrigger } from "./prCompletionTrigger";

export function PrCompletionTextarea({
  prKey,
  onChange,
  onKeyDown,
  onSelect,
  onBlur,
  onFocus,
  ...props
}: TextareaProps & { prKey: PullRequestKey }) {
  const textarea = useRef<HTMLTextAreaElement>(null);
  const listId = useId();
  const [selection, setSelection] = useState({ start: 0, end: 0 });
  const [focused, setFocused] = useState(false);
  const [dismissed, setDismissed] = useState("");
  const [active, setActive] = useState(0);
  const value = String(props.value ?? "");
  const trigger = prCompletionTrigger(value, selection.start, selection.end);
  const identity = JSON.stringify([prKey, trigger]);
  const [debouncedIdentity, setDebouncedIdentity] = useState("");
  useEffect(() => {
    const timer = setTimeout(() => setDebouncedIdentity(identity), 150);
    return () => clearTimeout(timer);
  }, [identity]);
  const generation = getPrHubAccountGeneration();
  const enabled =
    focused &&
    Boolean(trigger) &&
    Boolean(generation) &&
    dismissed !== identity &&
    debouncedIdentity === identity;
  const query = useQuery({
    queryKey: ["prHub", "completions", generation, prKey, trigger?.sigil, trigger?.query],
    queryFn: () =>
      ensureNativeApi().prHub.completions({
        key: prKey,
        accountGeneration: generation!,
        sigil: trigger!.sigil,
        query: trigger!.query,
      }),
    enabled,
    staleTime: 30_000,
    retry: false,
  });
  const options = enabled ? (query.data ?? []) : [];
  const selected = Math.min(active, Math.max(options.length - 1, 0));
  const updateSelection = (element: HTMLTextAreaElement) => {
    setSelection({ start: element.selectionStart, end: element.selectionEnd });
    setActive(0);
  };
  const insert = (index: number) => {
    const element = textarea.current;
    const option = options[index];
    // Never replace a different selection or a draft that changed during the request.
    if (
      !element ||
      !option ||
      !trigger ||
      element.value !== value ||
      element.selectionStart !== trigger.end ||
      element.selectionEnd !== trigger.end
    )
      return;
    const inserted = option.token + (/\s/.test(value[trigger.end] ?? "") ? "" : " ");
    const next = value.slice(0, trigger.start) + inserted + value.slice(trigger.end);
    // Use the native input setter so React's controlled onChange owns draft persistence.
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(
      element,
      next,
    );
    element.dispatchEvent(new Event("input", { bubbles: true }));
    const caret = trigger.start + inserted.length;
    setDismissed(identity);
    requestAnimationFrame(() => {
      if (document.activeElement === element) {
        element.setSelectionRange(caret, caret);
        updateSelection(element);
      }
    });
  };
  return (
    <div className="relative">
      <Textarea
        {...props}
        ref={textarea}
        aria-expanded={options.length > 0}
        aria-controls={options.length ? listId : undefined}
        aria-activedescendant={options.length ? listId + "-" + selected : undefined}
        onFocus={(event) => {
          setFocused(true);
          updateSelection(event.currentTarget);
          onFocus?.(event);
        }}
        onBlur={(event) => {
          setFocused(false);
          onBlur?.(event);
        }}
        onChange={(event) => {
          updateSelection(event.currentTarget);
          onChange?.(event);
        }}
        onSelect={(event) => {
          updateSelection(event.currentTarget);
          onSelect?.(event);
        }}
        onKeyDown={(event) => {
          if (
            !event.nativeEvent.isComposing &&
            options.length &&
            !event.ctrlKey &&
            !event.metaKey &&
            !event.altKey
          ) {
            if (event.key === "ArrowDown" || event.key === "ArrowUp") {
              event.preventDefault();
              setActive(
                (selected + (event.key === "ArrowDown" ? 1 : options.length - 1)) % options.length,
              );
              return;
            }
            if (event.key === "Enter" || event.key === "Tab") {
              event.preventDefault();
              insert(selected);
              return;
            }
            if (event.key === "Escape") {
              event.preventDefault();
              event.stopPropagation();
              setDismissed(identity);
              return;
            }
          }
          onKeyDown?.(event);
        }}
      />
      {options.length ? (
        <div
          id={listId}
          role="listbox"
          aria-label="PR completions"
          className="absolute bottom-full z-50 mb-1 max-h-60 w-full overflow-auto rounded border border-border bg-popover p-1 shadow-lg"
        >
          {options.map((option, index) => (
            <button
              key={option.token}
              id={listId + "-" + index}
              role="option"
              aria-selected={index === selected}
              type="button"
              tabIndex={-1}
              className={
                "flex w-full gap-2 rounded px-2 py-1 text-left text-sm " +
                (index === selected ? "bg-accent" : "")
              }
              onPointerDown={(event) => event.preventDefault()}
              onClick={() => insert(index)}
            >
              <span>{option.label}</span>
              <span className="truncate text-muted-foreground">{option.detail}</span>
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
