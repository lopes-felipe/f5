import type { AssistantResponseContext } from "@t3tools/contracts";
import { Link } from "@tanstack/react-router";

/** The encoded identity stays in the message; only a bounded preview is displayed. */
export function AssistantResponseCard({ record }: { record: AssistantResponseContext }) {
  const flat = (value: string) => value.replace(/\s+/g, " ");
  return (
    <Link
      to="/$threadId"
      params={{ threadId: record.threadId }}
      search={{ timelineEntryId: record.messageId, timelineEntryKind: "message" }}
      onClick={(event) => {
        if (
          event.button === 0 &&
          !event.metaKey &&
          !event.ctrlKey &&
          !event.shiftKey &&
          !event.altKey
        )
          window.dispatchEvent(new CustomEvent("f5:response-source", { detail: record }));
      }}
      data-thread-find-ignore
      aria-label={
        record.kind === "response" ? "Go to the response this replies to" : "Go to quoted response"
      }
      className="my-1.5 block min-w-0 rounded-lg bg-muted px-2.5 py-1.5 text-sm text-muted-foreground no-underline hover:bg-muted/70"
    >
      {record.kind === "response" ? (
        <span className="block text-xs font-medium">
          Replying to
          {record.subagents?.length
            ? " · " + record.subagents.map((agent) => agent.title).join(", ")
            : ""}
        </span>
      ) : null}
      <span className="line-clamp-2" dir="auto">
        {record.prefix ? "…" + flat(record.prefix) : null}
        {record.kind === "quote" ? (
          <mark className="rounded-sm bg-foreground/10 text-foreground">{flat(record.text)}</mark>
        ) : (
          flat(record.text)
        )}
        {record.suffix ? flat(record.suffix) + "…" : null}
      </span>
    </Link>
  );
}
