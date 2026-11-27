import {
  mcpToolPolicyChoice,
  mcpToolSwitchState,
  summarizeMcpTools,
  type McpToolPolicyChoice,
} from "@t3tools/shared/mcpTools";
import { Switch } from "../../ui/switch";
import { McpToolPinBadge, McpToolPolicyToggle } from "./McpToolPolicies";
import type {
  McpToolPinState,
  McpServerStatusesResult,
  McpSessionReloadOutcome,
  ProjectId,
  ProviderInstanceId,
  ProviderKind,
} from "@t3tools/contracts";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { mcpInspectServerQueryOptions } from "../../../lib/mcpInspectionReactQuery";
import { useCopyToClipboard } from "../../../hooks/useCopyToClipboard";
import { Button } from "../../ui/button";
import { McpSessionOutcomes } from "./McpSessionOutcomes";
import { readErrorMessage } from "./mcpSettingsHelpers";

export type InspectorTab = "Overview" | "Tools" | "Resources" | "Diagnostics";

export function McpServerInspector(props: {
  initialTab?: InspectorTab | undefined;
  /** Shows only this section, without the inspector's own tab row. */
  tab?: InspectorTab | undefined;
  configuredServer?: import("@t3tools/contracts").McpServerDefinition | undefined;
  fallbackTools?: ReadonlyArray<import("@t3tools/contracts").McpToolSummary> | undefined;
  onToolToggle?: ((name: string, enabled: boolean) => Promise<void>) | undefined;
  /** Shows Allow, Ask and Block per tool instead of the on/off switch. */
  onToolPolicy?: ((name: string, choice: McpToolPolicyChoice) => Promise<void>) | undefined;
  /** F5's pin state per tool (New, Changed). */
  pinStates?: ReadonlyMap<string, McpToolPinState> | undefined;
  provider: ProviderKind;
  instanceId: ProviderInstanceId;
  projectId: ProjectId | null;
  serverName: string;
  ownership?: "managed" | "external" | "built-in";
  observation?: McpServerStatusesResult | undefined;
  outcomes?: ReadonlyArray<McpSessionReloadOutcome> | undefined;
  outcomeAction?: "apply" | "reconnect";
}) {
  const [savingTool, setSavingTool] = useState<string | null>(null);
  const [toolError, setToolError] = useState<string | null>(null);
  const [selectedTab, setTab] = useState<InspectorTab>(props.initialTab ?? "Overview");
  const tab = props.tab ?? selectedTab;
  const query = useQuery(
    mcpInspectServerQueryOptions({
      ...props,
      projectId: props.projectId,
      enabled: !!props.projectId,
      serverName: props.serverName,
    }),
  );
  const { copyToClipboard, isCopied } = useCopyToClipboard();
  const data = query.data;
  const status = data?.statuses.find(
    (entry) =>
      entry.name === props.serverName &&
      (entry.ownership ?? "managed") === (props.ownership ?? "managed"),
  );
  const reportedTools = new Map(data?.tools.map((tool) => [tool.name, tool]));
  const toolSummaries = summarizeMcpTools([
    ...new Map(
      [
        ...(props.configuredServer?.disabledTools ?? []).map((name) => ({ name })),
        ...(props.fallbackTools ?? []),
        ...(data?.tools ?? []),
      ].map((tool) => [tool.name, tool]),
    ).values(),
  ]);
  return (
    <section
      className="space-y-3 rounded-md border border-border p-3"
      aria-label={`Inspect ${props.serverName}`}
    >
      <div className="flex flex-wrap gap-2">
        {/* A fixed section has no tabs to choose, so it has no tablist either. */}
        {props.tab ? null : (
          <div className="flex flex-wrap gap-2" role="tablist" aria-label="Server inspector">
            {(["Overview", "Tools", "Resources", "Diagnostics"] as const).map((value) => (
              <Button
                key={value}
                size="xs"
                variant={tab === value ? "secondary" : "outline"}
                role="tab"
                aria-selected={tab === value}
                onClick={() => setTab(value)}
              >
                {value}
              </Button>
            ))}
          </div>
        )}
        <Button
          size="xs"
          variant="outline"
          disabled={!props.projectId || query.isFetching}
          onClick={() => void query.refetch()}
        >
          Refresh inspector
        </Button>
      </div>
      {props.projectId && query.isPending ? (
        <p className="text-xs text-muted-foreground">Loading inspector…</p>
      ) : null}
      {query.error ? (
        <p className="text-xs text-destructive">
          {readErrorMessage(query.error, "Could not inspect this server.")}
        </p>
      ) : null}
      {tab === "Tools" ? (
        <div className="space-y-2 text-xs">
          {" "}
          {toolSummaries.length ? (
            toolSummaries.map((tool) => {
              const reported = reportedTools.get(tool.name);
              const state = props.configuredServer
                ? mcpToolSwitchState(props.configuredServer, tool.name)
                : undefined;
              return (
                <div
                  key={tool.name}
                  className="flex items-center justify-between gap-3 rounded border p-2"
                >
                  <div>
                    <p className="flex flex-wrap items-center gap-1.5">
                      <span>
                        {tool.name}
                        {tool.readOnly ? " · read only" : ""}
                        {tool.destructive ? " · destructive" : ""}
                      </span>
                      <McpToolPinBadge state={props.pinStates?.get(tool.name)} />
                    </p>
                    {tool.description ? <p>{tool.description}</p> : null}
                    {reported ? (
                      <details>
                        <summary>Tool details</summary>
                        <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-all">
                          {JSON.stringify(reported.annotations ?? {}, null, 2)}
                        </pre>
                        {data?.capabilities.inputSchemas ? (
                          <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-all">
                            {JSON.stringify(reported.inputSchema ?? {}, null, 2)}
                          </pre>
                        ) : (
                          <p>Input schemas are not available from this runtime.</p>
                        )}
                      </details>
                    ) : null}
                  </div>
                  {state && props.onToolPolicy && props.configuredServer ? (
                    <span
                      title={
                        state.excluded
                          ? "Excluded by this server's enabled-tools list. Edit it under Advanced."
                          : undefined
                      }
                    >
                      <McpToolPolicyToggle
                        toolName={tool.name}
                        value={mcpToolPolicyChoice(props.configuredServer, tool.name)}
                        excluded={state.excluded}
                        disabled={savingTool !== null}
                        onChange={(choice) => {
                          setSavingTool(tool.name);
                          setToolError(null);
                          void props.onToolPolicy!(tool.name, choice)
                            .catch((cause) =>
                              setToolError(
                                readErrorMessage(cause, "Could not save tool settings."),
                              ),
                            )
                            .finally(() => setSavingTool(null));
                        }}
                      />
                    </span>
                  ) : state && props.onToolToggle ? (
                    <span
                      title={
                        state.excluded
                          ? "Excluded by this server's enabled-tools list. Edit it under Advanced."
                          : undefined
                      }
                    >
                      <Switch
                        aria-label={`Enable tool ${tool.name}`}
                        checked={state.checked}
                        disabled={state.excluded || savingTool !== null}
                        onCheckedChange={(enabled) => {
                          setSavingTool(tool.name);
                          setToolError(null);
                          void props.onToolToggle!(tool.name, !!enabled)
                            .catch((cause) =>
                              setToolError(
                                readErrorMessage(cause, "Could not save tool settings."),
                              ),
                            )
                            .finally(() => setSavingTool(null));
                        }}
                      />
                    </span>
                  ) : null}
                </div>
              );
            })
          ) : (
            <p>Tools appear once the server connects.</p>
          )}
          {toolError ? (
            <p role="alert" className="text-destructive">
              {toolError}
            </p>
          ) : null}
        </div>
      ) : null}
      {data ? (
        <div role="tabpanel" className="space-y-2 text-xs">
          {tab === "Overview" ? (
            <>
              <p>
                Saved:{" "}
                {status?.desiredEnabled === undefined
                  ? "External configuration"
                  : status.desiredEnabled
                    ? "Enabled"
                    : "Disabled"}{" "}
                · Observed: {status?.state ?? "Unknown"}
              </p>
              <p>
                {data.source === "conversation"
                  ? `Observed in ${data.threadId}`
                  : "Configuration check"}{" "}
                at{" "}
                {data.observedAt ? new Date(data.observedAt).toLocaleTimeString() : "unknown time"}
              </p>
              <p>
                Saved version: {data.desiredVersion ?? "unknown"} · Applied version:{" "}
                {data.appliedVersion ?? "not a conversation"}
              </p>
              {props.provider === "codex" && (props.ownership ?? "managed") === "managed" ? (
                <p>Reconnect reloads all MCP servers in each affected Codex conversation.</p>
              ) : null}
              {status?.message ? (
                <p className="whitespace-pre-wrap break-words">{status.message}</p>
              ) : null}
            </>
          ) : null}
          {tab === "Resources" ? (
            !data.capabilities.resources ? (
              <p>
                {props.provider === "claudeAgent"
                  ? "Resources are not available from Claude."
                  : "Resources are not available from this runtime."}
              </p>
            ) : (
              <>
                <p>
                  {data.resources.length} resources · {data.resourceTemplates.length} templates.
                  Metadata only.
                </p>
                <pre className="max-h-80 overflow-auto whitespace-pre-wrap break-all">
                  {JSON.stringify(
                    { resources: data.resources, templates: data.resourceTemplates },
                    null,
                    2,
                  )}
                </pre>
              </>
            )
          ) : null}
          {tab === "Diagnostics" ? (
            <>
              <p>{data.complete ? "Complete observation" : "Partial observation"}</p>
              <p>Historical activity for this conversation, account, and generation:</p>
              {data.diagnostics.length ? (
                <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-all">
                  {JSON.stringify(data.diagnostics, null, 2)}
                </pre>
              ) : (
                <p>No stamped historical diagnostics.</p>
              )}
              <Button
                size="xs"
                variant="outline"
                onClick={() =>
                  void copyToClipboard(
                    JSON.stringify(
                      {
                        source: data.source,
                        observedAt: data.observedAt,
                        instanceId: data.instanceId,
                        threadId: data.threadId,
                        generation: data.generation,
                        desiredVersion: data.desiredVersion,
                        appliedVersion: data.appliedVersion,
                        complete: data.complete,
                        states: data.statuses.map(({ name, state, message, desiredEnabled }) => ({
                          name,
                          state,
                          message,
                          desiredEnabled,
                        })),
                        omissions: data.omissions,
                        diagnostics: data.diagnostics,
                      },
                      null,
                      2,
                    ),
                  )
                }
              >
                {isCopied ? "Copied" : "Copy diagnostics"}
              </Button>
            </>
          ) : null}
          {data.omissions?.map((omission) => (
            <p key={omission} className="text-warning">
              {omission}
            </p>
          ))}
        </div>
      ) : null}
      <McpSessionOutcomes
        outcomes={props.outcomes ?? data?.outcomes}
        action={props.outcomeAction ?? "apply"}
        projectId={props.projectId}
        instanceId={props.instanceId}
        serverName={props.serverName}
      />
    </section>
  );
}
