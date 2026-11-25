import { cn } from "../lib/utils";

/**
 * Number of trailing characters to keep: by default the last path segment when it
 * is 16 characters or fewer, else 10. With `maxTailLength`, the separator and the
 * whole last segment (plus any trailing separators), capped at that length.
 */
function tailLengthFor(characters: ReadonlyArray<string>, maxTailLength?: number): number {
  const text = characters.join("");
  if (maxTailLength === undefined || maxTailLength <= 0) {
    const lastSegment = Array.from(text.split(/[\\/]/).at(-1) ?? "");
    return lastSegment.length > 0 && lastSegment.length <= 16 ? lastSegment.length : 10;
  }
  const trimmed = text.replace(/[\\/]+$/, "");
  const segments = trimmed.split(/[\\/]/);
  const lastSegment = Array.from(segments.at(-1) ?? "");
  const separator = segments.length > 1 ? 1 : 0;
  const trailing = characters.length - Array.from(trimmed).length;
  return Math.min(lastSegment.length + separator + trailing, maxTailLength);
}

/** Keep the identifying suffix visible while preserving selectable, copyable text. */
export function MiddleTruncate({
  text,
  className,
  maxTailLength,
}: {
  text: string;
  className?: string;
  /** Keep "/<last segment>" whole at the end, up to this many characters. */
  maxTailLength?: number;
}) {
  const characters = Array.from(text);
  const tailLength = tailLengthFor(characters, maxTailLength);
  if (characters.length <= tailLength + 4)
    return <span className={cn("truncate", className)}>{text}</span>;
  return (
    <span className={cn("inline-flex min-w-0 max-w-full", className)} title={text}>
      <span data-slot="middle-truncate-head" className="truncate">
        {characters.slice(0, -tailLength).join("")}
      </span>
      {/* The head shrinks to nothing first; only then does the tail clip, at its end. */}
      <span data-slot="middle-truncate-tail" className="max-w-full shrink-0 truncate">
        {characters.slice(-tailLength).join("")}
      </span>
    </span>
  );
}
