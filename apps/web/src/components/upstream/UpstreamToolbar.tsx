import type { UpstreamStateCounts, UpstreamTopicList } from "@t3tools/contracts";
import { BotIcon, HelpCircleIcon, PlayIcon } from "lucide-react";
import type { ReactNode } from "react";

import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Toggle } from "../ui/toggle";
import { ToggleGroup, ToggleGroupItem } from "../ui/toggle-group";
import { UPSTREAM_LISTS } from "./upstreamPage.logic";

export function UpstreamToolbar(props: {
  readonly list: UpstreamTopicList;
  readonly counts: UpstreamStateCounts;
  readonly onListChange: (list: UpstreamTopicList) => void;
  readonly question: boolean;
  readonly onQuestionChange: (value: boolean) => void;
  readonly auto: boolean;
  readonly onAutoChange: (value: boolean) => void;
  /** Ready list: Start port for every Ready topic. */
  readonly startAll: { readonly count: number; readonly disabled: boolean; readonly onStart: () => void } | null;
  readonly children?: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <ToggleGroup
        aria-label="Topic lists"
        size="sm"
        value={[props.list]}
        onValueChange={(values) => {
          const next = values[0] as UpstreamTopicList | undefined;
          if (next) props.onListChange(next);
        }}
      >
        {UPSTREAM_LISTS.map((entry) => (
          <ToggleGroupItem
            key={entry.id}
            value={entry.id}
            aria-current={entry.id === props.list ? "page" : undefined}
            className="gap-1.5"
          >
            {entry.label}
            <Badge variant="outline" size="sm" className="tabular-nums">
              {props.counts[entry.id]}
            </Badge>
          </ToggleGroupItem>
        ))}
      </ToggleGroup>
      {props.list === "inbox" && (
        <Toggle size="sm" variant="outline" pressed={props.question} onPressedChange={props.onQuestionChange}>
          <HelpCircleIcon />
          Has question
        </Toggle>
      )}
      {props.list === "skipped" && (
        <Toggle size="sm" variant="outline" pressed={props.auto} onPressedChange={props.onAutoChange}>
          <BotIcon />
          Automatic only
        </Toggle>
      )}
      {props.children}
      {props.startAll && props.startAll.count > 0 && (
        <Button
          size="sm"
          variant="outline"
          className="ml-auto"
          disabled={props.startAll.disabled}
          onClick={props.startAll.onStart}
        >
          <PlayIcon />
          Start port for all ({props.startAll.count})
        </Button>
      )}
    </div>
  );
}
