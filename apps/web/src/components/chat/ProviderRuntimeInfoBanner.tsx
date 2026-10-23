import { Link } from "@tanstack/react-router";
import { createMcpDiagnosticsSanitizer } from "@t3tools/shared/mcpDiagnostics";
import { Popover, PopoverTrigger, PopoverPopup } from "../ui/popover";
import { useQuery } from "@tanstack/react-query";
import { mcpEffectiveConfigQueryOptions } from "../../lib/mcpReactQuery";
import {
  type ProjectId,
  type CompactMcpStatusActivityPayload,
  type ProviderKind,
  type ThreadId,
} from "@t3tools/contracts";
import { ChevronDownIcon, KeyRoundIcon } from "lucide-react";
import { McpSignInControls } from "../settings/mcp/McpSignInButton";
import { Fragment, memo, useRef, useState } from "react";
import { cn } from "~/lib/utils";

interface ProviderRuntimeInfoEntry {
  readonly label: string;
  readonly value: string;
}

function runtimeProviderLabel(provider: ProviderKind): string {
  return provider === "claudeAgent"
    ? "Claude"
    : provider === "codex"
      ? "Codex"
      : provider === "cursor"
        ? "Cursor"
        : provider === "opencode"
          ? "OpenCode"
          : provider;
}

/**
 * The runtime banner folded into a header chip (compact chat layout): the
 * provider and its CLI version, with every entry in a popover.
 */
export const ProviderRuntimeInfoChip = memo(function ProviderRuntimeInfoChip({
  provider,
  entries,
  mcpServers,
  projectId,
  threadId,
  className,
}: {
  provider: ProviderKind | null;
  entries: ReadonlyArray<ProviderRuntimeInfoEntry>;
  mcpServers?: ReadonlyArray<CompactMcpStatusActivityPayload> | undefined;
  projectId?: ProjectId | undefined;
  threadId?: ThreadId | undefined;
  className?: string | undefined;
}) {
  if (!provider || entries.length === 0) {
    return null;
  }
  const providerLabel = runtimeProviderLabel(provider);
  const headline = entries.find((entry) => entry.label === "CLI") ?? entries[0]!;
  const summary = `${providerLabel} · ${headline.label} ${headline.value}`;
  return (
    <Popover>
      <PopoverTrigger
        data-slot="provider-runtime-info-chip"
        aria-label={`${providerLabel} runtime: ${headline.label} ${headline.value}`}
        title={summary}
        className={cn(
          "flex h-6 max-w-56 shrink-0 cursor-pointer items-center gap-1 rounded-md border border-border/70 px-1.5 text-2xs text-muted-foreground outline-none hover:bg-accent hover:text-accent-foreground focus-visible:ring-2 focus-visible:ring-ring data-popup-open:bg-accent",
          className,
        )}
      >
        <span className="font-medium text-foreground">{providerLabel}</span>
        <span className="min-w-0 truncate">
          · {headline.label} <span className="font-mono text-foreground">{headline.value}</span>
        </span>
      </PopoverTrigger>
      <PopoverPopup
        side="bottom"
        align="start"
        className="max-w-md"
        aria-label={`${providerLabel} runtime`}
      >
        <dl className="grid grid-cols-[auto_minmax(0,1fr)] items-center gap-x-4 gap-y-1.5 text-xs [&_dt]:text-muted-foreground">
          {entries.map((entry) => (
            <Fragment key={entry.label}>
              <dt>{entry.label}</dt>
              <dd className="min-w-0">
                {entry.label === "MCP" && mcpServers?.length ? (
                  <McpRuntimeChip
                    summary={entry.value}
                    servers={mcpServers}
                    projectId={projectId}
                    provider={provider}
                    threadId={threadId}
                  />
                ) : (
                  <span className="block truncate font-mono text-foreground" title={entry.value}>
                    {entry.value}
                  </span>
                )}
              </dd>
            </Fragment>
          ))}
        </dl>
      </PopoverPopup>
    </Popover>
  );
});

