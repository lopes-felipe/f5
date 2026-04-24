import type { ThreadId } from "@t3tools/contracts";
import { Link } from "@tanstack/react-router";

import { type Thread } from "../../types";
import { type ThreadStatusPill, resolveThreadStatusPillForThread } from "../../threadStatus";
import { cn } from "../../lib/utils";
import { ThreadStatusPillBadge } from "../thread/ThreadStatusPillBadge";

export function resolveWorkflowThreadRowState(input: {
  thread: Thread | null | undefined;
  threadTitleDisplay?: string | null | undefined;
  fallbackLabel: string;
}): { title: string; pill: ThreadStatusPill | null } {
  if (!input.thread) {
    return {
      title: input.fallbackLabel,
      pill: null,
    };
  }

  return {
    title: input.threadTitleDisplay?.trim() || input.thread.title,
    pill: resolveThreadStatusPillForThread(input.thread),
  };
}

export function WorkflowThreadLinkRow(props: {
  threadId: ThreadId | null;
  thread: Thread | null | undefined;
  fallbackLabel: string;
  threadTitleDisplay?: string | null | undefined;
  className?: string;
  stepState?: "completed" | "active" | "pending" | "error";
}) {
  const stepState = props.stepState ?? "active";
  const row = resolveWorkflowThreadRowState(props);

  const classes = cn(
    "block rounded-md border border-border px-3 py-2 text-sm",
    stepState === "pending" && !props.threadId && "opacity-40 pointer-events-none",
    stepState === "pending" && props.threadId && "opacity-40 hover:bg-accent",
    stepState === "completed" && "opacity-75 hover:bg-accent",
    stepState === "error" && "border-red-500/30 hover:bg-accent",
    stepState === "active" && "hover:bg-accent",
    props.className,
  );

  const content = (
    <div className="flex min-w-0 items-center gap-2">
      {row.pill ? <ThreadStatusPillBadge pill={row.pill} /> : null}
      <span className="min-w-0 flex-1 truncate">{row.title}</span>
    </div>
  );

  if (!props.threadId) {
    return <div className={classes}>{content}</div>;
  }

  return (
    <Link to="/$threadId" params={{ threadId: props.threadId }} className={classes}>
      {content}
    </Link>
  );
}
