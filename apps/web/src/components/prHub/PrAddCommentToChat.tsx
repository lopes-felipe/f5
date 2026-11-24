import { useActiveComposerSelection } from "../../activeComposerSelection";
import type { TrackedPullRequest } from "@t3tools/contracts";
import { PrSendToAgent } from "./PrSendToAgent";
export { buildPrCommentContext } from "./prCommentContext";

export function PrAddCommentToChat({
  pr,
  body,
  path,
  line,
}: {
  pr: TrackedPullRequest;
  body: string;
  path?: string | null;
  line?: number | null;
}) {
  const threadId = useActiveComposerSelection((state) => {
    const ids = new Set([...state.registrations.values()].map((selection) => selection.threadId));
    return ids.size === 1 ? ids.values().next().value : undefined;
  });
  if (!body.trim()) return null;
  return (
    <PrSendToAgent
      pr={pr}
      body={body}
      path={path}
      line={line}
      preferredThreadId={threadId}
      contextOnly
    />
  );
}
