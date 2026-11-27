import { Link } from "@tanstack/react-router";
import { createMcpDiagnosticsSanitizer } from "@t3tools/shared/mcpDiagnostics";
import { mcpServerNameKey } from "@t3tools/shared/mcpValidation";
import { Popover, PopoverTrigger, PopoverPopup } from "../ui/popover";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  mcpEffectiveConfigQueryOptions,
  mcpQueryKeys,
  mcpThreadServersQueryOptions,
} from "../../lib/mcpReactQuery";
import { ensureNativeApi } from "../../nativeApi";
import { Switch } from "../ui/switch";
import {
  type ProjectId,
  type CompactMcpStatusActivityPayload,
  type ProviderKind,
  type ThreadId,
} from "@t3tools/contracts";
import { ChevronDownIcon, KeyRoundIcon } from "lucide-react";
import { McpHubSignInRow } from "../settings/mcp/McpHubSignIn";
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
  mcpHubServerNames,
  projectId,
  threadId,
  className,
}: {
  provider: ProviderKind | null;
  entries: ReadonlyArray<ProviderRuntimeInfoEntry>;
  mcpServers?: ReadonlyArray<CompactMcpStatusActivityPayload> | undefined;
  /** Server name keys whose entries come from F5's hub (see `mergeChatMcpServers`). */
  mcpHubServerNames?: ReadonlySet<string> | undefined;
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
                    hubServerNames={mcpHubServerNames}
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
  mcpHubServerNames,
  projectId,
  threadId,
}: {
  provider: ProviderKind | null;
  entries: ReadonlyArray<ProviderRuntimeInfoEntry>;
  mcpServers?: ReadonlyArray<CompactMcpStatusActivityPayload> | undefined;
  /** Server name keys whose entries come from F5's hub (see `mergeChatMcpServers`). */
  mcpHubServerNames?: ReadonlySet<string> | undefined;
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
            hubServerNames={mcpHubServerNames}
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

/**
 * Turns a server F5 serves off (or back on) for this conversation only. The agent
 * stops seeing its tools at once; no restart.
 */
function McpThreadServerSwitch(props: {
  readonly threadId: ThreadId;
  readonly serverName: string;
  readonly enabled: boolean;
}) {
  const queryClient = useQueryClient();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="space-y-0.5">
      <label className="flex items-center gap-2">
        <Switch
          aria-label={`Use ${props.serverName} in this conversation`}
          checked={props.enabled}
          disabled={saving}
          onCheckedChange={(checked) => {
            setSaving(true);
            setError(null);
            void ensureNativeApi()
              .mcp.setThreadServerEnabled({
                threadId: props.threadId,
                serverName: props.serverName,
                enabled: !!checked,
              })
              .then((result) =>
                queryClient.setQueryData(mcpQueryKeys.threadServers(props.threadId), result),
              )
              .catch(() => setError("Could not change this server for the conversation."))
              .finally(() => setSaving(false));
          }}
        />
        <span>{props.enabled ? "On in this conversation" : "Off in this conversation"}</span>
      </label>
      {error ? <p className="text-destructive">{error}</p> : null}
    </div>
  );
}

function McpRuntimeChip({
  summary,
  servers,
  hubServerNames,
  projectId,
  provider,
  threadId,
}: {
  readonly summary: string;
  readonly servers: ReadonlyArray<CompactMcpStatusActivityPayload>;
  readonly hubServerNames: ReadonlySet<string> | undefined;
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
  const threadServers = useQuery(
    mcpThreadServersQueryOptions({ threadId: threadId ?? null, enabled: open }),
  );
  const disabledHere = new Set(
    (threadServers.data?.disabledServers ?? []).map((name) => mcpServerNameKey(name)),
  );
  // Only servers saved in F5 have a settings panel to open.
  const savedNames = new Set(Object.keys(config.data?.servers ?? {}).map(mcpServerNameKey));
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
              <div key={server.name ?? index} className="space-y-1">
                <p className="flex flex-wrap items-baseline gap-x-2">
                  <span className="font-medium">
                    {server.name ?? "Unnamed server"} · {server.status}
                    {server.status === "ready" && server.toolCount !== undefined
                      ? ` · ${server.toolCount} ${server.toolCount === 1 ? "tool" : "tools"}`
                      : ""}
                  </span>
                  {server.name && savedNames.has(mcpServerNameKey(server.name)) ? (
                    <Link
                      to="/settings"
                      search={{
                        category: "tools",
                        ...(projectId ? { project: projectId } : {}),
                        item: "tools.mcp",
                        server: server.name,
                      }}
                      className="underline"
                      aria-label={`${server.name} in MCP settings`}
                    >
                      Details
                    </Link>
                  ) : null}
                </p>
                {threadId && server.name && hubServerNames?.has(mcpServerNameKey(server.name)) ? (
                  <McpThreadServerSwitch
                    threadId={threadId}
                    serverName={server.name}
                    enabled={!disabledHere.has(mcpServerNameKey(server.name))}
                  />
                ) : null}
                {server.error ? (
                  <p className="whitespace-pre-wrap break-words">
                    {sanitizer
                      ? sanitizer.text(server.error)
                      : "Error details unavailable until configuration loads. Open MCP settings for details."}
                  </p>
                ) : null}
                {server.status === "needs-auth" && server.name ? (
                  (provider === "claudeAgent" || provider === "codex") &&
                  !hubServerNames?.has(mcpServerNameKey(server.name)) ? (
                    // Codex's and Claude's own servers sign in through the agent.
                    <McpSignInControls
                      provider={provider}
                      instanceId={server.providerInstanceId}
                      projectId={projectId ?? null}
                      serverName={server.name}
                      // Only Claude sign-in is routed through a conversation; Codex is account-scoped.
                      threadId={provider === "claudeAgent" ? threadId : undefined}
                    />
                  ) : (
                    // Servers F5 serves use F5's own sign-in, shared by every project.
                    <>
                      {provider === "claudeAgent" || provider === "codex" ? (
                        <p className="text-muted-foreground">
                          {runtimeProviderLabel(provider)} reaches this server through F5 now; its
                          earlier sign-in is not carried over.
                        </p>
                      ) : null}
                      <McpHubSignInRow serverName={server.name} projectId={projectId ?? null} />
                    </>
                  )
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
