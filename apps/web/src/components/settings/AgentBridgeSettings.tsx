import { toastManager } from "../ui/toast";
/** Opt-in local MCP connection and explicit per-client scheduling grants. */
import {
  AGENT_BRIDGE_ACTIVATION_VERSION,
  AGENT_BRIDGE_LOCAL_CLIENT_ID,
  type AgentBridgeClient,
  type AgentBridgeSettingsPatch,
  type AgentBridgeState,
  type AgentBridgeStdioSetup,
  type ProjectId,
} from "@t3tools/contracts";
import { useCallback, useEffect, useRef, useState } from "react";

import { type UnifiedWebSettings, useSettings, useUpdateSettings } from "../../hooks/useSettings";
import { ensureNativeApi } from "../../nativeApi";
import { onServerWelcome } from "../../wsNativeApi";
import { Badge } from "../ui/badge";
import { Checkbox } from "../ui/checkbox";
import { Switch } from "../ui/switch";
import { useSettingsRouteContext } from "./SettingsRouteContext";
import { SettingsCard, SettingsRow } from "./SettingsCard";

/** Loads bridge state and refetches on invalidation and after reconnecting. */
function useAgentBridgeState() {
  const [state, setState] = useState<AgentBridgeState | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const api = ensureNativeApi();
    let cancelled = false;
    let latest = 0;
    const load = () => {
      const request = ++latest;
      void api.agentBridge
        .getState()
        .then((next) => {
          if (cancelled || request !== latest) return;
          setState(next);
          setError(null);
        })
        .catch(() => {
          if (!cancelled && request === latest) setError("Agent Bridge status could not be read.");
        });
    };
    load();
    const offChanged = api.agentBridge.onStateChanged(load);
    const offWelcome = onServerWelcome(load);
    return () => {
      cancelled = true;
      offChanged();
      offWelcome();
    };
  }, []);
  return { state, error, setState };
}

/** A connection is whoever holds its credential, not a verified bot. */
export function clientDisplayName(client: AgentBridgeClient): string {
  if (client.id === AGENT_BRIDGE_LOCAL_CLIENT_ID) return client.name;
  return `${client.name} connection`;
}

export function formatStdioSetup(setup: AgentBridgeStdioSetup): string {
  const lines = [`Command: ${setup.command}`, `Arguments: ${JSON.stringify(setup.args)}`];
  const env = Object.entries(setup.env);
  if (env.length > 0)
    lines.push(`Environment: ${env.map(([key, value]) => `${key}=${value}`).join(" ")}`);
  return lines.join("\n");
}

function StdioSnippet({ label, setup }: { label: string; setup: AgentBridgeStdioSetup }) {
  return (
    <div className="space-y-1">
      <p className="text-xs font-medium text-foreground">{label}</p>
      <pre className="overflow-x-auto rounded-md border border-border bg-muted/40 px-3 py-2 font-mono text-2xs text-foreground">
        {formatStdioSetup(setup)}
      </pre>
    </div>
  );
}

function localStatusLabel(state: AgentBridgeState): string {
  switch (state.local.status) {
    case "running":
      return `Running on 127.0.0.1:${state.local.port}`;
    case "failed":
      return `Could not start: ${state.local.detail ?? "unknown error"}`;
    case "stopped":
      return "Stopped";
  }
}

