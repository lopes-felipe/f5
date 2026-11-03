import { useEffect, useState } from "react";
import type { AlwaysAllowedIntegration, ChromeReadiness } from "@t3tools/contracts";
import { defaultInstanceIdForDriver, ProviderDriverKind } from "@t3tools/contracts";
import { INTEGRATION_DISCLOSURES } from "@t3tools/shared/providerIntegrationCertification";
import { useSettings, useUpdateSettings } from "../../hooks/useSettings";
import { readNativeApi } from "../../nativeApi";
import { Button } from "../ui/button";
import { Switch } from "../ui/switch";
import { SettingsRow } from "./SettingsCard";

const INTEGRATIONS = {
  claude: {
    driver: "claudeAgent",
    title: "Claude in Chrome",
    searchTarget: "browser.chrome",
    ariaLabel: "Let Claude use Google Chrome",
    summary: "Let Claude use your browser through the Claude in Chrome extension.",
    setting: "enableClaudeInChrome",
    disclosures: INTEGRATION_DISCLOSURES["claude-chrome"],
  },
  codex: {
    driver: "codex",
    title: "Codex Chrome control",
    searchTarget: "browser.codex-chrome",
    ariaLabel: "Let Codex use Google Chrome",
    summary: "Let Codex use Chrome through the ChatGPT app's extension. F5 brokers every call.",
    setting: "enableCodexChrome",
    disclosures: INTEGRATION_DISCLOSURES["codex-chrome"],
  },
} as const;

const ELIGIBILITY_LABEL: Record<ChromeReadiness["eligibility"], string> = {
  off: "Off",
  ready: "Ready",
  unavailable: "Unavailable",
  "recovery-required": "Waiting for earlier browser control to stop",
};

/** Enabled instances of one driver, default instance included. */
function useInstanceIds(driver: string): ReadonlyArray<{ id: string; label: string }> {
  const settings = useSettings();
  const instances = Object.entries(settings.providerInstances ?? {})
    .filter(([, instance]) => instance.driver === driver && instance.enabled)
    .map(([id, instance]) => ({ id, label: instance.displayName ?? id }));
  const defaultEnabled =
    settings.providerInstances?.[defaultInstanceIdForDriver(ProviderDriverKind.makeUnsafe(driver))]
      ?.enabled ??
    (settings.providers as Record<string, { enabled?: boolean } | undefined>)[driver]?.enabled;
  if (defaultEnabled && !instances.some((entry) => entry.id === driver))
    instances.unshift({ id: driver, label: "Default" });
  return instances;
}

/** Read-only preflight per instance; never spawns, writes or reads credentials. */
function useChromeReadiness(ids: ReadonlyArray<string>, enabled: boolean) {
  const [readiness, setReadiness] = useState<Record<string, ChromeReadiness | Error>>({});
  const key = ids.join("\0");
  useEffect(() => {
    const api = readNativeApi()?.chrome;
    if (!api) return;
    let stopped = false;
    void Promise.all(
      ids.map((id) =>
        api.getReadiness({ providerInstanceId: id }).then(
          (value) => [id, value] as const,
          (error: unknown) =>
            [id, error instanceof Error ? error : new Error("Readiness check failed.")] as const,
        ),
      ),
    ).then((entries) => {
      if (!stopped) setReadiness(Object.fromEntries(entries));
    });
    return () => {
      stopped = true;
    };
  }, [key, enabled]);
  return readiness;
}

const ALWAYS_ALLOWED = {
  claude: {
    integration: "claude-chrome",
    description:
      "Claude takes over the browser connection without asking, even when another Claude or F5 profile set it up. Revoke to be asked again.",
  },
  codex: {
    integration: "codex-chrome",
    description:
      "New Codex sessions use Chrome without asking. Revoke to be asked once per session again; sessions already running keep Chrome until they end.",
  },
} as const satisfies Record<
  keyof typeof INTEGRATIONS,
  { integration: AlwaysAllowedIntegration; description: string }
>;

/** "Always allow" kept by desktop main for this profile: Codex sessions, Claude setup. */
function AlwaysAllowRow({ provider }: { provider: keyof typeof INTEGRATIONS }) {
  const { integration, description } = ALWAYS_ALLOWED[provider];
  const bridge = window.desktopBridge?.computerAutomation;
  const [allowed, setAllowed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    let current = true;
    // Granted in main's dialog, possibly while Settings is open: read again on focus.
    const load = () =>
      void bridge
        ?.integrationConsents?.()
        .then((list) => current && setAllowed(list.includes(integration)))
        .catch(() => undefined);
    load();
    window.addEventListener("focus", load);
    return () => {
      current = false;
      window.removeEventListener("focus", load);
    };
  }, [bridge, integration]);
  if (!allowed || !bridge?.revokeIntegrationConsent) return null;
  const revoke = async () => {
    setBusy(true);
    setError("");
    try {
      await bridge.revokeIntegrationConsent?.(integration);
      setAllowed(false);
    } catch (cause) {
      // Electron prefixes errors thrown in main with the IPC channel.
      setError(
        cause instanceof Error
          ? cause.message.replace(/^Error invoking remote method '[^']*': (?:Error: )?/, "")
          : "F5 couldn't revoke Always allow.",
      );
    } finally {
      setBusy(false);
    }
  };
  return (
    <SettingsRow
      title="Always allowed for this profile"
      description={
        <>
          {description}
          {error ? (
            <span role="alert" className="block text-destructive-foreground">
              {error}
            </span>
          ) : null}
        </>
      }
      control={
        <Button size="sm" variant="outline" disabled={busy} onClick={() => void revoke()}>
          {busy ? "Revoking…" : "Revoke"}
        </Button>
      }
    />
  );
}

export function ChromeIntegrationRows({ provider }: { provider: keyof typeof INTEGRATIONS }) {
  const integration = INTEGRATIONS[provider];
  const settings = useSettings();
  const { updateSettings } = useUpdateSettings();
  const enabled = settings[integration.setting] ?? false;
  const instances = useInstanceIds(integration.driver);
  const readiness = useChromeReadiness(
    instances.map((entry) => entry.id),
    enabled,
  );
  // A closed certification gate is reported while off; the toggle can still be turned off.
  const gateClosed =
    instances.length > 0 &&
    instances.every((entry) => {
      const value = readiness[entry.id];
      return (
        value !== undefined &&
        !(value instanceof Error) &&
        value.eligibility === "off" &&
        value.reason
      );
    });
  return (
    <>
      <SettingsRow
        title={integration.title}
        searchTarget={integration.searchTarget}
        description={
          <span className="block space-y-1">
            <span className="block">{integration.summary}</span>
            {integration.disclosures.map((line) => (
              <span key={line} className="block">
                {line}
              </span>
            ))}
          </span>
        }
        control={
          <Switch
            aria-label={integration.ariaLabel}
            checked={enabled}
            disabled={!enabled && gateClosed}
            onCheckedChange={(checked) => updateSettings({ [integration.setting]: checked })}
          />
        }
      />
      {instances.map((entry) => {
        const value = readiness[entry.id];
        return (
          <SettingsRow
            key={entry.id}
            control={null}
            title={`${integration.title} · ${entry.label}`}
            description={
              value === undefined
                ? "Checking…"
                : value instanceof Error
                  ? value.message
                  : [ELIGIBILITY_LABEL[value.eligibility], value.reason].filter(Boolean).join(": ")
            }
          />
        );
      })}
      <AlwaysAllowRow provider={provider} />
    </>
  );
}
