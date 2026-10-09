import { useComputerStatus, computerSettingsCanEnable } from "../../hooks/useComputerStatus";
import { useSettings, useUpdateSettings } from "../../hooks/useSettings";
import { Button } from "../ui/button";
import { Select, SelectTrigger, SelectValue, SelectPopup, SelectItem } from "../ui/select";
import { Switch } from "../ui/switch";
import { SettingsRow } from "./SettingsCard";
export function ComputerSettings() {
  const settings = useSettings();
  const { updateSettings } = useUpdateSettings();
  const { bridge, status, setStatus, error, setError } = useComputerStatus();
  const run = (action: () => Promise<unknown>) => {
    setError("");
    void action().catch(() => setError("Could not update computer control."));
  };
  return (
    <>
      <SettingsRow
        title="Computer use"
        description="Let Claude and Codex see and control apps you approve. Press ⌃⌘Esc (Ctrl+Alt+Shift+F12 on Windows) to stop."
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
                ? "F5 computer control ready"
                : `${status.reason}${status.detail ? `: ${status.detail}` : ""}`
        }
        control={
          status &&
          !status.available &&
          ["helper-crashed", "monitor-unhealthy", "helper-missing"].includes(status.reason) ? (
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
        description="Claude and Codex use F5 computer control while their built-in consent, veto, and profile isolation gates are awaiting certification."
        control={
          <Select
            value={settings.computerUseBackend}
            onValueChange={(value) => {
              if (value === "auto" || value === "f5") updateSettings({ computerUseBackend: value });
            }}
          >
            <SelectTrigger className="w-64" aria-label="Computer backend">
              <SelectValue>
                {settings.computerUseBackend === "f5" ? "F5 only" : "Automatic"}
              </SelectValue>
            </SelectTrigger>
            <SelectPopup>
              <SelectItem value="auto">Automatic (built-in when available)</SelectItem>
              <SelectItem value="f5">F5 only</SelectItem>
            </SelectPopup>
          </Select>
        }
      />
      {error ? <p role="alert">{error}</p> : null}
    </>
  );
}
