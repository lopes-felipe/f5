import type { ThreadId } from "@t3tools/contracts";
import { useThreadDetail } from "../lib/orchestrationReactQuery";
import ChatView from "./ChatView";

export function SideChatPanel({ threadId }: { threadId: ThreadId }) {
  const detail = useThreadDetail(threadId);
  if (detail.isError)
    return (
      <p role="alert">
        Side chat could not load. {detail.error instanceof Error ? detail.error.message : ""}{" "}
        <button onClick={() => void detail.refetch()}>Retry</button>
      </p>
    );
  return <ChatView threadId={threadId} openInShortcutEnabled={false} liveAgentCount={0} embedded />;
}
