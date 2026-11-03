import { useState } from "react";
import type { DesktopKeepAwakeBlockedReason } from "@t3tools/contracts";
import { useDesktopKeepAwake } from "../../hooks/useDesktopKeepAwake";
import { SettingsRow } from "./SettingsCard";
import { Button } from "../ui/button";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";

const REASONS: Record<DesktopKeepAwakeBlockedReason, string> = {
  "stale-override":
    "Sleep is still disabled from an earlier session. Run sudo pmset -a disablesleep 0.",
  "reset-failed": "Could not re-enable sleep. Retrying. You can run sudo pmset -a disablesleep 0.",
  "external-override": "Another app has already disabled sleep.",
  "external-change": "Sleep was re-enabled outside F5. Paused until keep-awake starts again.",
  thermal: "Paused: Mac is running hot.",
  "battery-low": "Paused: battery below 20%.",
  "battery-unknown": "Paused: battery level unavailable.",
  "permission-missing": "Set up is required.",
  "command-failed": "Could not change the sleep setting.",
  "blocker-failed": "Could not prevent idle sleep.",
};
const MODES = {
  off: "Off",
  agents: "While agents are working",
  always: "Always while F5 is open",
} as const;
export function KeepAwakeSettings() {
  const { state, bridge, accept } = useDesktopKeepAwake();
  const [error, setError] = useState<string | null>(null);
  if (!state || !bridge) return null;
  const mutate = (operation: ReturnType<typeof bridge.getState>) => {
    setError(null);
    void operation
      .then(accept)
      .catch((cause: unknown) =>
        setError(
          cause instanceof Error
            ? cause.message.includes("trusted user gesture")
              ? "Click again to confirm."
              : cause.message
            : "Could not update keep awake",
        ),
      );
  };
  const recovery =
    state.lid.blockedReason === "stale-override" ||
    (state.lid.engaged &&
      (state.lid.sleepDisabled !== 1 || state.lid.blockedReason === "reset-failed"));
  const status = recovery
    ? "Recovery required: sleep may still be disabled"
    : state.lid.engaged && !state.active
      ? "Releasing closed-lid keep awake…"
      : state.active
        ? state.busyThreadCount > 0
          ? "Awake: " + state.busyThreadCount + " agents working"
          : state.mode === "agents"
            ? "Awake until a few minutes after agents finish"
            : "Awake"
        : state.mode === "agents"
          ? "Waiting for agents"
          : "Off";
  return (
    <>
      <SettingsRow
        title="Keep computer awake"
        description={
          <>
            Prevents idle sleep. The display can still turn off. <span role="status">{status}</span>
          </>
        }
        control={
          <Select
            value={state.mode}
            onValueChange={(mode) => {
              if (mode === "off" || mode === "agents" || mode === "always")
                mutate(bridge.setPreferences({ mode }));
            }}
          >
            <SelectTrigger className="w-64" aria-label="Keep computer awake">
              <SelectValue>{MODES[state.mode]}</SelectValue>
            </SelectTrigger>
            <SelectPopup align="end">
              {Object.entries(MODES).map(([value, label]) => (
                <SelectItem key={value} value={value}>
                  {label}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        }
      />
      {state.lid.supported && (
        <>
          <SettingsRow
            title="Also when the lid is closed"
            description="Changes a system-wide sleep setting and uses battery. Keep your Mac ventilated."
            control={
              <Switch
                aria-label="Also when the lid is closed"
                checked={state.closedLid}
                disabled={state.mode === "off"}
                onCheckedChange={(closedLid) =>
                  mutate(bridge.setPreferences({ closedLid: Boolean(closedLid) }))
                }
              />
            }
          />
          {state.lid.permission === "missing" && (
            <SettingsRow
              title="Closed-lid permission"
              description="Needs a one-time administrator approval. Requires an admin account."
              control={
                <Button
                  variant="outline"
                  disabled={state.lid.pending}
                  onClick={() => mutate(bridge.installLidPermission())}
                >
                  Set up…
                </Button>
              }
            />
          )}
          {state.lid.ruleInstalledByF5 && (
            <SettingsRow
              title="Remove closed-lid permission"
              control={
                <Button
                  variant="outline"
                  disabled={state.lid.pending}
                  onClick={() => mutate(bridge.removeLidPermission())}
                >
                  Remove permission
                </Button>
              }
            />
          )}
        </>
      )}
      {(state.lid.blockedReason || error) && (
        <p role="status" className="px-4 py-2 text-sm text-muted-foreground">
          {error ?? REASONS[state.lid.blockedReason!]}
        </p>
      )}
    </>
  );
}
