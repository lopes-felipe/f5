import type { KeybindingCommand, UpstreamTopicList } from "@t3tools/contracts";
import { XIcon } from "lucide-react";
import type { ReactNode } from "react";

import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import { UpstreamActionButton } from "./UpstreamActionButton";
import { bulkActionsForList, headerCheckState, type UpstreamBulkAction } from "./upstreamPage.logic";

const ACTIONS: Readonly<
  Record<UpstreamBulkAction, { readonly label: string; readonly command: KeybindingCommand | null; readonly primary?: true }>
> = {
  accept: { label: "Accept suggestions", command: "upstream.acceptSuggestion", primary: true },
  port: { label: "Mark ready", command: "upstream.port" },
  skip: { label: "Skip…", command: "upstream.skip" },
  watch: { label: "Watch", command: "upstream.watch" },
  decline: { label: "Decline…", command: "upstream.decline" },
  equivalent: { label: "Already in f5", command: "upstream.equivalent" },
  reopen: { label: "Reopen", command: "upstream.reopen" },
  startPort: { label: "Start port…", command: "upstream.startPort", primary: true },
  copyPrompt: { label: "Copy prompt", command: null },
};

/** Decisions that change the ledger; read-only pages and busy actions disable them. */
const WRITES = new Set<UpstreamBulkAction>([
  "accept",
  "port",
  "skip",
  "watch",
  "decline",
  "equivalent",
  "reopen",
  "startPort",
]);

/**
 * The list header: a select-all checkbox and the topic count, or, with a
 * selection, the actions that apply to the current list.
 */
export function UpstreamBulkBar(props: {
  readonly list: UpstreamTopicList;
  readonly ids: ReadonlyArray<string>;
  readonly selected: ReadonlySet<string>;
  readonly total: number;
  readonly readOnly: boolean;
  readonly busy: boolean;
  readonly onSelectAll: (select: boolean) => void;
  readonly onClear: () => void;
  readonly onAction: (action: UpstreamBulkAction) => void;
  /** Extra content on the selection line, such as "Select all N matching". */
  readonly selectionNote?: ReactNode;
}) {
  const check = headerCheckState(props.ids, props.selected);
  const selectedCount = props.selected.size;
  return (
    <div className="flex min-h-10 shrink-0 flex-wrap items-center gap-2 border-b bg-muted/30 px-3 py-1.5 text-sm">
      <Checkbox
        aria-label={check === "all" ? "Clear selection" : "Select all loaded topics"}
        checked={check === "all"}
        indeterminate={check === "some"}
        disabled={props.ids.length === 0}
        onCheckedChange={() => props.onSelectAll(check !== "all")}
      />
      {selectedCount === 0 ? (
        <span className="text-muted-foreground tabular-nums">
          {props.total} topic{props.total === 1 ? "" : "s"}
        </span>
      ) : (
        <>
          <span className="font-medium tabular-nums">{selectedCount} selected</span>
          <Button size="icon-xs" variant="ghost" aria-label="Clear selection" onClick={props.onClear}>
            <XIcon />
          </Button>
          {props.selectionNote}
          <div role="toolbar" aria-label="Bulk actions" className="ml-auto flex flex-wrap items-center gap-1">
            {bulkActionsForList(props.list).map((action) => {
              const spec = ACTIONS[action];
              return (
                <UpstreamActionButton
                  key={action}
                  size="xs"
                  variant={spec.primary ? "default" : "outline"}
                  label={spec.label}
                  command={spec.command}
                  disabled={WRITES.has(action) && (props.readOnly || props.busy)}
                  onClick={() => props.onAction(action)}
                >
                  {spec.label}
                </UpstreamActionButton>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}
