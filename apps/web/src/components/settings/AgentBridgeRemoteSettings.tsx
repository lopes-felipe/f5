import {
  AGENT_BRIDGE_REMOTE_MIN_PORT,
  AGENT_BRIDGE_SCOPES,
  canonicalizeAgentBridgePublicBaseUrl,
  ProjectId,
  type AgentBridgeClient,
  type AgentBridgeScope,
  type AgentBridgeSettings,
  type AgentBridgeState,
} from "@t3tools/contracts";
import { useEffect, useState } from "react";

import { ensureNativeApi } from "../../nativeApi";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { Switch } from "../ui/switch";
import { Textarea } from "../ui/textarea";
import { toastManager } from "../ui/toast";
import { SettingsRow } from "./SettingsCard";

export const SCOPE_LABELS: Record<AgentBridgeScope, string> = {
  "f5.read": "Read shared projects, threads, and diffs",
  "f5.turns": "Start supervised threads and send messages",
  "f5.tasks": "Take tasks you assign",
  "f5.events": "Receive event notifications",
};

const errorMessage = (error: unknown) =>
  error instanceof Error ? error.message : "The request failed.";

interface SharedProject {
  readonly id: string;
  readonly name: string;
}

function ScopeAndProjectPicker(props: {
  scopes: ReadonlyArray<AgentBridgeScope>;
  selectedScopes: ReadonlySet<AgentBridgeScope>;
  onScopesChange: (next: Set<AgentBridgeScope>) => void;
  projects: ReadonlyArray<SharedProject>;
  selectedProjects: ReadonlySet<string>;
  onProjectsChange: (next: Set<string>) => void;
}) {
  const toggle = <T,>(set: ReadonlySet<T>, value: T, checked: boolean) => {
    const next = new Set(set);
    if (checked) next.add(value);
    else next.delete(value);
    return next;
  };
  return (
    <div className="space-y-3">
      <fieldset className="space-y-1.5">
        <legend className="text-xs font-medium text-foreground">Permissions</legend>
        {props.scopes.map((scope) => (
          <label key={scope} className="flex items-center gap-2 text-xs text-foreground">
            <Checkbox
              checked={props.selectedScopes.has(scope)}
              onCheckedChange={(checked) =>
                props.onScopesChange(toggle(props.selectedScopes, scope, checked === true))
              }
            />
            <span>{SCOPE_LABELS[scope]}</span>
          </label>
        ))}
      </fieldset>
      <fieldset className="space-y-1.5">
        <legend className="text-xs font-medium text-foreground">Projects</legend>
        {props.projects.length === 0 ? (
          <p className="text-xs text-muted-foreground">Share a project above first.</p>
        ) : (
          props.projects.map((project) => (
            <label key={project.id} className="flex items-center gap-2 text-xs text-foreground">
              <Checkbox
                checked={props.selectedProjects.has(project.id)}
                onCheckedChange={(checked) =>
                  props.onProjectsChange(
                    toggle(props.selectedProjects, project.id, checked === true),
                  )
                }
              />
              <span className="truncate">{project.name}</span>
            </label>
          ))
        )}
      </fieldset>
    </div>
  );
}

