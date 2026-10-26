import type { ProjectId, UpstreamTopicHistoryEntry } from "@t3tools/contracts";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { ChevronRightIcon } from "lucide-react";
import { useState } from "react";

import { formatRelativeTimeLabel } from "../../lib/relativeTime";
import { upstreamTopicFilesQueryOptions } from "../../lib/upstreamPortsReactQuery";
import { cn } from "../../lib/utils";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "../ui/collapsible";
import { Skeleton } from "../ui/skeleton";
import {
  aggregateTopicFiles,
  formatFileTotals,
  HISTORY_PUBLICATION_LABELS,
  historyEntryLabel,
  upstreamBlobUrl,
} from "./upstreamPage.logic";

const FILES_COLLAPSED = 20;

export function UpstreamChangedFiles(props: {
  readonly projectId: ProjectId;
  readonly topicId: string;
  readonly repository: string;
}) {
  const query = useQuery(upstreamTopicFilesQueryOptions(props.projectId, props.topicId));
  const [expanded, setExpanded] = useState(false);
  const files = query.data;
  if (query.isPending)
    return (
      <section aria-label="Files changed" aria-busy="true" className="space-y-1">
        <h3 className="font-medium">Files changed</h3>
        <Skeleton className="h-3 w-48" />
        <Skeleton className="h-3 w-64" />
      </section>
    );
  if (!files)
    return (
      <section aria-label="Files changed" className="space-y-1">
        <h3 className="font-medium">Files changed</h3>
        <p className="text-xs text-muted-foreground">
          Could not list the files{query.error ? `: ${query.error.message}` : "."}
        </p>
      </section>
    );
  const rows = aggregateTopicFiles(files);
  const shown = expanded ? rows : rows.slice(0, FILES_COLLAPSED);
  const missing = files.commits.filter((commit) => !commit.available).length;
  const truncated = files.commits.some((commit) => commit.truncated);
  return (
    <section aria-label="Files changed" className="space-y-1">
      <h3 className="font-medium">Files changed</h3>
      {rows.length > 0 && <p className="text-xs text-muted-foreground">{formatFileTotals(files.totals)}</p>}
      {missing > 0 && (
        <p className="text-xs text-muted-foreground">
          {missing === files.commits.length ? "The commits are" : `${missing} commit${missing === 1 ? " is" : "s are"}`}{" "}
          not in the local clone; fetch the upstream remote to list their files.
        </p>
      )}
      {shown.length > 0 && (
        <ul className="space-y-0.5">
          {shown.map((file) => {
            const href = upstreamBlobUrl(props.repository, file.sha, file.path);
            const missingInF5 = file.existsInF5 === false;
            return (
              <li key={file.path} className="flex items-center gap-2 text-xs">
                {href ? (
                  <a
                    href={href}
                    target="_blank"
                    rel="noreferrer"
                    className={cn("min-w-0 truncate font-mono hover:underline", missingInF5 && "text-muted-foreground")}
                    title={file.path}
                  >
                    {file.path}
                  </a>
                ) : (
                  <span className={cn("min-w-0 truncate font-mono", missingInF5 && "text-muted-foreground")} title={file.path}>
                    {file.path}
                  </span>
                )}
                {missingInF5 && (
                  <Badge variant="outline" size="sm" className="shrink-0">
                    not in f5
                  </Badge>
                )}
                <span className="ml-auto shrink-0 font-mono tabular-nums">
                  {file.added === null && file.deleted === null ? (
                    <span className="text-muted-foreground">–</span>
                  ) : (
                    <>
                      <span className="text-success-foreground">+{file.added ?? 0}</span>{" "}
                      <span className="text-destructive-foreground">−{file.deleted ?? 0}</span>
                    </>
                  )}
                </span>
              </li>
            );
          })}
        </ul>
      )}
      {rows.length > FILES_COLLAPSED && (
        <Button size="xs" variant="link" className="px-0" onClick={() => setExpanded((value) => !value)}>
          {expanded ? "Show fewer files" : `Show all ${rows.length.toLocaleString()} files`}
        </Button>
      )}
      {truncated && <p className="text-xs text-muted-foreground">Very large commits list only their first files.</p>}
    </section>
  );
}

function HistoryEntry(props: { readonly entry: UpstreamTopicHistoryEntry; readonly reasonLabels: Readonly<Record<string, string>> }) {
  const navigate = useNavigate();
  const { entry } = props;
  const reason = entry.reasonKey ? (props.reasonLabels[entry.reasonKey] ?? entry.reasonKey) : null;
  return (
    <li className="space-y-0.5 border-l pl-3 text-xs">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span className="font-medium">{historyEntryLabel(entry)}</span>
        {entry.decidedBy && entry.decidedBy !== "user" && (
          <span className="text-muted-foreground">by {entry.decidedBy === "llm" ? "the triage model" : "a rule"}</span>
        )}
        {entry.epoch > 1 && <span className="text-muted-foreground">epoch {entry.epoch}</span>}
        {entry.publication && entry.publication !== "published" && (
          <Badge variant="outline" size="sm">
            {HISTORY_PUBLICATION_LABELS[entry.publication]}
          </Badge>
        )}
        <span className="ml-auto text-muted-foreground" title={entry.at ? new Date(entry.at).toLocaleString() : undefined}>
          {entry.at ? formatRelativeTimeLabel(entry.at) : "time unknown"}
        </span>
      </div>
      {(reason || entry.reason) && (
        <p className="text-muted-foreground">{[reason, entry.reason].filter(Boolean).join(": ")}</p>
      )}
      {entry.threadId && (
        <Button
          size="xs"
          variant="link"
          className="h-auto px-0"
          onClick={() => void navigate({ to: "/$threadId", params: { threadId: entry.threadId! } })}
        >
          Open thread
        </Button>
      )}
    </li>
  );
}

export function UpstreamTopicHistory(props: {
  readonly history: ReadonlyArray<UpstreamTopicHistoryEntry>;
  readonly reasonLabels: Readonly<Record<string, string>>;
}) {
  return (
    <Collapsible className="space-y-2">
      <CollapsibleTrigger className="group flex items-center gap-1 font-medium">
        <ChevronRightIcon className="size-4 transition-transform group-data-panel-open:rotate-90" />
        History ({props.history.length})
      </CollapsibleTrigger>
      <CollapsiblePanel>
        <ol aria-label="Topic history" className="space-y-2">
          {props.history.map((entry, index) => (
            // Entries have no id, and a topic's history only grows at the end.
            <HistoryEntry key={`${index}-${entry.kind}`} entry={entry} reasonLabels={props.reasonLabels} />
          ))}
        </ol>
      </CollapsiblePanel>
    </Collapsible>
  );
}
