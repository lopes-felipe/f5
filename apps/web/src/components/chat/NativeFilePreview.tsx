import { useState } from "react";
import type { NativeFileRewindPreview, ThreadId } from "@t3tools/contracts";
import { readNativeApi } from "../../nativeApi";
export function NativeFilePreview(props: {
  threadId: ThreadId;
  turnId: string;
  generation: number;
  filePreview?: boolean;
  nativeFork?: boolean;
}) {
  const [preview, setPreview] = useState<NativeFileRewindPreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const load = async () => {
    const api = readNativeApi()?.nativeOperations;
    if (!api?.inspect) {
      setError("Native file preview API is unavailable.");
      return;
    }
    setLoading(true);
    setError(null);
    try {
      setPreview(
        (await api.inspect({
          threadId: props.threadId,
          generation: props.generation,
          kind: "filePreview",
          nativeId: props.turnId,
        })) as NativeFileRewindPreview,
      );
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "File preview is unavailable.");
    } finally {
      setLoading(false);
    }
  };
  const fork = async () => {
    const api = readNativeApi()?.nativeOperations;
    if (!api?.fork) {
      setError("Native fork API is unavailable.");
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const record = await api.fork({
        threadId: props.threadId,
        generation: props.generation,
        operationId: crypto.randomUUID(),
        beforeTurnId: props.turnId,
      });
      if (!["requested", "dispatched", "running", "completed"].includes(record.state))
        setError(record?.error ?? "Fork outcome needs reconciliation.");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Fork could not start.");
    } finally {
      setLoading(false);
    }
  };
  return (
    <span>
      {props.nativeFork && (
        <button type="button" disabled={loading} onClick={() => void fork()}>
          Fork from here (branch-tip workspace)
        </button>
      )}
      {props.filePreview && (
        <button type="button" disabled={loading} onClick={() => void load()}>
          Files changed since here
        </button>
      )}
      {preview && (
        <span className="block">
          {preview.canRewind
            ? `${preview.filesChanged?.join(", ") || "No tracked changes"} · +${preview.insertions ?? 0} −${preview.deletions ?? 0}`
            : (preview.error ?? "No native checkpoint is available.")}
        </span>
      )}
      {error && (
        <span role="alert" className="block">
          {error}
        </span>
      )}
    </span>
  );
}
