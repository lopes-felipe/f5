import { useEffect, useState } from "react";
import type { ThreadId } from "@t3tools/contracts";
import { ensureNativeApi } from "~/nativeApi";
import { Button } from "./ui/button";

export function TranscriptRepairAction({
  threadId,
  canRepair,
}: {
  threadId: ThreadId;
  canRepair: boolean;
}) {
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
        if (!cancelled) setBackupId(result?.backupId);
      })
      .catch(() => {})
      .finally(() => {
        if (!cancelled) setLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, [threadId]);
  const run = async () => {
    setBusy(true);
    setMessage(undefined);
    try {
      const api = ensureNativeApi();
      if (backupId) {
        await api.server.undoClaudeTranscriptRepair({ threadId, backupId });
        setBackupId(undefined);
        setMessage("Transcript backup restored.");
      } else {
        const result = await api.server.repairClaudeTranscript({ threadId });
        setBackupId(result.backupId);
        setMessage(
          `Transcript repaired (${result.restoredMessages} entries restored). You can continue the thread.`,
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
      {canRepair || backupId ? (
        <Button size="sm" variant="outline" disabled={busy || !loaded} onClick={() => void run()}>
          {busy ? "Working…" : backupId ? "Undo transcript repair" : "Repair transcript"}
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
