import { cn } from "../lib/utils";

/** Keep the identifying suffix visible while preserving selectable, copyable text. */
export function MiddleTruncate({ text, className }: { text: string; className?: string }) {
  const characters = Array.from(text);
  const lastSegment = Array.from(text.split(/[\\/]/).at(-1) ?? "");
  const tailLength = lastSegment.length > 0 && lastSegment.length <= 16 ? lastSegment.length : 10;
  if (characters.length <= tailLength + 4)
    return <span className={cn("truncate", className)}>{text}</span>;
  return (
    <span className={cn("inline-flex min-w-0 max-w-full", className)} title={text}>
      <span className="truncate">{characters.slice(0, -tailLength).join("")}</span>
      <span className="shrink-0">{characters.slice(-tailLength).join("")}</span>
    </span>
  );
}