/** Opens while an OAuth authorization request waits for a decision. */
export function PairingDialog(props: {
  state: AgentBridgeState;
  projects: ReadonlyArray<SharedProject>;
  onState: (state: AgentBridgeState) => void;
}) {
  const pending = props.state.pairing.pending;
  const [scopes, setScopes] = useState<Set<AgentBridgeScope>>(new Set());
  const [projects, setProjects] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    // Nothing is granted by default except what the client asked to read.
    setScopes(new Set(pending?.requestedScopes.filter((scope) => scope === "f5.read") ?? []));
    setProjects(new Set());
  }, [pending?.requestId, pending?.requestedScopes]);
  if (!pending) return null;
  const decide = async (approve: boolean) => {
    setBusy(true);
    try {
      props.onState(
        await ensureNativeApi().agentBridge.decideAuthorization({
          requestId: pending.requestId,
          approve,
          scopes: [...scopes],
          projectIds: [...projects].map((id) => ProjectId.makeUnsafe(id)),
        }),
      );
    } catch (error) {
      toastManager.add({
        type: "error",
        title: "Decision not saved",
        description: errorMessage(error),
      });
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open onOpenChange={(open) => !open && void decide(false)}>
      <DialogPopup className="max-w-md">
        <DialogHeader>
          <DialogTitle>Connect {pending.clientName}?</DialogTitle>
          <DialogDescription>
            Check that your browser shows the same code. Anyone holding this connection's credential
            can use what you grant.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel className="space-y-3">
          <p className="text-center font-mono text-2xl font-semibold tracking-[0.3em] text-foreground">
            {pending.matchCode}
          </p>
          <p className="text-xs text-muted-foreground">
            Returns to <span className="font-mono">{pending.redirectUri}</span>
          </p>
          <ScopeAndProjectPicker
            scopes={pending.requestedScopes}
            selectedScopes={scopes}
            onScopesChange={setScopes}
            projects={props.projects}
            selectedProjects={projects}
            onProjectsChange={setProjects}
          />
        </DialogPanel>
        <DialogFooter>
          <Button variant="outline" disabled={busy} onClick={() => void decide(false)}>
            Deny
          </Button>
          <Button disabled={busy || scopes.size === 0} onClick={() => void decide(true)}>
            Approve
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

export function ClientGrantDialog(props: {
  client: AgentBridgeClient | null;
  projects: ReadonlyArray<SharedProject>;
  onClose: () => void;
  onState: (state: AgentBridgeState) => void;
}) {
  const { client } = props;
  const [scopes, setScopes] = useState<Set<AgentBridgeScope>>(new Set());
  const [projects, setProjects] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    setScopes(new Set(client?.scopes ?? []));
    setProjects(new Set(client?.projectIds ?? []));
  }, [client]);
  if (!client) return null;
  const save = async () => {
    setBusy(true);
    try {
      props.onState(
        await ensureNativeApi().agentBridge.updateClientGrant({
          clientId: client.id,
          scopes: [...scopes],
          projectIds: [...projects].map((id) => ProjectId.makeUnsafe(id)),
        }),
      );
      props.onClose();
    } catch (error) {
      toastManager.add({
        type: "error",
        title: "Permissions not saved",
        description: errorMessage(error),
      });
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open onOpenChange={(open) => !open && props.onClose()}>
      <DialogPopup className="max-w-md">
        <DialogHeader>
          <DialogTitle>{client.name} permissions</DialogTitle>
          <DialogDescription>
            Changing permissions makes the client's in-progress task writes fail until it reads the
            task again.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <ScopeAndProjectPicker
            scopes={AGENT_BRIDGE_SCOPES}
            selectedScopes={scopes}
            onScopesChange={setScopes}
            projects={props.projects}
            selectedProjects={projects}
            onProjectsChange={setProjects}
          />
        </DialogPanel>
        <DialogFooter>
          <Button variant="outline" onClick={props.onClose}>
            Cancel
          </Button>
          <Button disabled={busy || scopes.size === 0} onClick={() => void save()}>
            Save
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

function remoteStatusLabel(state: AgentBridgeState): string {
  switch (state.remote.status) {
    case "running":
      return `Listening on 127.0.0.1:${state.remote.port} for ${state.remote.issuer}`;
    case "failed":
      return `Not running: ${state.remote.detail ?? "unknown error"}`;
    case "stopped":
      return "Off";
  }
}

/** Remote access for hosted agents through the user's own HTTPS tunnel. */
export function RemoteAccessSection(props: {
  settings: AgentBridgeSettings;
  state: AgentBridgeState | null;
  onSave: (remote: AgentBridgeSettings["remote"]) => void;
  onState: (state: AgentBridgeState) => void;
}) {
  const remote = props.settings.remote;
  const [port, setPort] = useState(remote.port === 0 ? "" : String(remote.port));
  const [publicUrl, setPublicUrl] = useState(remote.publicBaseUrl);
  const [redirects, setRedirects] = useState(remote.allowedRedirectUris.join("\n"));
  const [urlError, setUrlError] = useState<string | null>(null);
  useEffect(() => setPort(remote.port === 0 ? "" : String(remote.port)), [remote.port]);
  useEffect(() => setPublicUrl(remote.publicBaseUrl), [remote.publicBaseUrl]);
  useEffect(
    () => setRedirects(remote.allowedRedirectUris.join("\n")),
    [remote.allowedRedirectUris],
  );

  const savePort = () => {
    const value = Number(port);
    if (!Number.isInteger(value) || value < AGENT_BRIDGE_REMOTE_MIN_PORT || value > 65535) return;
    if (value !== remote.port) props.onSave({ ...remote, port: value });
  };
  const saveUrl = () => {
    if (publicUrl.trim() === "") {
      setUrlError(null);
      if (remote.publicBaseUrl !== "") props.onSave({ ...remote, publicBaseUrl: "" });
      return;
    }
    const canonical = canonicalizeAgentBridgePublicBaseUrl(publicUrl);
    if (!canonical) {
      setUrlError("Use an https origin with no path, for example https://f5.example.com.");
      return;
    }
    setUrlError(null);
    setPublicUrl(canonical);
    if (canonical !== remote.publicBaseUrl) props.onSave({ ...remote, publicBaseUrl: canonical });
  };
  const saveRedirects = () => {
    const next = redirects
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
    if (next.join("\n") !== remote.allowedRedirectUris.join("\n"))
      props.onSave({ ...remote, allowedRedirectUris: next });
  };
  const openWindow = async () => {
    try {
      props.onState(await ensureNativeApi().agentBridge.openPairingWindow());
    } catch (error) {
      toastManager.add({
        type: "error",
        title: "Could not start pairing",
        description: errorMessage(error),
      });
    }
  };

  const openUntil = props.state?.pairing.openUntil ?? null;
  const running = props.state?.remote.status === "running";
  return (
    <div className="space-y-2 border-b border-border py-3">
      <SettingsRow
        title="Remote access"
        description="For hosted agents such as a ChatGPT Dot. Needs your own HTTPS tunnel (for example cloudflared) to the port below; tunnel only that port. Changing the public URL signs every remote client out."
        control={
          <Switch
            checked={remote.enabled}
            aria-label="Enable remote access"
            onCheckedChange={(checked) => props.onSave({ ...remote, enabled: checked })}
          />
        }
      />
      {remote.enabled ? (
        <div className="space-y-2">
          <label className="block space-y-1 text-xs font-medium text-foreground">
            <span>Local port (1024–65535)</span>
            <Input
              inputMode="numeric"
              value={port}
              onChange={(event) => setPort(event.target.value)}
              onBlur={savePort}
            />
          </label>
          <label className="block space-y-1 text-xs font-medium text-foreground">
            <span>Public URL</span>
            <Input
              placeholder="https://f5.example.com"
              value={publicUrl}
              onChange={(event) => setPublicUrl(event.target.value)}
              onBlur={saveUrl}
            />
            {urlError ? (
              <span className="block font-normal text-destructive">{urlError}</span>
            ) : null}
          </label>
          <label className="block space-y-1 text-xs font-medium text-foreground">
            <span>Allowed redirect URIs (one per line, exact match)</span>
            <Textarea
              value={redirects}
              onChange={(event) => setRedirects(event.target.value)}
              onBlur={saveRedirects}
            />
          </label>
          {props.state ? (
            <p className="text-xs text-muted-foreground">{remoteStatusLabel(props.state)}</p>
          ) : null}
          <div className="flex items-center gap-2">
            <Button size="sm" disabled={!running} onClick={() => void openWindow()}>
              Connect a client
            </Button>
            {openUntil ? (
              <span className="text-xs text-muted-foreground">
                Waiting for a client until {new Date(openUntil).toLocaleTimeString()}. Add F5 in
                your agent now.
              </span>
            ) : null}
          </div>
          <p className="text-2xs text-muted-foreground">
            After connecting a ChatGPT Dot, ask it to monitor F5 events so it hears about new tasks.
          </p>
        </div>
      ) : null}
    </div>
  );
}
