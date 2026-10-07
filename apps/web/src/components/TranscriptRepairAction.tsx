import { useEffect, useState } from "react";
import type { ThreadId } from "@t3tools/contracts";
import { ensureNativeApi } from "~/nativeApi";
import { Button } from "./ui/button";

export function TranscriptRepairAction({
  threadId,
  refreshKey,
}: {
  threadId: ThreadId;
  refreshKey: string;
}) {
  const [canRepair, setCanRepair] = useState(false);
  const [backupId, setBackupId] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [message, setMessage] = useState<string>();
  useEffect(() => {
    let cancelled = false;
    setLoaded(false);
    setBackupId(undefined);
    setMessage(undefined);
    void ensureNativeApi()
      .server.getClaudeTranscriptRepair({ threadId })
      .then((result) => {
        if (!cancelled) {
          setBackupId(result?.backupId);
          setCanRepair(result?.canRepair ?? false);
        }
      })
      .catch((error) => {
        if (!cancelled) setMessage(error instanceof Error ? error.message : String(error));
      })
      .finally(() => {
        if (!cancelled) setLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, [threadId, refreshKey]);
  const run = async (action: "repair" | "undo") => {
    setBusy(true);
    setMessage(undefined);
    try {
      const api = ensureNativeApi();
      if (action === "undo" && backupId) {
        await api.server.undoClaudeTranscriptRepair({ threadId, backupId });
        const state = await api.server.getClaudeTranscriptRepair({ threadId });
        setBackupId(state?.backupId);
        setCanRepair(state?.canRepair ?? false);
        setMessage("Transcript backup restored.");
      } else {
        const result = await api.server.repairClaudeTranscript({ threadId });
        setBackupId(result.backupId);
        setCanRepair(false);
        setMessage(
          result.status === "validated"
            ? "Transcript revalidated. You can continue the thread."
            : `Transcript repaired (${result.restoredMessages} entries restored). You can continue the thread.`,
        );
      }
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };
  if (!canRepair && !backupId && !message) return null;
  return (
    <div className="flex flex-col gap-1">
      {canRepair ? (
        <Button
          size="sm"
          variant="outline"
          disabled={busy || !loaded}
          onClick={() => void run("repair")}
        >
          {busy ? "Working…" : "Repair transcript"}
        </Button>
      ) : null}
      {backupId ? (
        <Button
          size="sm"
          variant="outline"
          disabled={busy || !loaded}
          onClick={() => void run("undo")}
        >
          Undo transcript repair
        </Button>
      ) : null}
      {message ? (
        <p className="text-xs" role="status">
          {message}
        </p>
      ) : null}
    </div>
  );
}
