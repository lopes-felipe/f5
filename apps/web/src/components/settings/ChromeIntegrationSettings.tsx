import { useEffect, useState } from "react";
import type { ChromeReadiness } from "@t3tools/contracts";
import { defaultInstanceIdForDriver, ProviderDriverKind } from "@t3tools/contracts";
import { INTEGRATION_DISCLOSURES } from "@t3tools/shared/providerIntegrationCertification";
import { useSettings, useUpdateSettings } from "../../hooks/useSettings";
import { readNativeApi } from "../../nativeApi";
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
    </>
  );
}
