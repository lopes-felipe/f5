import {
  PROVIDER_DISPLAY_NAMES,
  ProviderInstanceId,
  type McpHubServerStatus,
  type McpProbeServerResult,
  type McpProjectServersConfig,
  type McpServerStatusEntry,
  type McpServerStatusesResult,
  type McpSessionReloadOutcome,
  type ProjectId,
  type ProviderKind,
} from "@t3tools/contracts";
import { formatMcpServersAsJson } from "@t3tools/shared/mcpConfig";
import { createMcpDiagnosticsSanitizer } from "@t3tools/shared/mcpDiagnostics";
import { setMcpProviderEnabled } from "@t3tools/shared/mcpProviderSupport";
import { setMcpToolEnabled } from "@t3tools/shared/mcpTools";
import { useQueryClient } from "@tanstack/react-query";
import { type ReactNode, useState } from "react";

import { useCopyToClipboard } from "../../../hooks/useCopyToClipboard";
import { ensureNativeApi } from "../../../nativeApi";
import { mcpQueryKeys } from "../../../lib/mcpReactQuery";
import { Badge } from "../../ui/badge";
import { Button } from "../../ui/button";
import {
  Sheet,
  SheetDescription,
  SheetHeader,
  SheetPanel,
  SheetPopup,
  SheetTitle,
} from "../../ui/sheet";
import { UnderlineTabs } from "../../ui/underline-tabs";
import { McpErrorDetails } from "./McpErrorDetails";
import { McpHubSignIn } from "./McpHubSignIn";
import { McpProviderMatrix } from "./McpProviderMatrix";
import { McpProviderSignIn } from "./McpProviderSignIn";
import { McpSessionOutcomes } from "./McpSessionOutcomes";
import { LazyMcpServerInspector as McpServerInspector } from "./LazyMcpServerInspector";
import { McpTestConnection } from "./McpTestConnection";
import { reconnectMcpServer } from "./mcpActions";
import { readErrorMessage } from "./mcpSettingsHelpers";

export type McpDetailTab = "overview" | "tools" | "prompts" | "sign-in" | "configuration";

export const MCP_DETAIL_TABS: ReadonlyArray<{ value: McpDetailTab; label: string }> = [
  { value: "overview", label: "Overview" },
  { value: "tools", label: "Tools" },
  { value: "prompts", label: "Prompts and resources" },
  { value: "sign-in", label: "Sign-in" },
  { value: "configuration", label: "Configuration" },
];

/** The Codex or Claude account whose live status settings show, with its observation. */
export interface McpObservedAccount {
  readonly provider: ProviderKind;
  readonly instanceId: ProviderInstanceId;
  readonly label: string;
  readonly data: McpServerStatusesResult | undefined;
}

const HUB_STATE_LABELS: Record<McpHubServerStatus["state"], string> = {
  idle: "Idle",
  connecting: "Connecting",
  ready: "Ready",
  retrying: "Reconnecting",
  failed: "Failed",
  "needs-auth": "Needs sign-in",
  stopped: "Stopped",
};

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

/**
 * A server's detail panel. Overview combines F5's hub connections with the observed
 * Codex or Claude account; the other tabs hold tools, prompts and resources,
 * sign-in, and the configuration form.
 */
