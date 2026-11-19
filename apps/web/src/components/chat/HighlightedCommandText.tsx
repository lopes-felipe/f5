import { memo } from "react";
import { tokenizeDisplayCommand, type DisplayCommandTokenKind } from "../../lib/commandExecutions";

const TOKEN_CLASSES: Record<DisplayCommandTokenKind, string> = {
  command: "text-info-foreground",
  env: "text-attention-foreground",
  flag: "text-warning-foreground",
  number: "text-warning-foreground",
  operator: "text-muted-foreground",
  path: "text-success-foreground",
  string: "text-success-foreground",
  substitution: "text-attention-foreground",
  text: "text-foreground",
  variable: "text-destructive-foreground",
  whitespace: "text-inherit",
};
const MAX_HIGHLIGHT_CHARS = 16 * 1024;

/** Lightweight fallback. Bound token spans even for enormous tool commands. */
export const HighlightedCommandText = memo(function HighlightedCommandText({
  command,
}: {
  command: string;
}) {
  const tokens = tokenizeDisplayCommand(command.slice(0, MAX_HIGHLIGHT_CHARS));
  let offset = 0;
  return (
    <>
      {tokens.map((token) => {
        const start = offset;
        offset += token.text.length;
        return (
          <span key={start} className={TOKEN_CLASSES[token.kind]}>
            {token.text}
          </span>
        );
      })}
      {command.slice(MAX_HIGHLIGHT_CHARS)}
    </>
  );
});