export function AgentBridgeSettings() {
  const agentBridge = useSettings((settings) => settings.agentBridge);
  const { updateSettings } = useUpdateSettings();
  const { projects } = useSettingsRouteContext();
  const { state, error, setState } = useAgentBridgeState();
  const exposed = new Set<string>(agentBridge.exposedProjectIds);
  // Send only the changed fields; the server deep-merges `agentBridge`.
  const patchAgentBridge = useCallback(
    (patch: AgentBridgeSettingsPatch) =>
      updateSettings({ agentBridge: patch } as Partial<UnifiedWebSettings>),
    [updateSettings],
  );
  // Quick toggles build on the last list sent, not on a render that predates it.
  const exposedRef = useRef(agentBridge.exposedProjectIds);
  const pendingToggles = useRef(0);
  useEffect(() => {
    if (pendingToggles.current === 0) exposedRef.current = agentBridge.exposedProjectIds;
  }, [agentBridge.exposedProjectIds]);
  const setExposed = useCallback(
    (projectId: ProjectId, checked: boolean) => {
      const current = exposedRef.current.filter((id) => id !== projectId);
      const next = checked ? [...current, projectId] : current;
      exposedRef.current = next;
      pendingToggles.current += 1;
      void patchAgentBridge({ exposedProjectIds: next }).finally(() => {
        pendingToggles.current -= 1;
      });
    },
    [patchAgentBridge],
  );

  return (
    <SettingsCard
      title="Agent Bridge"
      searchTarget="tools.agent-bridge"
      description="Let an external agent, such as a ChatGPT Dot or any MCP client, read the projects you share and start supervised threads. F5 asks you before those threads act, and agents can never answer approvals, stop work, or change settings."
      actions={
        state ? (
          <Badge variant={state.local.status === "running" ? "success" : "outline"}>
            {state.local.status === "running" ? "On" : "Off"}
          </Badge>
        ) : null
      }
    >
      <SettingsRow
        title="Enable Agent Bridge"
        description="Starts a local MCP listener on 127.0.0.1. Off by default. Previously saved connections require fresh activation. Scheduling permission is granted separately below."
        control={
          <Switch
            checked={
              agentBridge.enabled &&
              agentBridge.activationVersion === AGENT_BRIDGE_ACTIVATION_VERSION
            }
            aria-label="Enable Agent Bridge"
            onCheckedChange={(checked) => void patchAgentBridge({ enabled: checked })}
          />
        }
      />

      <div className="border-b border-border py-3">
        <p className="text-sm font-medium text-foreground">Shared projects</p>
        <p className="text-ui text-muted-foreground">
          Agents see only these projects. Nothing is shared until you choose.
        </p>
        {projects.length === 0 ? (
          <p className="mt-2 text-xs text-muted-foreground">No projects yet.</p>
        ) : (
          <ul className="mt-2 space-y-1.5">
            {projects.map((project) => (
              <li key={project.id}>
                <label className="flex items-center gap-2 text-xs text-foreground">
                  <Checkbox
                    checked={exposed.has(project.id)}
                    aria-label={`Share ${project.name}`}
                    onCheckedChange={(checked) => setExposed(project.id, checked === true)}
                  />
                  <span className="truncate">{project.name}</span>
                </label>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="space-y-2 border-b border-border py-3">
        <p className="text-sm font-medium text-foreground">Local connection</p>
        {error ? <p className="text-xs text-destructive">{error}</p> : null}
        {state ? (
          <>
            <p className="text-xs text-muted-foreground">{localStatusLabel(state)}</p>
            <p className="text-ui text-muted-foreground">
              Add a STDIO MCP server to your client (for example, the ChatGPT desktop app) with
              these values. F5 never edits ChatGPT or Codex configuration.
            </p>
            {state.stdio.desktop ? (
              <StdioSnippet label="Desktop app" setup={state.stdio.desktop} />
            ) : null}
            <StdioSnippet label="CLI install" setup={state.stdio.cli} />
          </>
        ) : null}
      </div>

      <div className="border-b border-border py-3">
        <p className="text-sm font-medium text-foreground">Connected clients</p>
        {state && state.clients.length > 0 ? (
          <ul className="mt-2 space-y-2">
            {state.clients.map((client) => (
              <li key={client.id} className="flex items-start gap-2 text-xs">
                <div className="min-w-0 flex-1">
                  <p className="flex items-center gap-1.5 font-medium text-foreground">
                    {clientDisplayName(client)}
                  </p>
                  <label className="flex items-center gap-2 py-2">
                    <Checkbox
                      checked={client.scopes.includes("f5.schedules")}
                      disabled={!!client.revokedAt}
                      aria-label={`Allow scheduling for ${clientDisplayName(client)}`}
                      onCheckedChange={(enabled) => {
                        void ensureNativeApi()
                          .agentBridge.setSchedulingGrant({
                            clientId: client.id,
                            expectedGrantGeneration: client.grantGeneration,
                            enabled: enabled === true,
                          })
                          .then(() => ensureNativeApi().agentBridge.getState())
                          .then(setState)
                          .catch((error) => {
                            toastManager.add({
                              type: "error",
                              title: "Scheduling grant failed",
                              description:
                                error instanceof Error
                                  ? error.message
                                  : "Reload the connection and try again.",
                            });
                          });
                      }}
                    />
                    Allow creating and managing supervised scheduled tasks
                  </label>
                  <p className="text-muted-foreground">
                    {client.scopes.join(", ") || "no permissions"} · {client.projectIds.length}{" "}
                    project
                    {client.projectIds.length === 1 ? "" : "s"} ·{" "}
                    {client.lastUsedAt
                      ? `last used ${new Date(client.lastUsedAt).toLocaleString()}`
                      : "never used"}
                    {client.revokedAt ? " · revoked" : ""}
                  </p>
                </div>
              </li>
            ))}
          </ul>
        ) : (
          <p className="mt-2 text-xs text-muted-foreground">No clients yet.</p>
        )}
      </div>

      <ul className="mt-3 list-disc space-y-1 pl-4 text-xs text-muted-foreground">
        <li>A connection is whoever holds its credential, not a verified bot.</li>
        <li>
          The Muse personal agent is not supported yet: it has no public Meta API. Muse Code is
          available as a provider.
        </li>
      </ul>
    </SettingsCard>
  );
}
