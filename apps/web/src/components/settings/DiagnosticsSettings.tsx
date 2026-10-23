import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { serverConfigQueryOptions } from "../../lib/serverReactQuery";
import { useSettingsRouteContext } from "./SettingsRouteContext";
import { SettingsCard, SettingsRow } from "./SettingsCard";
import { Button } from "../ui/button";
import { Input } from "../ui/input";

export function DiagnosticsSettings() {
  const { settings, updateSettings } = useSettingsRouteContext();
  const config = useQuery(serverConfigQueryOptions());
  const [name, setName] = useState("");
  const [value, setValue] = useState("");
  const headers = settings.observability.otlpHeaders ?? [];
  return (
    <SettingsCard
      title="Diagnostics"
      description="Export traces and metrics to your OpenTelemetry collector. Changes take effect after restarting F5."
    >
      {(["traces", "metrics"] as const).map((kind) => {
        const key = kind === "traces" ? "otlpTracesUrl" : "otlpMetricsUrl";
        const effective = config.data?.diagnostics?.[kind];
        return (
          <SettingsRow
            key={kind}
            title={`${kind === "traces" ? "Traces" : "Metrics"} URL`}
            description={
              effective
                ? `Source: ${effective.source}${effective.endpoint ? ` · ${effective.endpoint}` : ""}`
                : "Leave blank to use the environment configuration."
            }
            control={
              <Input
                aria-label={`${kind} collector URL`}
                type="url"
                key={settings.observability[key]}
                defaultValue={settings.observability[key]}
                placeholder="http://localhost:4318/v1/…"
                onBlur={(event) => {
                  const url = event.target.value.trim();
                  if (url !== settings.observability[key])
                    updateSettings({ observability: { ...settings.observability, [key]: url } });
                }}
              />
            }
          />
        );
      })}
      <div className="space-y-2 p-4">
        <p className="text-sm font-medium">Collector headers</p>
        <p className="text-xs text-muted-foreground">
          Values are stored securely and are hidden after saving.
        </p>
        {headers.map((header, index) => (
          <div
            key={`${header.name}-${index}`}
            className="flex items-center justify-between gap-2 text-sm"
          >
            <span>{header.name}: ••••••••</span>
            <Button
              size="xs"
              variant="outline"
              aria-label={`Remove ${header.name} header`}
              onClick={() =>
                updateSettings({
                  observability: {
                    ...settings.observability,
                    otlpHeaders: headers.filter((_, at) => at !== index),
                  },
                })
              }
            >
              Remove
            </Button>
          </div>
        ))}
        <form
          className="flex gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            if (!name.trim()) return;
            updateSettings({
              observability: {
                ...settings.observability,
                otlpHeaders: [
                  ...headers.filter(
                    (header) => header.name.toLowerCase() !== name.trim().toLowerCase(),
                  ),
                  { name: name.trim(), value },
                ],
              },
            });
            setName("");
            setValue("");
          }}
        >
          <Input
            aria-label="Collector header name"
            placeholder="Authorization"
            required
            pattern="[!#$%&'*+.^_`|~0-9a-zA-Z-]+"
            value={name}
            onChange={(event) => setName(event.target.value)}
            maxLength={128}
          />
          <Input
            aria-label="Collector header value"
            type="password"
            value={value}
            onChange={(event) => setValue(event.target.value)}
            maxLength={4096}
            autoComplete="off"
          />
          <Button type="submit" size="sm" disabled={headers.length >= 100}>
            Save header
          </Button>
        </form>
      </div>
    </SettingsCard>
  );
}
