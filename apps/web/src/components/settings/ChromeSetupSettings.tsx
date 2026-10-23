import { useEffect, useState } from "react";
import type {
  ChromeNativeHostRestoreResult,
  ChromeNativeHostTransactionSummary,
} from "@t3tools/contracts";
import { readNativeApi } from "../../nativeApi";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";

const PROVIDER_LABEL = { claude: "Claude", codex: "Codex" } as const;
const STATE_LABEL: Record<ChromeNativeHostTransactionSummary["state"], string> = {
  approved: "Approved, not launched",
  launched: "In use",
  restoring: "Restore interrupted",
  "partially-restored": "Partly restored",
  restored: "Restored",
  "recovery-required": "Needs attention",
};

/** Plain-language outcome of one restore; nothing is claimed beyond what the server reported. */
export function chromeRestoreMessage(result: ChromeNativeHostRestoreResult): string {
  if (result.busy)
    return "Stop browser/computer control in the other F5 profile, then retry. Nothing was changed.";
  if (result.blockingTransactionId)
    return "A newer browser setup uses the same files. Restore it first. Nothing was changed.";
  if (result.failure) return `${result.failure} No files were changed.`;
  const parts = [
    `Restored ${result.restored.length} file${result.restored.length === 1 ? "" : "s"}.`,
  ];
  if (result.skipped.length)
    parts.push(
      `Kept ${result.skipped.length} that changed outside F5 since setup; restore again after closing other Claude Code sessions to retry.`,
    );
  if (result.unresolved?.length)
    parts.push(`${result.unresolved.length} couldn't be verified and were left untouched.`);
  if (!result.skipped.length && !result.unresolved?.length)
    return "Original browser setup restored.";
  return parts.join(" ");
}

/** Newer setups that block older ones come first, so restore order is top to bottom. */
export function orderChromeSetups(
  entries: ReadonlyArray<ChromeNativeHostTransactionSummary>,
): ReadonlyArray<ChromeNativeHostTransactionSummary> {
  return [...entries].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export function ChromeSetupSettings() {
  const [transactions, setTransactions] = useState<
    ReadonlyArray<ChromeNativeHostTransactionSummary>
  >([]);
  const [busy, setBusy] = useState<string>();
  const [message, setMessage] = useState("");
  const api = readNativeApi()?.chrome;
  const refresh = async () => {
    if (!api) return;
    const results = await Promise.all([
      api.listTransactions("claude"),
      api.listTransactions("codex"),
    ]);
    setTransactions(
      orderChromeSetups(results.flat().filter((entry) => entry.state !== "restored")),
    );
  };
  useEffect(() => {
    void refresh().catch(() => setMessage("Browser setup history could not be read. Retry."));
  }, [api]);
  const restore = async (entry: ChromeNativeHostTransactionSummary) => {
    if (!api || busy) return;
    setBusy(entry.id);
    setMessage("");
    try {
      setMessage(chromeRestoreMessage(await api.restoreNativeHost(entry.provider, entry.id)));
    } catch (error) {
      setMessage(
        error instanceof Error ? error.message : "Browser setup could not be restored. Retry.",
      );
    } finally {
      setBusy(undefined);
      await refresh().catch(() => undefined);
    }
  };
  if (!transactions.length && !message) return null;
  return (
    <div
      className="space-y-2 border-t pt-3 text-sm"
      data-settings-search-target="browser.chrome-setup"
    >
      <p className="font-medium">Browser integration setup history</p>
      <p className="text-muted-foreground text-xs">
        Restore stops this profile's sessions that use the integration, then puts back the browser
        files from before F5 launched it. Files changed outside F5 are kept.
      </p>
      {transactions.map((entry) => (
        <div key={entry.id} className="flex items-center justify-between gap-2">
          <span className="min-w-0 space-y-0.5">
            <span className="flex flex-wrap items-center gap-1.5">
              {PROVIDER_LABEL[entry.provider]} · {STATE_LABEL[entry.state]}
              {entry.stale ? <Badge variant="outline">Restore recommended</Badge> : null}
              {entry.legacy ? <Badge variant="outline">Older F5 setup</Badge> : null}
            </span>
            <span className="block break-all text-muted-foreground text-xs">
              {entry.targetPath} · {new Date(entry.createdAt).toLocaleString()}
            </span>
            {entry.blockedBy ? (
              <span className="block text-muted-foreground text-xs">
                Restore the newer setup above first.
              </span>
            ) : null}
            {entry.unresolved?.length ? (
              <span className="block text-muted-foreground text-xs">
                {entry.unresolved.length} file{entry.unresolved.length === 1 ? "" : "s"} left as
                found.
              </span>
            ) : null}
          </span>
          <Button
            size="sm"
            variant="outline"
            disabled={busy !== undefined || entry.blockedBy !== undefined}
            onClick={() => void restore(entry)}
          >
            {busy === entry.id
              ? "Restoring…"
              : entry.state === "partially-restored"
                ? "Retry restore"
                : "Restore"}
          </Button>
        </div>
      ))}
      {message ? <p role="status">{message}</p> : null}
    </div>
  );
}
