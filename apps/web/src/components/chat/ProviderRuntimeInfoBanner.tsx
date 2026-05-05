import { type ProviderKind } from "@t3tools/contracts";
import { memo } from "react";

import { Badge } from "../ui/badge";

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
    <div className="mx-auto max-w-3xl px-3 pt-3 sm:px-5">
      <div className="rounded-2xl border border-border/70 bg-card/70 px-3 py-2.5 backdrop-blur-sm sm:px-4">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-[11px] font-medium uppercase tracking-[0.14em] text-muted-foreground">
            {providerLabel} runtime
          </span>
          {entries.map((entry) => (
            <Badge key={entry.label} variant="outline" className="min-w-0 gap-1.5 font-normal">
              <span className="shrink-0 text-muted-foreground">{entry.label}</span>
              <span className="truncate text-foreground" title={entry.value}>
                {entry.value}
              </span>
            </Badge>
          ))}
        </div>
      </div>
    </div>
  );
});
