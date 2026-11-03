"use client";

import { useCommitOnBlur } from "~/hooks/useCommitOnBlur";
import { Input, type InputProps } from "./input";

export type DraftInputProps = Omit<InputProps, "value" | "onChange" | "defaultValue"> & {
  readonly value: string;
  readonly onCommit: (next: string) => void;
  readonly normalizeDraft?: (previous: string, next: string) => string;
};

/**
 * Text `<Input>` that buffers keystrokes locally and invokes `onCommit`
 * only when the user finishes editing (blur or Enter). Prevents each
 * keystroke from triggering a settings-wide re-render or a server RPC
 * round-trip, which otherwise makes fields backed by a server-hydrated
 * value feel laggy.
 */
export function DraftInput({ value, onCommit, normalizeDraft, ...rest }: DraftInputProps) {
  const bag = useCommitOnBlur(value, onCommit, normalizeDraft ? { normalizeDraft } : {});
  return <Input {...rest} {...bag} />;
}
