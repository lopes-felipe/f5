import { useEffect, useState } from "react";
import type { ThreadId } from "@t3tools/contracts";
import {
  useAgentComputerActivityStore,
  isAgentComputerActive,
} from "../agentComputerActivityStore";
import { readNativeApi } from "../nativeApi";
import { Button } from "./ui/button";
import { pauseComputerThread, stopComputerTurn } from "./computerControls";
const EMPTY_GRANTS: ReadonlyArray<import("@t3tools/contracts").ComputerGrant> = [];
export function AgentComputerLiveCard({ threadId }: { threadId: ThreadId }) {
  const activity = useAgentComputerActivityStore((state) => state.activity[threadId]);
  const grants = useAgentComputerActivityStore((state) => state.grants[threadId] ?? EMPTY_GRANTS);
  const appNames = useAgentComputerActivityStore((state) => state.appNames);
  const paused = useAgentComputerActivityStore((state) => state.paused[threadId]);
  const held = useAgentComputerActivityStore((state) => state.lease.threadId === threadId);
  const [now, setNow] = useState(Date.now());
  const [error, setError] = useState("");
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  const run = (action: () => Promise<unknown>) => {
    setError("");
    void action().catch(() => setError("Computer control could not be updated."));
  };
  if (!paused && !isAgentComputerActive(activity, now, held)) return null;
  const native = activity?.backend === "native";
  return (
    <div className="my-2 space-y-2 rounded-lg border p-3 text-sm" role="status">
      <p>
        {paused ? "You have control" : "Agent computer control"} ·{" "}
        {native ? "F5" : (activity?.backend ?? "F5")}
      </p>
      <p>
        {activity?.appName} {activity?.op} · {activity?.status}
      </p>
      {activity?.thumbnailDataUrl ? (
        <img src={activity.thumbnailDataUrl} className="max-w-80 rounded" alt="Last agent action" />
      ) : null}
      {grants.map((grant) => (
        <div key={grant.appId} className="flex items-center justify-between gap-2">
          <span>{appNames[grant.appId] ?? grant.appId}</span>
          <Button
            size="xs"
            variant="outline"
            onClick={() =>
              run(async () =>
                readNativeApi()?.computer?.access.revoke({ threadId, appId: grant.appId }),
              )
            }
          >
            Revoke
          </Button>
        </div>
      ))}
      <div className="flex gap-2">
        <Button
          size="xs"
          variant="outline"
          onClick={() => run(() => pauseComputerThread(threadId, !paused))}
        >
          {paused ? "Resume" : "Pause"}
        </Button>
        <Button
          size="xs"
          variant="destructive"
          title={native ? "Stop computer input" : "Stops after the current action"}
          onClick={() => run(() => stopComputerTurn(threadId))}
        >
          Stop
        </Button>
      </div>
      {error ? <p role="alert">{error}</p> : null}
    </div>
  );
}