export const ProviderRuntimeInfoBanner = memo(function ProviderRuntimeInfoBanner({
  provider,
  entries,
  mcpServers,
  projectId,
  threadId,
}: {
  provider: ProviderKind | null;
  entries: ReadonlyArray<ProviderRuntimeInfoEntry>;
  mcpServers?: ReadonlyArray<CompactMcpStatusActivityPayload> | undefined;
  projectId?: ProjectId | undefined;
  threadId?: ThreadId | undefined;
}) {
  if (!provider || entries.length === 0) {
    return null;
  }

  const providerLabel = runtimeProviderLabel(provider);

  return (
    <div
      data-slot="provider-runtime-info"
      className="flex h-7 shrink-0 items-center gap-3 overflow-x-auto px-4 text-2xs text-muted-foreground [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
    >
      <span className="shrink-0 font-medium text-foreground">{providerLabel} runtime</span>
      {entries.map((entry) =>
        entry.label === "MCP" && mcpServers?.length ? (
          <McpRuntimeChip
            key={entry.label}
            summary={entry.value}
            servers={mcpServers}
            projectId={projectId}
            provider={provider}
            threadId={threadId}
          />
        ) : (
          <span key={entry.label} className="flex min-w-0 shrink-0 items-center gap-1">
            <span>{entry.label}</span>
            <span className="max-w-64 truncate font-mono text-foreground" title={entry.value}>
              {entry.value}
            </span>
          </span>
        ),
      )}
    </div>
  );
});

function McpRuntimeChip({
  summary,
  servers,
  projectId,
  provider,
  threadId,
}: {
  readonly summary: string;
  readonly servers: ReadonlyArray<CompactMcpStatusActivityPayload>;
  readonly projectId: ProjectId | undefined;
  readonly provider: ProviderKind;
  readonly threadId: ThreadId | undefined;
}) {
  const [open, setOpen] = useState(false);
  const settingsLink = useRef<HTMLAnchorElement>(null);
  // Read on explicit inspection, and withhold raw errors until value scrubbing is available.
  const config = useQuery(
    mcpEffectiveConfigQueryOptions({ projectId: projectId ?? null, enabled: open && !!projectId }),
  );
  const sanitizer =
    config.isSuccess && !config.isFetching
      ? createMcpDiagnosticsSanitizer(config.data.servers)
      : null;
  const needsSignIn = servers.filter((server) => server.status === "needs-auth").length;
  const signInLabel =
    needsSignIn > 0 ? `${needsSignIn} ${needsSignIn === 1 ? "needs" : "need"} sign-in` : null;
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        className="flex shrink-0 cursor-pointer items-center gap-1 rounded border border-border/70 px-1.5 py-px text-2xs outline-none hover:bg-accent hover:text-accent-foreground focus-visible:ring-2 focus-visible:ring-ring data-popup-open:bg-accent"
        aria-label={`MCP: ${summary}${signInLabel ? `, ${signInLabel}` : ""}`}
      >
        MCP <span className="font-mono text-foreground">{summary}</span>
        {signInLabel ? (
          <span className="flex items-center gap-0.5 text-warning-foreground">
            <KeyRoundIcon aria-hidden="true" className="size-3" />
            {signInLabel}
          </span>
        ) : null}
        <ChevronDownIcon aria-hidden="true" className="size-3 opacity-60" />
      </PopoverTrigger>
      <PopoverPopup
        side="bottom"
        tooltipStyle
        className="max-w-md"
        initialFocus={settingsLink}
        aria-label="MCP server details"
      >
        <div className="space-y-2 p-1">
          <div className="max-h-72 space-y-2 overflow-y-auto">
            {servers.map((server, index) => (
              <div key={server.name ?? index}>
                <p className="font-medium">
                  {server.name ?? "Unnamed server"} · {server.status}
                </p>
                {server.error ? (
                  <p className="whitespace-pre-wrap break-words">
                    {sanitizer
                      ? sanitizer.text(server.error)
                      : "Error details unavailable until configuration loads. Open MCP settings for details."}
                  </p>
                ) : null}
                {server.status === "needs-auth" &&
                server.name &&
                (provider === "claudeAgent" || provider === "codex") ? (
                  <McpSignInControls
                    provider={provider}
                    instanceId={server.providerInstanceId}
                    projectId={projectId ?? null}
                    serverName={server.name}
                    // Only Claude sign-in is routed through a conversation; Codex is account-scoped.
                    threadId={provider === "claudeAgent" ? threadId : undefined}
                  />
                ) : null}
              </div>
            ))}
          </div>
          <Link
            ref={settingsLink}
            to="/settings"
            search={{
              category: "tools",
              ...(projectId ? { project: projectId } : {}),
              item: "tools.mcp",
            }}
            className="block underline"
          >
            Open MCP settings
          </Link>
        </div>
      </PopoverPopup>
    </Popover>
  );
}
