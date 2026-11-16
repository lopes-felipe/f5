import { type ChangeEvent, type KeyboardEvent, useEffect, useRef, useState } from "react";

import { isKeyboardEventComposing } from "../lib/keyboardComposition";

type TextFieldElement = HTMLInputElement | HTMLTextAreaElement;

export interface CommitOnBlurOptions {
  readonly normalizeDraft?: (previous: string, next: string) => string;
  /** A textarea: Enter inserts a newline instead of committing. */
  readonly multiline?: boolean;
  /** Commit the trimmed draft, and skip the commit when only whitespace changed. */
  readonly trim?: boolean;
  /** Called when `onCommit` rejects; the draft then returns to `value`. */
  readonly onError?: (error: unknown) => void;
}

/**
 * Buffer text input locally so keystrokes don't cause a settings-wide
 * re-render (and optionally a server RPC round-trip) on every character.
 * `onCommit` fires on blur and, for single-line fields, on Enter.
 *
 * The draft resynchronizes from the upstream `value` only when the input
 * is not focused, so an external push (e.g. an optimistic settings
 * update from the user's own commit, or a reset to defaults) doesn't
 * clobber an in-progress edit.
 *
 * Returns a bag of props that should be spread onto an `<Input>` or `<Textarea>`:
 *
 *   const bag = useCommitOnBlur(instance.displayName ?? "", (next) => {...});
 *   <Input {...bag} placeholder="e.g. Work" />
 */
export function useCommitOnBlur(
  value: string,
  onCommit: (next: string) => void | Promise<unknown>,
  options: CommitOnBlurOptions = {},
) {
  const [draft, setDraft] = useState(value);
  const focusedRef = useRef(false);
  const valueOnFocus = useRef(value);
  const valueRef = useRef(value);
  valueRef.current = value;

  useEffect(() => {
    if (!focusedRef.current) {
      setDraft(value);
    }
  }, [value]);

  return {
    value: draft,
    onChange: (event: ChangeEvent<TextFieldElement>) => {
      const next = event.target.value;
      setDraft(options.normalizeDraft ? options.normalizeDraft(draft, next) : next);
    },
    onFocus: () => {
      focusedRef.current = true;
      valueOnFocus.current = draft;
    },
    onBlur: () => {
      focusedRef.current = false;
      const next = options.trim ? draft.trim() : draft;
      const initial = options.trim ? valueOnFocus.current.trim() : valueOnFocus.current;
      if (next === initial || next === value) {
        setDraft(value);
        return;
      }
      if (next !== draft) setDraft(next);
      const result = onCommit(next);
      if (result instanceof Promise) {
        result.catch((error: unknown) => {
          if (!focusedRef.current) setDraft(valueRef.current);
          options.onError?.(error);
        });
      }
    },
    onKeyDown: options.multiline
      ? undefined
      : (event: KeyboardEvent<TextFieldElement>) => {
          if (event.key === "Enter" && !isKeyboardEventComposing(event.nativeEvent)) {
            event.preventDefault();
            (event.target as TextFieldElement).blur();
          }
        },
  };
}
