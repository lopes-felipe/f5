import type { UpstreamTopicList } from "@t3tools/contracts";
import { InboxIcon, ListFilterIcon, PlayIcon } from "lucide-react";

import { Button } from "../ui/button";
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "../ui/empty";
import { Kbd } from "../ui/kbd";
import { useUpstreamShortcut } from "./UpstreamActionButton";
import { UPSTREAM_STATE_LABELS } from "./upstreamPage.logic";

const EMPTY_TEXT: Readonly<Record<Exclude<UpstreamTopicList, "inbox" | "ready">, string>> = {
  "in-progress": "Start port on a Ready topic and its thread shows up here.",
  watch: "Watched topics wait here for an unfinished upstream series, then return to Inbox.",
  done: "Topics land here once a port merges or you record that f5 already has the change.",
  skipped: "Skipped and declined topics are kept here with their reason.",
};

export function UpstreamListEmpty(props: {
  readonly list: UpstreamTopicList;
  readonly filtered: boolean;
  readonly lastRun: string | null;
  readonly runDisabled: boolean;
  readonly onRun: () => void;
  readonly onClearFilters: () => void;
}) {
  const portShortcut = useUpstreamShortcut("upstream.port");
  if (props.filtered)
    return (
      <Empty className="md:p-8">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <ListFilterIcon />
          </EmptyMedia>
          <EmptyTitle>No topics match</EmptyTitle>
          <EmptyDescription>Nothing in {UPSTREAM_STATE_LABELS[props.list]} matches the current filters.</EmptyDescription>
        </EmptyHeader>
        <EmptyContent>
          <Button size="sm" variant="outline" onClick={props.onClearFilters}>
            Clear filters
          </Button>
        </EmptyContent>
      </Empty>
    );
  if (props.list === "inbox")
    return (
      <Empty className="md:p-8">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <InboxIcon />
          </EmptyMedia>
          <EmptyTitle>Inbox zero</EmptyTitle>
          <EmptyDescription>{props.lastRun ?? "Run now to triage new upstream commits."}</EmptyDescription>
        </EmptyHeader>
        <EmptyContent>
          <Button size="sm" disabled={props.runDisabled} onClick={props.onRun}>
            <PlayIcon />
            Run now
          </Button>
        </EmptyContent>
      </Empty>
    );
  return (
    <Empty className="md:p-8">
      <EmptyHeader>
        <EmptyTitle>Nothing in {UPSTREAM_STATE_LABELS[props.list]}</EmptyTitle>
        <EmptyDescription>
          {props.list === "ready" ? (
            <>
              Mark Inbox topics ready with {portShortcut ? <Kbd>{portShortcut}</Kbd> : "Mark ready"}, then start a
              port from here.
            </>
          ) : (
            EMPTY_TEXT[props.list]
          )}
        </EmptyDescription>
      </EmptyHeader>
    </Empty>
  );
}
