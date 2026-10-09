import type { ThreadId } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { MonitorIcon, SquareIcon } from "lucide-react";
import { useEffect, useState } from "react";

import { newCommandId } from "../lib/utils";
import { readNativeApi } from "../nativeApi";
import { useStore } from "../store";
import { Button } from "./ui/button";

/**
 * App-wide notice while an agent controls the screen, mouse, and keyboard, with a
 * one-click stop that interrupts that thread's turn.
 */
export function ComputerUseBanner() {
  const [threadId, setThreadId] = useState<ThreadId | null>(null);
  const navigate = useNavigate();
  const title = useStore((store) =>
    threadId ? store.threads.find((thread) => thread.id === threadId)?.title : undefined,
  );

  useEffect(() => {
    const api = readNativeApi();
    if (!api) return;
    return api.preview.automation.onComputerUseChanged((event) => setThreadId(event.threadId));
  }, []);

  if (!threadId) return null;
  const stop = () => {
    void readNativeApi()
      ?.orchestration.dispatchCommand({
        type: "thread.turn.interrupt",
        commandId: newCommandId(),
        threadId,
        createdAt: new Date().toISOString(),
      })
      .catch(() => undefined);
  };
  return (
    <div
      role="status"
      className="fixed top-2 left-1/2 z-[60] flex -translate-x-1/2 items-center gap-2 rounded-full border border-warning/50 bg-background/95 py-1 pr-1 pl-3 text-sm shadow-md"
      data-testid="computer-use-banner"
    >
      <MonitorIcon className="size-4 text-warning-foreground" />
      <span>
        An agent is controlling this computer
        {title ? <span className="text-muted-foreground"> · {title}</span> : null}
      </span>
      <Button
        size="xs"
        variant="ghost"
        onClick={() => void navigate({ to: "/$threadId", params: { threadId } })}
      >
        View
      </Button>
      <Button size="xs" variant="destructive" onClick={stop}>
        <SquareIcon />
        Stop
      </Button>
    </div>
  );
}
