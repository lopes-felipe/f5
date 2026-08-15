import type { ThreadId } from "@t3tools/contracts";
import { useEffect, useRef, useState } from "react";

import { loadOlderThreadActivitiesPage } from "../../lib/orchestrationReactQuery";
import { ensureThreadHistoryState } from "../../lib/threadHistory";
import { useStore } from "../../store";
import { Button } from "../ui/button";

export function OlderActivityHistoryControl({ threadId }: { readonly threadId: ThreadId }) {
  const history = useStore((state) =>
    ensureThreadHistoryState(state.threads.find((thread) => thread.id === threadId)?.history),
  );
  const [stage, setStage] = useState<"idle" | "loading" | "error">("idle");
  const requestRef = useRef<AbortController | null>(null);

  useEffect(
    () => () => {
      requestRef.current?.abort();
    },
    [],
  );

  if (!history.hasOlderActivities) return null;

  const loadOlder = () => {
    if (requestRef.current) return;
    const controller = new AbortController();
    requestRef.current = controller;
    setStage("loading");
    void loadOlderThreadActivitiesPage(threadId, controller.signal)
      .then(() => {
        if (!controller.signal.aborted) setStage("idle");
      })
      .catch((error) => {
        if (error instanceof Error && error.name === "AbortError") return;
        setStage("error");
      })
      .finally(() => {
        if (requestRef.current === controller) requestRef.current = null;
      });
  };

  return (
    <div className="mx-auto mb-4 flex w-full max-w-3xl items-center justify-between gap-3 rounded-2xl border border-border/70 bg-card/70 px-4 py-3 shadow-sm backdrop-blur-sm">
      <p className="text-sm text-muted-foreground">
        {stage === "error"
          ? "Earlier activity could not be loaded."
          : "Earlier activity is available."}
      </p>
      <Button size="sm" variant="outline" disabled={stage === "loading"} onClick={loadOlder}>
        {stage === "loading" ? "Loading…" : stage === "error" ? "Retry" : "Load earlier"}
      </Button>
    </div>
  );
}
