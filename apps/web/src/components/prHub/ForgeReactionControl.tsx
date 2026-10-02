import { useState } from "react";
import type { TrackedPullRequest } from "@t3tools/contracts";
import { ForgeOperationPanel } from "./ForgeOperationPanel";
import { PR_REACTION_LABELS } from "./prDetails.logic";

/** Native reaction writes share the same saved confirmation workflow as other forge writes. */
export function ForgeReactionControl({
  pr,
  commentId,
}: {
  pr: TrackedPullRequest;
  commentId?: string | undefined;
}) {
  const [content, setContent] = useState("+1");
  if (!pr.forgeCapabilities?.reactions) return null;
  return (
    <div className="space-y-2" aria-label="Native reactions">
      <label className="text-xs">
        Add reaction{" "}
        <select
          aria-label="Reaction"
          value={content}
          onChange={(event) => setContent(event.target.value)}
          className="ml-2 rounded border border-border bg-background p-1"
        >
          {Object.entries(PR_REACTION_LABELS).map(([value, label]) => (
            <option key={value} value={value}>
              {label} {value}
            </option>
          ))}
        </select>
      </label>
      <ForgeOperationPanel
        pr={pr}
        payload={{ kind: "reaction", content, ...(commentId ? { commentId } : {}) }}
        label={commentId ? `Reaction to comment ${commentId}` : "Pull request reaction"}
      />
    </div>
  );
}
