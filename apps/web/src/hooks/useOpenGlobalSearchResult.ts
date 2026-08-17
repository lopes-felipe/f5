import type { GlobalSearchResult } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { useCallback } from "react";

export function useOpenGlobalSearchResult(): (result: GlobalSearchResult) => Promise<void> {
  const navigate = useNavigate();

  return useCallback(
    async (result: GlobalSearchResult) => {
      if (result.kind.startsWith("workflow.") && result.workflowId) {
        const to =
          result.kind === "workflow.planning"
            ? "/workflow/$workflowId"
            : result.kind === "workflow.codeReview"
              ? "/code-review/$workflowId"
              : "/investigation/$workflowId";
        await navigate({ to, params: { workflowId: result.workflowId } });
        return;
      }
      if (!result.threadId) return;
      if (result.kind === "fileChange" && result.fileChangeId) {
        await navigate({
          to: "/$threadId",
          params: { threadId: result.threadId },
          search: {
            diff: "1",
            diffFileChangeId: result.fileChangeId,
            ...(result.path ? { diffFilePath: result.path } : {}),
          },
        });
        return;
      }
      const timelineEntryId =
        result.messageId ??
        (result.kind === "activity" ? result.documentKey.slice("activity:".length) : undefined);
      await navigate({
        to: "/$threadId",
        params: { threadId: result.threadId },
        ...(timelineEntryId
          ? {
              search: {
                timelineEntryId,
                timelineEntryKind: result.kind === "activity" ? "activity" : "message",
              },
            }
          : {}),
      });
    },
    [navigate],
  );
}
