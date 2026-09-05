export const TOKEN_SEGMENTS = [
  { key: "uncachedInputTokens", label: "Uncached input", color: "bg-primary" },
  { key: "outputTokens", label: "Output", color: "bg-info" },
  { key: "cacheReadTokens", label: "Cache read", color: "bg-success" },
  { key: "cacheWriteTokens", label: "Cache write", color: "bg-accent" },
  { key: "unattributedTokens", label: "Unattributed", color: "bg-muted-foreground/40" },
] as const;
export function ChartLegend() {
  return (
    <ul
      className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground"
      aria-label="Token chart legend"
    >
      {TOKEN_SEGMENTS.map((segment) => (
        <li key={segment.key} className="flex items-center gap-1.5">
          <span aria-hidden="true" className={`size-2 rounded-sm ${segment.color}`} />
          {segment.label}
        </li>
      ))}
    </ul>
  );
}
