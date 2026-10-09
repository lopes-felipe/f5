import { useNavigate } from "@tanstack/react-router";
import { MonitorIcon, SquareIcon } from "lucide-react";
import { useAgentComputerActivityStore } from "../agentComputerActivityStore";
import { useStore } from "../store";
import { Button } from "./ui/button";
import { pauseComputerThread, stopComputerTurn } from "./computerControls";
export function ComputerUseBanner() {
  const lease = useAgentComputerActivityStore((state) => state.lease);
  const paused = useAgentComputerActivityStore((state) =>
    lease.threadId ? state.paused[lease.threadId] : false,
  );
  const navigate = useNavigate();
  const title = useStore((store) =>
    lease.threadId
      ? store.threads.find((thread) => thread.id === lease.threadId)?.title
      : undefined,
  );
  if (!lease.threadId && !lease.otherProfile) return null;
  const threadId = lease.threadId;
  return (
    <div
      role="status"
      className="fixed top-2 left-1/2 z-[60] flex -translate-x-1/2 items-center gap-2 rounded-full border border-warning/50 bg-background/95 py-1 pr-1 pl-3 text-sm shadow-md"
      data-testid="computer-use-banner"
    >
      <MonitorIcon className="size-4 text-warning-foreground" />
      <span>
        {lease.otherProfile
          ? "An agent in another F5 profile is controlling this computer"
          : paused
            ? "Computer control paused"
            : "An agent is controlling this computer"}
        {title ? ` · ${title}` : ""}
        {lease.backend ? ` · ${lease.backend === "native" ? "F5" : lease.backend}` : ""}
      </span>
      {threadId ? (
        <>
          <Button
            size="xs"
            variant="ghost"
            onClick={() => void navigate({ to: "/$threadId", params: { threadId } })}
          >
            View
          </Button>
          <Button
            size="xs"
            variant="ghost"
            title="Stop shortcut: ⌃⌘Esc on macOS; Ctrl+Alt+Shift+F12 on Windows"
            onClick={() => void pauseComputerThread(threadId, !paused).catch(() => undefined)}
          >
            {paused ? "Resume" : "Pause"}
          </Button>
          <Button
            size="xs"
            variant="destructive"
            title={
              lease.backend === "native" ? "Stop computer input" : "Stops after the current action"
            }
            onClick={() => void stopComputerTurn(threadId).catch(() => undefined)}
          >
            <SquareIcon />
            Stop
          </Button>
        </>
      ) : (
        <span className="text-xs">⌃⌘Esc / Ctrl+Alt+Shift+F12 to stop</span>
      )}
    </div>
  );
}
