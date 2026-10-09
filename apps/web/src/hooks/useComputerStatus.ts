import { useEffect, useState } from "react";
import type { ComputerAutomationBackendStatus } from "@t3tools/contracts";

export function computerSettingsCanEnable(
  status: ComputerAutomationBackendStatus | undefined,
): boolean {
  return (
    !!status &&
    (status.available || ["missing-permissions", "monitor-unhealthy"].includes(status.reason))
  );
}
export function useComputerStatus() {
  const bridge = window.desktopBridge?.computerAutomation;
  const [status, setStatus] = useState<ComputerAutomationBackendStatus>();
  const [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    void bridge
      ?.status()
      .then((value) => {
        if (active) setStatus(value);
      })
      .catch(() => {
        if (active) setError("Could not read computer status.");
      });
    const off = bridge?.onStatus((value) => {
      if (active) setStatus(value);
    });
    return () => {
      active = false;
      off?.();
    };
  }, [bridge]);
  return { bridge, status, setStatus, error, setError };
}
