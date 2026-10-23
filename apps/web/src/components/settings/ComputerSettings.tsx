import type { Thread } from "../../types";
import { useStore } from "../../store";
import { readRuntimeConfiguredPayload } from "@t3tools/shared/orchestrationActivityPayload";
import type { RuntimeAgentBrowserCapabilities } from "@t3tools/contracts";
import { defaultInstanceIdForDriver, ProviderDriverKind } from "@t3tools/contracts";
import {
  AGENT_AUTOMATION_SUPPORT,
  COMPUTER_AGENT_DISPLAY,
  COMPUTER_UNAVAILABLE_LABEL,
  computerAgentProviderFor,
} from "@t3tools/shared/agentAutomationSupport";
import type { ProviderKind } from "@t3tools/contracts";
import { COMPUTER_STOP_SHORTCUT_LABEL } from "../computerControls";
import type {
  ComputerAutomationBackendStatus,
  ComputerBackgroundUnavailableReason,
} from "@t3tools/contracts";
import { useComputerStatus, computerSettingsCanEnable } from "../../hooks/useComputerStatus";
import { useSettings, useUpdateSettings } from "../../hooks/useSettings";
import { Button } from "../ui/button";
import { Select, SelectTrigger, SelectValue, SelectPopup, SelectItem } from "../ui/select";
import { Switch } from "../ui/switch";
import { SettingsRow } from "./SettingsCard";
const BACKGROUND_UNAVAILABLE: Record<ComputerBackgroundUnavailableReason, string> = {
  "unsupported-platform": "Background control is macOS only.",
  "peer-capability": "This F5 build or helper does not support background control.",
  "preview-off": "Background control is not enabled in this build yet.",
  permissions: "Grant computer control permissions first.",
  "monitor-unhealthy": "The input monitor is unavailable; restart F5 or retry the helper.",
};
/** Background needs the F5 helper's negotiated capability; built-in backends stay foreground. */
export function backgroundUnavailableReason(
  status: ComputerAutomationBackendStatus | null | undefined,
  bridged = true,
): string | undefined {
  if (!bridged) return "Choose background on the computer running F5.";
  if (!status) return "Checking…";
  if (!status.available) return BACKGROUND_UNAVAILABLE.permissions;
  if (!status.background) return BACKGROUND_UNAVAILABLE["peer-capability"];
  if (status.background.available) return undefined;
  return BACKGROUND_UNAVAILABLE[status.background.reason ?? "peer-capability"];
}
export function computerExecutionModeDescription(
  mode: "foreground" | "background",
  unavailable: string | undefined,
): string {
  const base =
    "Foreground uses your mouse and keyboard. Background lets each agent act inside one approved app without moving your pointer or focus, using F5 computer control only.";
  if (mode === "background" && unavailable)
    return `${base} Background is selected but unavailable: ${unavailable} Agents get an error until you switch to foreground.`;
  return unavailable && mode === "foreground" ? `${base} ${unavailable}` : base;
}
export function computerPasswordMaskingDescription(
  status: ComputerAutomationBackendStatus | undefined,
): string {
  const description =
    "Fast mode improves screenshot performance. Password fields Chrome omits from accessibility search may appear in screenshots sent to your model.";
  return status?.available && status.passwordMaskingSupported
    ? description
    : `${description} Selecting a masking mode requires an updated macOS helper. Existing captures use their platform's behavior; password masking is Legacy / unknown.`;
}
const configuredActivityCache = new WeakMap<
  Thread["activities"],
  { at: string; value: RuntimeAgentBrowserCapabilities } | null
