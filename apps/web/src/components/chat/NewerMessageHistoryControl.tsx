import type { ThreadId } from "@t3tools/contracts";
import { useEffect, useRef, useState } from "react";

import { loadNewerThreadHistoryPage } from "../../lib/orchestrationReactQuery";
import { ensureThreadHistoryState } from "../../lib/threadHistory";
import { useStore } from "../../store";
import { Button } from "../ui/button";

export function NewerMessageHistoryControl({ threadId }: { readonly threadId: ThreadId }) {
  const hasNewerTimeline = useStore((state) => {
    const history = ensureThreadHistoryState(
      state.threads.find((thread) => thread.id === threadId)?.history,
    );
    return history.hasNewerMessages === true || history.hasNewerActivities === true;
  });
  const [stage, setStage] = useState<"idle" | "loading" | "error">("idle");
  const requestRef = useRef<AbortController | null>(null);

  useEffect(
    () => () => {
      requestRef.current?.abort();
    },
    [],
  );

  if (!hasNewerTimeline) return null;

  const loadNewer = () => {
    if (requestRef.current) return;
    const controller = new AbortController();
    requestRef.current = controller;
    setStage("loading");
    void loadNewerThreadHistoryPage(threadId, controller.signal)
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
          ? "The gap to newer messages could not be loaded."
          : "More recent timeline entries exist between this result and the current thread tail."}
      </p>
      <Button size="sm" variant="outline" disabled={stage === "loading"} onClick={loadNewer}>
        {stage === "loading" ? "Loading…" : stage === "error" ? "Retry" : "Load newer"}
      </Button>
    </div>
  );
}
