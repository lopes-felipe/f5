import type { AgentTranscriptItem, ThreadId } from "@t3tools/contracts";
import { useQuery } from "@tanstack/react-query";
import { LegendList, type LegendListRef } from "@legendapp/list/react";
import { useMemo, useRef, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { agentsSnapshotQueryOptions } from "../lib/agentsReactQuery";
import { isLiveBackgroundWork } from "../lib/agentsModel";
import { deriveTranscriptRows } from "../lib/agentTranscriptStore";
import { useAgentTranscript } from "../hooks/useAgentTranscript";
import ChatMarkdown from "./ChatMarkdown";
import { Button } from "./ui/button";
import { ReasoningSection } from "./chat/ReasoningSection";
import { CollapsibleUserMessageBody } from "./chat/CollapsibleUserMessageBody";
import { iconForItemType } from "./chat/workEntryIcons";
import { AgentStatusGlyph, elapsedLabel } from "./AgentsPanelRow";
import { JumpToLatestButton } from "./chat/JumpToLatestButton";

const REASONS = {
  "not-started": "Waiting for the subagent to write its transcript…",
  "session-not-running":
    "Codex transcripts are readable while this thread's Codex session is running.",
  "unsupported-provider": "This provider does not support subagent transcripts.",
  "identity-unavailable": "The original provider session could not be identified.",
  "not-found": "This transcript is no longer available.",
};
function TranscriptRow({ item, cwd }: { item: AgentTranscriptItem; cwd: string | undefined }) {
  const Icon = iconForItemType(item.kind === "tool-call" ? item.itemType : undefined);
  return (
    <div className="border-b border-border/40 px-4 py-3 text-sm">
      {item.kind === "message" ? (
        <>
          <div className="mb-1 text-xs text-muted-foreground">{item.role}</div>
          {item.role === "user" ? (
            <CollapsibleUserMessageBody text={item.text} />
          ) : (
            <ChatMarkdown text={item.text} cwd={cwd} policy="external-bot" />
          )}
          {item.truncated ? <small>Message truncated</small> : null}
        </>
      ) : item.kind === "reasoning" ? (
        <ReasoningSection
          policy="external-bot"
          reasoningText={item.text}
          defaultExpanded={false}
          isStreaming={false}
          cwd={cwd}
        />
      ) : item.kind === "notice" ? (
        <p className="text-muted-foreground">{item.text}</p>
      ) : (
        <details>
          <summary className="cursor-pointer">
            <Icon aria-hidden="true" className="mr-1 inline size-3.5" />
            {item.kind === "tool-call" ? item.title + " · " + item.status : "Tool result"}
          </summary>
          {item.kind === "tool-call" && item.detail ? (
            <pre className="mt-2 whitespace-pre-wrap break-words">{item.detail}</pre>
          ) : null}
          <pre className="mt-2 max-h-96 overflow-auto whitespace-pre-wrap break-words">
            {item.output}
          </pre>
          {item.outputTruncated ? <small>Output truncated</small> : null}
        </details>
      )}
    </div>
  );
}
export function AgentTranscriptPanel(props: {
  threadId: ThreadId;
  nativeWorkItemId: string;
  workItemIds: readonly string[];
  title: string;
  visible: boolean;
  cwd?: string | undefined;
  focusActivityId?: string | null | undefined;
}) {
  const snapshot = useQuery(agentsSnapshotQueryOptions(props.threadId));
  const matchingRows =
    snapshot.data?.entries.filter((row) => props.workItemIds.includes(row.workItemId)) ?? [];
  const row =
    matchingRows.find((row) => row.workItemId === props.nativeWorkItemId) ?? matchingRows[0];
  const live = matchingRows.some(isLiveBackgroundWork);
  const prompt = matchingRows.find((row) => row.prompt)?.prompt;
  const { state, refresh, loadEarlier, jumpToLatest } = useAgentTranscript({
    ...props,
    live,
    revision: row ? [row.updatedAt, row.lastTool, row.status].join(":") : "",
  });
  const rows = useMemo(() => deriveTranscriptRows(state, !live), [state, live]);
  const navigate = useNavigate();
  const list = useRef<LegendListRef>(null);
  const [atEnd, setAtEnd] = useState(true);
  const tail = rows.at(-1);
  return (
    <section aria-label="Agent transcript" className="relative flex h-full min-h-0 flex-col">
      <header className="flex shrink-0 flex-wrap items-center gap-2 border-b p-3">
        <strong className="min-w-0 flex-1 truncate">{props.title}</strong>
        {row ? <AgentStatusGlyph entry={{ status: row.status, live }} /> : null}
        <span className="text-xs text-muted-foreground">
          {live ? "Running" : (row?.status ?? "Settled")} · {row?.provider} {row?.model}{" "}
          {row?.effort}
          {row ? " · " + (elapsedLabel(row.startedAt, row.completedAt, Date.now()) ?? "") : ""}
        </span>
        <Button
          size="xs"
          variant="ghost"
          onClick={() =>
            void navigate({
              to: "/$threadId",
              params: { threadId: props.threadId },
              search: (previous) => ({
                ...previous,
                timelineEntryId: props.focusActivityId ?? undefined,
                timelineEntryKind: props.focusActivityId ? "activity" : undefined,
              }),
            })
          }
        >
          Open in timeline
        </Button>
        <Button size="xs" variant="ghost" disabled={state.inFlight} onClick={() => void refresh()}>
          Refresh
        </Button>
      </header>
      {state.error ? (
        <p role="alert" className="p-3">
          {state.error}
          <Button size="xs" onClick={() => void refresh()}>
            Retry
          </Button>
        </p>
      ) : null}
      {!state.loaded && state.inFlight ? <p className="p-3">Loading transcript…</p> : null}
      {state.reason ? <p className="p-3 text-muted-foreground">{REASONS[state.reason]}</p> : null}
      {state.earlierCursor ? (
        <Button
          size="xs"
          variant="ghost"
          disabled={state.inFlight}
          onClick={() => void loadEarlier()}
        >
          Load earlier
        </Button>
      ) : state.droppedCount > 0 ? (
        <p className="p-2 text-xs text-muted-foreground">
          {state.droppedCount} earlier entries not shown
        </p>
      ) : null}
      {state.detachedFromLatest ? (
        <Button size="xs" onClick={() => void jumpToLatest()}>
          New activity available — Jump to latest
        </Button>
      ) : null}
      <div className="min-h-0 flex-1">
        <LegendList
          ref={list}
          data={rows}
          keyExtractor={(item) => item.id}
          renderItem={({ item }) => <TranscriptRow item={item} cwd={props.cwd} />}
          estimatedItemSize={100}
          initialScrollAtEnd
          maintainScrollAtEnd={!state.detachedFromLatest}
          maintainVisibleContentPosition
          onScroll={() => {
            const node = list.current?.getScrollableNode();
            if (!(node instanceof HTMLElement)) return;
            setAtEnd(node.scrollHeight - node.scrollTop - node.clientHeight < 80);
            if (node.scrollTop < 40 && state.earlierCursor && !state.inFlight) void loadEarlier();
          }}
        />
      </div>
      {!atEnd ? (
        <JumpToLatestButton
          tail={{
            rowId: tail?.id ?? null,
            textEpoch: null,
            textRevision: null,
            text: tail && "text" in tail ? tail.text : null,
          }}
          shortcutLabel={null}
          onJump={() => {
            if (state.detachedFromLatest) void jumpToLatest();
            list.current?.scrollToEnd({ animated: true });
          }}
        />
      ) : null}
      {(!live || state.availability === "unavailable") && (prompt || row?.latestOutput) ? (
        <details className="max-h-60 shrink-0 overflow-auto border-t p-3">
          <summary>Stored prompt and result</summary>
          <pre className="whitespace-pre-wrap break-words">
            {[prompt, row?.latestOutput].filter(Boolean).join("\n\n")}
          </pre>
        </details>
      ) : null}
      {state.pendingTail ? (
        <p className="px-3 text-xs text-muted-foreground">
          Waiting for the final record to finish writing. Refresh to retry.
        </p>
      ) : null}
    </section>
  );
}