>();
function latestConfigured(activities: Thread["activities"]) {
  if (configuredActivityCache.has(activities)) return configuredActivityCache.get(activities)!;
  for (let index = activities.length - 1; index >= 0; --index) {
    const activity = activities[index]!;
    if (activity.kind !== "runtime.configured") continue;
    const value = readRuntimeConfiguredPayload(activity.payload)?.agentBrowser;
    if (!value) continue;
    const entry = { at: activity.createdAt, value };
    configuredActivityCache.set(activities, entry);
    return entry;
  }
  configuredActivityCache.set(activities, null);
  return null;
}
const providerLabel = (kind: ProviderKind) => {
  const provider = computerAgentProviderFor(kind);
  return provider
    ? COMPUTER_AGENT_DISPLAY[provider].label
    : kind === "opencode"
      ? "OpenCode"
      : "Muse";
};
export function ComputerSettings() {
  const settings = useSettings();
  const { updateSettings } = useUpdateSettings();
  const { bridge, status, setStatus, error, setError } = useComputerStatus();
  const enabledProviders = [
    ...new Set([
      ...Object.entries(settings.providers).flatMap(([kind, config]) =>
        (settings.providerInstances?.[
          defaultInstanceIdForDriver(ProviderDriverKind.makeUnsafe(kind))
        ]?.enabled ?? config.enabled)
          ? [kind as ProviderKind]
          : [],
      ),
      ...Object.values(settings.providerInstances ?? {}).flatMap((instance) =>
        instance.enabled && instance.driver in AGENT_AUTOMATION_SUPPORT
          ? [instance.driver as ProviderKind]
          : [],
      ),
    ]),
  ];
  // Only a changed configuration summary re-renders settings during streaming activity.
  const readinessJson = useStore((store) => {
    const latest: Record<string, { at: string; value: RuntimeAgentBrowserCapabilities }> = {};
    for (const thread of store.threads) {
      const provider = thread.session?.provider;
      if (!provider || thread.session?.status === "closed") continue;
      const entry = latestConfigured(thread.activities);
      if (entry && (!latest[provider] || entry.at > latest[provider].at)) latest[provider] = entry;
    }
    return JSON.stringify(
      Object.fromEntries(
        Object.entries(latest)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([kind, entry]) => [kind, entry.value]),
      ),
    );
  });
  const readiness = JSON.parse(readinessJson) as Record<
    string,
    RuntimeAgentBrowserCapabilities | undefined
  >;
  const liveEntries = enabledProviders.flatMap((kind) => {
    const provider = computerAgentProviderFor(kind);
    const label = provider
      ? COMPUTER_AGENT_DISPLAY[provider].label
      : kind === "opencode"
        ? "OpenCode"
        : "Muse";
    const entry = readiness[kind];
    return entry
      ? [
          `${label}: ${entry.computerUse?.detail ?? entry.computerUse?.state ?? AGENT_AUTOMATION_SUPPORT[kind].computer.state}`,
        ]
      : [];
  });
  const backgroundUnavailable = backgroundUnavailableReason(status, !!bridge);
  const run = (action: () => Promise<unknown>) => {
    setError("");
    void action().catch(() => setError("Could not update computer control."));
  };
  return (
    <>
      <SettingsRow
        title="Computer use (preview)"
        description={`Opt-in macOS preview: let supported agents (see Agent support) see and control apps you approve. Signed-build safety certification is pending. Press ${COMPUTER_STOP_SHORTCUT_LABEL} to stop; your input pauses control. Project approvals expire when F5 closes. Windows remains unavailable.`}
        control={
          <Switch
            aria-label="Let agents control this computer"
            checked={settings.enableAgentComputerUse}
            disabled={!settings.enableAgentComputerUse && !computerSettingsCanEnable(status)}
            onCheckedChange={(checked) => updateSettings({ enableAgentComputerUse: checked })}
          />
        }
      />
      <SettingsRow
        title="Computer status"
        description={
          !bridge
            ? "Answer access requests on the computer running F5."
            : !status
              ? "Checking…"
              : status.available
                ? "F5 computer control preview ready"
                : `${COMPUTER_UNAVAILABLE_LABEL[status.reason]}${status.detail ? `: ${status.detail}` : ""}`
        }
        control={
          status &&
          !status.available &&
          ["helper-crashed", "monitor-unhealthy"].includes(status.reason) ? (
            <Button
              size="xs"
              variant="outline"
              onClick={() =>
                run(async () => {
                  await bridge?.retryHelper();
                  const next = await bridge?.status();
                  if (next) setStatus(next);
                })
              }
            >
              Retry
            </Button>
          ) : null
        }
      />
      {status && !status.available && status.reason === "missing-permissions"
        ? status.missing?.map((kind) => (
            <SettingsRow
              key={kind}
              title={kind === "screen-recording" ? "Screen Recording" : "Accessibility"}
              description="Required for computer control."
              control={
                <Button
                  size="xs"
                  variant="outline"
                  onClick={() => run(async () => bridge?.openPermissionSettings(kind))}
                >
                  Open System Settings
                </Button>
              }
            />
          ))
        : null}
      <SettingsRow
        title="Backend"
        description={
          settings.computerUseExecutionMode === "background"
            ? "Background execution uses F5 computer control only; switch to foreground to choose another backend."
            : "Claude and Codex use F5 computer control while their built-in consent, veto, and profile isolation gates are awaiting certification."
        }
        control={
          <Select
            disabled={settings.computerUseExecutionMode === "background"}
            value={
              settings.computerUseExecutionMode === "background"
                ? "f5"
                : settings.computerUseBackend
            }
            onValueChange={(value) => {
              if (value === "auto" || value === "f5") updateSettings({ computerUseBackend: value });
            }}
          >
            <SelectTrigger className="w-64" aria-label="Computer backend">
              <SelectValue>
                {settings.computerUseBackend === "f5" ||
                settings.computerUseExecutionMode === "background"
                  ? "F5 only"
                  : "Automatic"}
              </SelectValue>
            </SelectTrigger>
            <SelectPopup>
              <SelectItem value="auto">Automatic (built-in when available)</SelectItem>
              <SelectItem value="f5">F5 only</SelectItem>
            </SelectPopup>
          </Select>
        }
      />
      <SettingsRow
        title="Execution mode"
        description={computerExecutionModeDescription(
          settings.computerUseExecutionMode,
          backgroundUnavailable,
        )}
        control={
          <Select
            value={settings.computerUseExecutionMode}
            onValueChange={(value) => {
              if (value === "foreground" || value === "background")
                updateSettings({ computerUseExecutionMode: value });
            }}
          >
            <SelectTrigger className="w-64" aria-label="Computer execution mode">
              <SelectValue>
                {settings.computerUseExecutionMode === "background"
                  ? "Background (alongside you)"
                  : "Foreground"}
              </SelectValue>
            </SelectTrigger>
            <SelectPopup>
              <SelectItem value="foreground">Foreground</SelectItem>
              <SelectItem
                value="background"
                disabled={
                  settings.computerUseExecutionMode !== "background" &&
                  backgroundUnavailable !== undefined
                }
              >
                Background (alongside you)
              </SelectItem>
            </SelectPopup>
          </Select>
        }
      />
      <SettingsRow
        control={null}
        title="Policy"
        description={
          settings.enableAgentComputerUse
            ? "Computer use is on; each app still needs approval."
            : "Computer use is off."
        }
      />
      <SettingsRow
        title="Screenshot password masking"
        description={computerPasswordMaskingDescription(status)}
        control={
          <Select
            value={settings.computerUsePasswordMasking}
            onValueChange={(value) => {
              if (value === "fast" || value === "conservative")
                updateSettings({ computerUsePasswordMasking: value });
            }}
          >
            <SelectTrigger className="w-72" aria-label="Screenshot password masking">
              <SelectValue>
                {settings.computerUsePasswordMasking === "fast"
                  ? "Fast — best effort"
                  : "Conservative — inspect the full tree"}
              </SelectValue>
            </SelectTrigger>
            <SelectPopup>
              <SelectItem value="fast">Fast — best effort</SelectItem>
              <SelectItem value="conservative">Conservative — inspect the full tree</SelectItem>
            </SelectPopup>
          </Select>
        }
      />
      <SettingsRow
        control={null}
        title="Requested and effective mode"
        description={`Requested: ${settings.computerUseExecutionMode}. Effective: ${!settings.enableAgentComputerUse ? "off" : !status?.available ? "unavailable" : settings.computerUseExecutionMode === "background" && backgroundUnavailable ? "unavailable" : settings.computerUseExecutionMode}.`}
      />
      <SettingsRow
        control={null}
        title="Harness compatibility"
        description={
          liveEntries.join(" · ") ||
          "Start a supported agent session to check its live compatibility."
        }
      />
      <SettingsRow
        control={null}
        title="Catalog installation"
        description={
          enabledProviders
            .map((kind) => {
              const entry = readiness[kind];
              return `${providerLabel(kind)}: ${!entry ? "no active session report" : entry.computer?.installed ? "computer catalog installed" : entry.preview?.installed ? "preview catalog installed; computer catalog unavailable" : "no F5 catalog installed"}`;
            })
            .join(" · ") || "No enabled agents"
        }
      />
      <SettingsRow
        control={null}
        title="Desktop and helper"
        description={
          !status
            ? "Checking…"
            : status.available
              ? "Connected and ready"
              : COMPUTER_UNAVAILABLE_LABEL[status.reason]
        }
      />
      <SettingsRow
        control={null}
        title="Permissions"
        description={
          status?.available
            ? "Granted"
            : status && !status.available && status.reason === "missing-permissions"
              ? status.missing?.join(", ")
              : "Unavailable until the host is ready"
        }
      />
      <SettingsRow
        control={null}
        title="Native backend fallback"
        description={
          enabledProviders
            .map((kind) => {
              const selection = readiness[kind]?.computerUse;
              return `${providerLabel(kind)}: ${!selection ? "no active session report" : selection.backend === "native" ? `F5 native (${selection.detail ?? selection.state})` : (selection.detail ?? selection.state)}`;
            })
            .join(" · ") || "No enabled agents"
        }
      />
      <div role="group" aria-label="Agent support">
        <h3 className="font-medium text-sm">Agent support</h3>
        {enabledProviders.map((kind) => {
          const entry = AGENT_AUTOMATION_SUPPORT[kind];
          const provider = computerAgentProviderFor(kind);
          const label = provider
            ? COMPUTER_AGENT_DISPLAY[provider].label
            : kind === "opencode"
              ? "OpenCode"
              : "Muse";
          return (
            <div key={kind}>
              <SettingsRow
                control={null}
                title={`${label}: Preview ${entry.preview.state} · Computer ${entry.computer.state}`}
                description={[
                  entry.preview.reason,
                  entry.computer.reason,
                  entry.builtin ? `Built-in: ${entry.builtin}` : undefined,
                ]
                  .filter(Boolean)
                  .join(" · ")}
              />
              {kind === "claudeAgent" && readiness.claudeAgent?.chrome ? (
                <SettingsRow
                  control={null}
                  title={`Claude in Chrome: ${readiness.claudeAgent.chrome.state}`}
                  description={
                    readiness.claudeAgent.chrome.detail ??
                    "Per-agent readiness is shown under Browser › Agent access."
                  }
                />
              ) : null}
            </div>
          );
        })}
        <p className="text-muted-foreground text-xs">
          Harness compatibility and catalog installation are reported in each session's tool
          configuration. Catalogs enforce live policy on every call.
        </p>
      </div>
      {error ? <p role="alert">{error}</p> : null}
    </>
  );
}
