import { useEffect, useState } from "react";
import type { ChromeNativeHostTransactionSummary } from "@t3tools/contracts";
import { readNativeApi } from "../../nativeApi";
import { Button } from "../ui/button";

export function ChromeSetupSettings() {
  const [transactions, setTransactions] = useState<
    ReadonlyArray<ChromeNativeHostTransactionSummary>
  >([]);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const api = readNativeApi()?.chrome;
  const refresh = async () => {
    if (!api) return;
    const results = await Promise.all([
      api.listTransactions("claude"),
      api.listTransactions("codex"),
    ]);
    setTransactions(results.flat().filter((entry) => entry.state !== "restored"));
  };
  useEffect(() => {
    void refresh().catch(() => setMessage("Browser setup history could not be read."));
  }, [api]);
  const restore = async (entry: ChromeNativeHostTransactionSummary) => {
    if (!api || busy) return;
    setBusy(true);
    setMessage("");
    try {
      const result = await api.restoreNativeHost(entry.provider, entry.id);
      setMessage(
        result.skipped.length
          ? `Restored ${result.restored.length} registrations; skipped ${result.skipped.length} that changed or were not replaced.`
          : "Original browser setup restored.",
      );
      await refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Browser setup could not be restored.");
    } finally {
      setBusy(false);
    }
  };
  if (!transactions.length && !message) return null;
  return (
    <div className="space-y-2 border-t pt-3 text-sm">
      <p className="font-medium">Browser integration setup history</p>
      <p>
        Restore stops this profile's sessions using the integration. Registrations changed outside
        F5 are preserved.
      </p>
      {transactions.map((entry) => (
        <div key={entry.id} className="flex items-center justify-between gap-2">
          <span className="min-w-0 break-all">
            {entry.provider} · {entry.targetPath}
          </span>
          <Button size="sm" variant="outline" disabled={busy} onClick={() => void restore(entry)}>
            Restore
          </Button>
        </div>
      ))}
      {message ? <p role="status">{message}</p> : null}
    </div>
  );
}
