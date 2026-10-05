import { type ProviderKind } from "@t3tools/contracts";
import { memo } from "react";

interface ProviderRuntimeInfoEntry {
  readonly label: string;
  readonly value: string;
}

export const ProviderRuntimeInfoBanner = memo(function ProviderRuntimeInfoBanner({
  provider,
  entries,
}: {
  provider: ProviderKind | null;
  entries: ReadonlyArray<ProviderRuntimeInfoEntry>;
}) {
  if (!provider || entries.length === 0) {
    return null;
  }

  const providerLabel =
    provider === "claudeAgent"
      ? "Claude"
      : provider === "codex"
        ? "Codex"
        : provider === "cursor"
          ? "Cursor"
          : provider === "opencode"
            ? "OpenCode"
            : provider;

  return (
    <div
      data-slot="provider-runtime-info"
      className="flex h-7 shrink-0 items-center gap-3 overflow-x-auto border-b border-border px-4 text-2xs text-muted-foreground [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
    >
      <span className="shrink-0 font-medium text-foreground">{providerLabel} runtime</span>
      {entries.map((entry) => (
        <span key={entry.label} className="flex min-w-0 shrink-0 items-center gap-1">
          <span>{entry.label}</span>
          <span className="max-w-64 truncate font-mono text-foreground" title={entry.value}>
            {entry.value}
          </span>
        </span>
      ))}
    </div>
  );
});
