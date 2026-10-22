import type { ProjectId, UpstreamDecision, UpstreamOverview, UpstreamPortLinkSummary } from "@t3tools/contracts";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";

import { upstreamTopicQueryOptions } from "../../lib/upstreamPortsReactQuery";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import {
  equivalentFromLink,
  suggestionChipLabel,
  upstreamCommitUrl,
  upstreamPrUrl,
  watchFromBlocked,
} from "./upstreamPage.logic";

export function UpstreamTopicDetail(props: {
  readonly projectId: ProjectId;
  readonly topicId: string;
  readonly overview: UpstreamOverview;
  readonly readOnly: boolean;
  readonly busy: boolean;
  readonly onDecide: (decision: UpstreamDecision) => void;
  readonly onSkip: (options?: { readonly reason?: string }) => void;
  readonly onDecline: () => void;
  readonly onStartPort: () => void;
  readonly onCopyPrompt: () => void;
  readonly onUnlink: (link: UpstreamPortLinkSummary) => void;
}) {
  const navigate = useNavigate();
  const query = useQuery(upstreamTopicQueryOptions(props.projectId, props.topicId));
  const [scope, setScope] = useState("");
  const detail = query.data;
  useEffect(() => setScope(detail?.row.topic.scope ?? ""), [detail?.row.topic.id, detail?.row.topic.scope]);
  if (query.isPending) return <p className="p-4 text-sm text-muted-foreground">Loading topic…</p>;
  if (!detail)
    return (
      <p role="alert" className="p-4 text-sm text-destructive-foreground">
        {query.error ? String(query.error) : "Topic not found."}
      </p>
    );
  const { topic, state } = detail.row;
  const suggestion = topic.suggestion;
  const disabled = props.readOnly || props.busy;
  return (
    <article className="space-y-4 p-4 text-sm" aria-label={topic.title}>
      <header className="space-y-1">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="text-base font-semibold">{topic.title}</h2>
          <Badge variant="outline">{state}</Badge>
          {topic.epoch > 1 && <Badge variant="outline">epoch {topic.epoch}</Badge>}
        </div>
        <p className="font-mono text-xs text-muted-foreground">{topic.id}</p>
        {topic.summary && <p>{topic.summary}</p>}
        {topic.reason && state !== "inbox" && (
          <p className="text-muted-foreground">
            {topic.status}: {topic.reason}
            {topic.decidedBy ? ` (${topic.decidedBy})` : ""}
          </p>
        )}
        {topic.scope && <p>Scope: {topic.scope}</p>}
        {topic.revisitAfter && <p className="text-muted-foreground">Revisit after {topic.revisitAfter}</p>}
      </header>

      {suggestion && (
        <section className="space-y-1 rounded-md border p-3">
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant="outline">{suggestionChipLabel(suggestion)}</Badge>
            <span className="text-xs text-muted-foreground">
              impact {suggestion.userImpact} · {suggestion.model}
            </span>
            {suggestion.conflict && <Badge variant="warning">conflict</Badge>}
          </div>
          {suggestion.reason && <p>{suggestion.reason}</p>}
          {suggestion.question && <p className="font-medium text-warning-foreground">Question: {suggestion.question}</p>}
          {suggestion.areas.length > 0 && (
            <p className="text-xs text-muted-foreground">Areas: {suggestion.areas.join(", ")}</p>
          )}
          {suggestion.f5Refs && <p className="text-xs">f5: {suggestion.f5Refs.join(", ")}</p>}
          {suggestion.triageError && (
            <p className="text-xs text-destructive-foreground">Triage: {suggestion.triageError}</p>
          )}
        </section>
      )}

      <section className="space-y-2">
        <div className="flex flex-wrap gap-2">
          <Button size="sm" disabled={disabled} onClick={() => props.onDecide({ kind: "port", ...(scope.trim() ? { scope: scope.trim() } : {}) })}>
            Port
          </Button>
          <Button size="sm" variant="outline" disabled={disabled} onClick={() => props.onSkip()}>
            Skip…
          </Button>
          <Button size="sm" variant="outline" disabled={disabled} onClick={() => props.onDecide({ kind: "watch" })}>
            Watch
          </Button>
          <Button size="sm" variant="outline" disabled={disabled} onClick={props.onDecline}>
            Decline…
          </Button>
          <Button size="sm" variant="outline" disabled={disabled} onClick={() => props.onDecide({ kind: "equivalent" })}>
            Already in f5
          </Button>
          {state !== "inbox" && (
            <Button size="sm" variant="ghost" disabled={disabled} onClick={() => props.onDecide({ kind: "inbox" })}>
              Reopen
            </Button>
          )}
        </div>
        <Input
          aria-label="Scope note"
          placeholder="Scope note for Port (optional)"
          value={scope}
          disabled={disabled}
          onChange={(event) => setScope(event.target.value)}
        />
        {(state === "ready" || state === "in-progress") && (
          <div className="flex flex-wrap gap-2">
            <Button size="sm" disabled={disabled} onClick={props.onStartPort}>
              Start port…
            </Button>
            <Button size="sm" variant="outline" disabled={props.busy} onClick={props.onCopyPrompt}>
              Copy port prompt
            </Button>
          </div>
        )}
      </section>

      {detail.row.links.length > 0 && (
        <section className="space-y-2">
          <h3 className="font-medium">Port threads</h3>
          {detail.row.links.map((link) => {
            const blocked = watchFromBlocked(link);
            return (
              <div key={link.threadId} className="space-y-2 rounded-md border p-3">
                <div className="flex flex-wrap items-center gap-2">
                  <Button
                    size="xs"
                    variant="link"
                    onClick={() => void navigate({ to: "/$threadId", params: { threadId: link.threadId } })}
                  >
                    {link.threadTitle ?? link.threadId}
                  </Button>
                  {link.threadStatus && <Badge variant="outline">{link.threadStatus}</Badge>}
                  {link.prUrl && (
                    <a href={link.prUrl} target="_blank" rel="noreferrer" className="hover:underline">
                      PR #{link.prNumber}
                    </a>
                  )}
                  {link.branch && <span className="font-mono text-xs text-muted-foreground">{link.branch}</span>}
                </div>
                {link.outcome && (
                  <p>
                    Outcome: <span className="font-medium">{link.outcome.kind}</span> {link.outcome.detail}
                  </p>
                )}
                <div className="flex flex-wrap gap-2">
                  <Button size="xs" variant="outline" disabled={disabled} onClick={() => props.onDecide(equivalentFromLink(link))}>
                    Record equivalent
                  </Button>
                  <Button
                    size="xs"
                    variant="outline"
                    disabled={disabled}
                    onClick={() =>
                      props.onSkip(link.outcome?.kind === "not-applicable" ? { reason: link.outcome.detail } : {})
                    }
                  >
                    Record not applicable
                  </Button>
                  {blocked && (
                    <Button size="xs" variant="outline" disabled={disabled} onClick={() => props.onDecide(blocked)}>
                      Move to Watch
                    </Button>
                  )}
                  <Button size="xs" variant="ghost" disabled={disabled} onClick={() => props.onUnlink(link)}>
                    Unlink
                  </Button>
                </div>
              </div>
            );
          })}
        </section>
      )}

      <section className="space-y-1">
        <h3 className="font-medium">Upstream commits ({detail.members.length})</h3>
        <ul className="space-y-0.5">
          {detail.members.map((member) => (
            <li key={member.sha} className="flex gap-2 text-xs">
              <a
                href={upstreamCommitUrl(detail.repository, member.sha)}
                target="_blank"
                rel="noreferrer"
                className="font-mono hover:underline"
              >
                {member.sha.slice(0, 12)}
              </a>
              <span className="truncate">{member.subject}</span>
              <span className="ml-auto shrink-0 text-muted-foreground">{member.source}</span>
            </li>
          ))}
        </ul>
        {topic.upstreamPrs.length > 0 && (
          <p className="text-xs">
            Upstream PRs:{" "}
            {topic.upstreamPrs.map((pr) => (
              <a key={pr} className="mr-2 hover:underline" href={upstreamPrUrl(detail.repository, pr)} target="_blank" rel="noreferrer">
                #{pr}
              </a>
            ))}
          </p>
        )}
      </section>

      {detail.related.length > 0 && (
        <section className="space-y-1">
          <h3 className="font-medium">Related topics</h3>
          <ul className="space-y-0.5 text-xs">
            {detail.related.map((related) => (
              <li key={related.id}>
                <span className="font-mono">{related.id}</span> {related.title}{" "}
                <span className="text-muted-foreground">({related.state ?? "unknown"})</span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </article>
  );
}
