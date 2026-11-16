import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { desktopIpcErrorMessage } from "../../lib/desktopIpcError";
import { Button } from "../ui/button";
import { SettingsRow } from "./SettingsCard";

export const consentError = desktopIpcErrorMessage;

/** Native dialogs may change policy while Settings is open. Ignore stale async loads. */
export function useConsentList<T>(load: () => Promise<ReadonlyArray<T>>) {
  const [entries, setEntries] = useState<ReadonlyArray<T>>([]);
  const [error, setError] = useState("");
  const revision = useRef(0);
  const refresh = useCallback(async () => {
    const current = ++revision.current;
    try {
      const next = await load();
      if (current === revision.current) {
        setEntries(next);
        setError("");
      }
    } catch (cause) {
      if (current === revision.current)
        setError(consentError(cause, "Could not read remembered permissions."));
    }
  }, [load]);
  useEffect(() => {
    void refresh();
    const focus = () => void refresh();
    window.addEventListener("focus", focus);
    return () => {
      ++revision.current;
      window.removeEventListener("focus", focus);
    };
  }, [refresh]);
  return { entries, error, refresh };
}

export function RevocableConsentRow({
  title,
  description,
  revoke,
  refreshed,
}: {
  title: string;
  description: ReactNode;
  revoke?: () => Promise<void>;
  refreshed?: () => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const run = async () => {
    if (!revoke || busy) return;
    setBusy(true);
    setError("");
    try {
      await revoke();
      await refreshed?.();
    } catch (cause) {
      setError(consentError(cause, "F5 couldn't revoke this permission."));
    } finally {
      setBusy(false);
    }
  };
  return (
    <SettingsRow
      title={title}
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
        revoke ? (
          <Button size="sm" variant="outline" disabled={busy} onClick={() => void run()}>
            {busy ? "Revoking…" : "Revoke"}
          </Button>
        ) : null
      }
    />
  );
}
