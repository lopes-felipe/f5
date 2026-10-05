import { useState } from "react";

/**
 * One polite live region for coarse turn transitions. Announces only on a
 * change of working state within the same thread so opening a thread never
 * reads out a stale status, and streaming tokens never spam screen readers.
 */
export function ChatStatusAnnouncer(props: { threadId: string; isWorking: boolean }) {
  const [previous, setPrevious] = useState({
    threadId: props.threadId,
    isWorking: props.isWorking,
  });
  const [message, setMessage] = useState("");

  if (previous.threadId !== props.threadId || previous.isWorking !== props.isWorking) {
    setPrevious({ threadId: props.threadId, isWorking: props.isWorking });
    setMessage(
      previous.threadId !== props.threadId ? "" : props.isWorking ? "Working" : "Response ready",
    );
  }

  return (
    <div className="sr-only" aria-live="polite" aria-atomic="true">
      {message}
    </div>
  );
}