export function McpServerDetailSheet(props: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly tab: McpDetailTab;
  readonly onTabChange: (tab: McpDetailTab) => void;
  readonly name: string;
  readonly server: McpProjectServersConfig[string];
  /** `inherited` servers come from common scope and are read-only here. */
  readonly kind: "scope" | "inherited";
  readonly scopeLabel: string;
  readonly projectId: ProjectId | null;
  readonly account: McpObservedAccount | undefined;
  readonly hubEntries: ReadonlyArray<McpHubServerStatus>;
  readonly busy: boolean;
  readonly isApplying: boolean;
  readonly onApply: () => void;
  /** Conversations from the last Apply or Reconnect, for this server and account. */
  readonly outcomes?: ReadonlyArray<McpSessionReloadOutcome> | undefined;
  /** Identifies that Apply or Reconnect result; it changes only when a new one arrives. */
  readonly outcomesKey?: unknown;
  readonly outcomeAction?: "apply" | "reconnect";
  readonly onReconnected?: (sessions: ReadonlyArray<McpSessionReloadOutcome>) => void;
  readonly onServerChange: (next: McpProjectServersConfig[string]) => Promise<void>;
  readonly onOverride?: (() => void) | undefined;
  /** The configuration form for this scope's servers. */
  readonly editor: ReactNode;
}) {
  const queryClient = useQueryClient();
  const { copyToClipboard, isCopied } = useCopyToClipboard();
  const [testedProbe, setTestedProbe] = useState<{
    readonly connection: string;
    readonly result: McpProbeServerResult;
  } | null>(null);
  const [diagnosticsOpen, setDiagnosticsOpen] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [reconnecting, setReconnecting] = useState(false);
  const observed: McpServerStatusEntry | undefined = props.account?.data?.statuses.find(
    (entry) => entry.name === props.name && (entry.ownership ?? "managed") === "managed",
  );
  const editable = props.kind === "scope";
  const instanceId = props.account?.instanceId ?? ProviderInstanceId.make("codex");
  // A connection check describes the definition and account it tested; once either
  // changes (a save, another account), its tools and counts no longer apply.
  const connectionKey = (
    name: string,
    server: McpProjectServersConfig[string],
    account: ProviderInstanceId,
  ) => JSON.stringify([name, server, account]);
  const probe =
    testedProbe?.connection === connectionKey(props.name, props.server, instanceId)
      ? testedProbe.result
      : null;
  const hubSessions = props.hubEntries.reduce((sum, entry) => sum + entry.attachedSessions, 0);
  const conversations = props.account?.data?.sessions?.length ?? 0;

  const run = async (action: () => Promise<unknown>, fallback: string) => {
    setActionError(null);
    try {
      await action();
    } catch (cause) {
      setActionError(readErrorMessage(cause, fallback));
    }
  };

  const reconnectHub = () =>
    run(async () => {
      setReconnecting(true);
      try {
        await ensureNativeApi().mcp.reconnectHubServer({
          serverName: props.name,
          ...(props.projectId ? { projectId: props.projectId } : {}),
        });
        await queryClient.invalidateQueries({ queryKey: mcpQueryKeys.hubStatus(props.projectId) });
      } finally {
        setReconnecting(false);
      }
    }, `Could not reconnect ${props.name}.`);

  const reconnectObserved = () =>
    run(async () => {
      if (!props.projectId || !props.account) return;
      setReconnecting(true);
      try {
        const result = await reconnectMcpServer(queryClient, {
          provider: props.account.provider,
          instanceId: props.account.instanceId,
          projectId: props.projectId,
          serverName: props.name,
        });
        props.onReconnected?.(result.sessions ?? []);
      } finally {
        setReconnecting(false);
      }
    }, "Reconnect failed.");

  const json = formatMcpServersAsJson({ [props.name]: props.server });

  return (
    <Sheet open={props.open} onOpenChange={props.onOpenChange}>
      <SheetPopup side="right" className="max-w-2xl" aria-label={`MCP server ${props.name}`}>
        <SheetHeader>
          <SheetTitle>{props.name}</SheetTitle>
          <SheetDescription>
            {props.server.type} · {props.scopeLabel}
            {props.server.enabled === false ? " · disabled" : ""}
          </SheetDescription>
        </SheetHeader>
        <SheetPanel className="space-y-4">
          <UnderlineTabs
            aria-label={`${props.name} details`}
            tabs={MCP_DETAIL_TABS}
            value={props.tab}
            onValueChange={props.onTabChange}
            scrollable
          />
          {actionError ? (
            <p role="alert" className="text-xs text-destructive">
              {actionError}
            </p>
          ) : null}

          {props.tab === "overview" ? (
            <div className="space-y-4 text-xs">
              {props.server.description ? (
                <p className="text-foreground">{props.server.description}</p>
              ) : null}
              <section aria-label="Live status" className="space-y-2">
                <p className="font-medium text-foreground">Live status</p>
                {props.hubEntries.map((entry, index) => (
                  <div
                    // Several connections can serve one server (one per session for stdio).
                    key={entry.id ?? `${entry.connectionScope}:${index}`}
                    className="space-y-1 rounded-md border border-border px-2 py-1.5"
                  >
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-foreground">Other agents</span>
                      <Badge
                        variant={
                          entry.state === "ready"
                            ? "success"
                            : entry.state === "failed"
                              ? "error"
                              : entry.state === "needs-auth" || entry.state === "retrying"
                                ? "warning"
                                : "outline"
                        }
                      >
                        {HUB_STATE_LABELS[entry.state]}
                      </Badge>
                      <span className="text-muted-foreground">
                        {[
                          entry.providers
                            .map((provider) => PROVIDER_DISPLAY_NAMES[provider])
                            .join(", "),
                          plural(entry.attachedSessions, "session"),
                          entry.connectionScope === "shared"
                            ? "shared connection"
                            : "one connection per session",
                          entry.toolCount !== undefined ? plural(entry.toolCount, "tool") : null,
                        ]
                          .filter(Boolean)
                          .join(" · ")}
                      </span>
                      {/* A connection can look ready while its session is gone; any settled state can be reconnected. */}
                      {entry.state !== "connecting" ? (
                        <Button
                          size="xs"
                          variant="outline"
                          className="ml-auto"
                          disabled={reconnecting}
                          title={
                            props.projectId
                              ? undefined
                              : "Restarts this server's connections in every project, including project overrides."
                          }
                          onClick={() => void reconnectHub()}
                        >
                          {/* Without a project the hub restarts every connection of this name. */}
                          {props.projectId ? "Reconnect" : "Reconnect in all projects"}
                        </Button>
                      ) : null}
                    </div>
                    {entry.error ? <p className="text-muted-foreground">{entry.error}</p> : null}
                  </div>
                ))}
                {props.account && observed ? (
                  <div className="space-y-1 rounded-md border border-border px-2 py-1.5">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-foreground">{props.account.label}</span>
                      <Badge
                        variant={
                          observed.state === "ready"
                            ? "success"
                            : observed.state === "failed"
                              ? "error"
                              : observed.state === "needs-auth" ||
                                  observed.state === "login-required"
                                ? "warning"
                                : "outline"
                        }
                      >
                        {observed.state}
                      </Badge>
                      {observed.state === "ready" || observed.toolCount > 0 ? (
                        <span className="text-muted-foreground">
                          {plural(observed.toolCount, "tool")}
                        </span>
                      ) : null}
                      {["failed", "needs-auth", "login-required", "unknown"].includes(
                        observed.state,
                      ) ? (
                        <Button
                          size="xs"
                          variant="outline"
                          className="ml-auto"
                          disabled={reconnecting}
                          title={
                            props.account.provider === "codex"
                              ? "Reloads MCP connections for every server in the affected Codex sessions."
                              : undefined
                          }
                          onClick={() => void reconnectObserved()}
                        >
                          Reconnect in {PROVIDER_DISPLAY_NAMES[props.account.provider]}
                        </Button>
                      ) : null}
                    </div>
                    {observed.message ? (
                      ["failed", "needs-auth", "login-required", "unknown"].includes(
                        observed.state,
                      ) ? (
                        <McpErrorDetails
                          message={observed.message}
                          servers={{ [props.name]: props.server }}
                        />
                      ) : (
                        <p className="text-muted-foreground">
                          {createMcpDiagnosticsSanitizer({ [props.name]: props.server }).text(
                            observed.message,
                          )}
                        </p>
                      )
                    ) : null}
                  </div>
                ) : null}
                {props.hubEntries.length === 0 && !observed ? (
                  <p className="text-muted-foreground">
                    No agent session is using this server
                    {props.projectId ? "" : ", and live Codex and Claude status needs a project"}.
                    Check the connection to see what it offers.
                  </p>
                ) : null}
              </section>
              {props.account && props.projectId ? (
                <details
                  className="space-y-2"
                  onToggle={(event) => setDiagnosticsOpen(event.currentTarget.open)}
                >
                  <summary className="cursor-pointer font-medium text-foreground">
                    Diagnostics
                  </summary>
                  {/* Read-only history for the observed conversation, with Copy diagnostics. */}
                  {diagnosticsOpen ? (
                    <McpServerInspector
                      tab="Diagnostics"
                      provider={props.account.provider}
                      instanceId={props.account.instanceId}
                      projectId={props.projectId}
                      serverName={props.name}
                      configuredServer={props.server}
                      observation={props.account.data}
                      outcomes={[]}
                    />
                  ) : null}
                </details>
              ) : null}
              <McpTestConnection
                projectId={props.projectId}
                instanceId={instanceId}
                getServer={() => ({ name: props.name, server: props.server })}
                onResult={(result, tested) =>
                  setTestedProbe({
                    connection: connectionKey(tested.name, tested.server, tested.instanceId),
                    result,
                  })
                }
                onOpenTools={() => props.onTabChange("tools")}
              />
              <McpProviderMatrix
                serverName={props.name}
                server={props.server}
                disabled={props.busy}
                onToggle={
                  editable
                    ? (provider, enabled) =>
                        void run(
                          () =>
                            props.onServerChange(
                              setMcpProviderEnabled(props.server, provider, enabled),
                            ),
                          "Could not update providers.",
                        )
                    : undefined
                }
              />
              <section aria-label="Sessions" className="space-y-1">
                <p className="font-medium text-foreground">Sessions</p>
                <p className="text-muted-foreground">
                  {plural(hubSessions, "other-agent session")}
                  {props.account
                    ? ` · ${plural(conversations, "conversation")} on ${props.account.label}`
                    : ""}
                  . Other agents pick up saved changes in their next session; Apply reloads running
                  Codex and Claude sessions.
                </p>
                <Button
                  size="xs"
                  variant="outline"
                  disabled={props.isApplying}
                  onClick={props.onApply}
                >
                  Apply to live sessions
                </Button>
                <McpSessionOutcomes
                  outcomes={props.outcomes}
                  resultKey={props.outcomesKey}
                  action={props.outcomeAction ?? "apply"}
                  projectId={props.projectId}
                  instanceId={instanceId}
                  serverName={props.name}
                />
              </section>
              {props.kind === "inherited" ? (
                <p className="text-muted-foreground">
                  This server comes from common scope. Edit it in Global settings, or override it in
                  this project.{" "}
                  {props.onOverride ? (
                    <Button size="xs" variant="outline" onClick={props.onOverride}>
                      Override
                    </Button>
                  ) : null}
                </p>
              ) : null}
            </div>
          ) : null}

          {props.tab === "tools" ? (
            <McpServerInspector
              key={`${props.account?.data?.threadId}:${props.account?.data?.generation}`}
              tab="Tools"
              provider={props.account?.provider ?? "codex"}
              instanceId={instanceId}
              projectId={props.account ? props.projectId : null}
              serverName={props.name}
              configuredServer={props.server}
              onToolToggle={
                editable
                  ? (tool, enabled) =>
                      props.onServerChange(setMcpToolEnabled(props.server, tool, enabled))
                  : undefined
              }
              fallbackTools={probe?.tools ?? observed?.tools}
              observation={props.account?.data}
            />
          ) : null}

          {props.tab === "prompts" ? (
            <div className="space-y-3 text-xs">
              {probe ? (
                <p>
                  {plural(probe.promptCount, "prompt")} · {plural(probe.resourceCount, "resource")}{" "}
                  in the last connection check.
                </p>
              ) : null}
              {props.hubEntries.map((entry, index) =>
                entry.promptCount !== undefined || entry.resourceCount !== undefined ? (
                  // Several connections can serve one server (one per session for stdio).
                  <p key={entry.id ?? `${entry.connectionScope}:${index}`}>
                    Other agents' connection: {plural(entry.promptCount ?? 0, "prompt")} ·{" "}
                    {plural(entry.resourceCount ?? 0, "resource")}.
                  </p>
                ) : null,
              )}
              {!probe && props.hubEntries.length === 0 ? (
                <p className="text-muted-foreground">
                  Check the connection on Overview to count this server's prompts and resources.
                </p>
              ) : null}
              {props.account && props.projectId ? (
                <McpServerInspector
                  tab="Resources"
                  provider={props.account.provider}
                  instanceId={props.account.instanceId}
                  projectId={props.projectId}
                  serverName={props.name}
                  configuredServer={props.server}
                  observation={props.account.data}
                />
              ) : null}
            </div>
          ) : null}

          {props.tab === "sign-in" ? (
            <div className="space-y-4">
              <McpHubSignIn serverName={props.name} projectId={props.projectId} />
              {props.account ? (
                <McpProviderSignIn
                  provider={props.account.provider}
                  instanceId={props.account.instanceId}
                  accountLabel={props.account.label}
                  projectId={props.projectId}
                  serverName={props.name}
                  server={props.server}
                  serverStatus={observed}
                  observation={props.account.data}
                />
              ) : (
                <p className="text-xs text-muted-foreground">
                  Codex and Claude sign-in needs a project. Choose one in the settings scope.
                </p>
              )}
            </div>
          ) : null}

          {props.tab === "configuration" ? (
            <div className="space-y-4">
              {editable ? props.editor : null}
              <section aria-label="JSON" className="space-y-2 text-xs">
                <div className="flex items-center justify-between">
                  <p className="font-medium text-foreground">Saved JSON</p>
                  <Button
                    size="xs"
                    variant="outline"
                    onClick={() => copyToClipboard(json, undefined)}
                  >
                    {isCopied ? "Copied" : "Copy JSON"}
                  </Button>
                </div>
                <pre className="max-h-64 overflow-auto rounded-md border border-border bg-muted/40 p-2 font-mono">
                  {json}
                </pre>
              </section>
              {props.kind === "inherited" && props.onOverride ? (
                <Button size="sm" variant="outline" onClick={props.onOverride}>
                  Override in this project
                </Button>
              ) : null}
            </div>
          ) : null}
        </SheetPanel>
      </SheetPopup>
    </Sheet>
  );
}
