import { useCallback, useRef, useState } from "react";

import { isKeyboardEventComposing } from "~/lib/keyboardComposition";

export interface InlineTitleEditorProps {
  readonly initialValue: string;
  readonly onCommit: (nextValue: string) => void;
  readonly onCancel: () => void;
  readonly className?: string;
  readonly ariaLabel?: string;
}

export function InlineTitleEditor({
  initialValue,
  onCommit,
  onCancel,
  className,
  ariaLabel,
}: InlineTitleEditorProps) {
  const [value, setValue] = useState(initialValue);
  const committedRef = useRef(false);
  const compositionFallbackRef = useRef(false);
  const onCommitRef = useRef(onCommit);
  onCommitRef.current = onCommit;

  const handleRef = useCallback((element: HTMLInputElement | null) => {
    if (!element) return;
    element.focus();
    element.select();
  }, []);

  return (
    <input
      ref={handleRef}
      aria-label={ariaLabel}
      className={
        className ??
        "min-w-0 flex-1 truncate rounded border border-ring bg-transparent px-0.5 text-base outline-none sm:text-xs"
      }
      value={value}
      onChange={(event) => setValue(event.target.value)}
      onCompositionStart={() => {
        compositionFallbackRef.current = true;
      }}
      onCompositionEnd={() => {
        compositionFallbackRef.current = false;
      }}
      onKeyDown={(event) => {
        event.stopPropagation();
        if (
          event.key === "Enter" &&
          isKeyboardEventComposing(event.nativeEvent, compositionFallbackRef.current)
        ) {
          return;
        }
        if (event.key === "Enter") {
          event.preventDefault();
          if (committedRef.current) return;
          committedRef.current = true;
          onCommitRef.current(value);
        } else if (event.key === "Escape") {
          event.preventDefault();
          if (committedRef.current) return;
          committedRef.current = true;
          onCancel();
        }
      }}
      onBlur={() => {
        if (committedRef.current) return;
        committedRef.current = true;
        if (value.trim().length === 0) {
          onCancel();
          return;
        }
        onCommitRef.current(value);
      }}
      onClick={(event) => event.stopPropagation()}
      onDoubleClick={(event) => event.stopPropagation()}
    />
  );
}
