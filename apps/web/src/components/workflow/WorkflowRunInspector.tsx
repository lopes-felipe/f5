import type { WorkflowRunKind } from "@t3tools/contracts";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronDownIcon, ChevronUpIcon, CoinsIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { formatUsd } from "../../lib/formatUsd";
import { ensureNativeApi } from "../../nativeApi";
import { Button } from "../ui/button";

export const workflowRunInspectionQueryKey = (runKind: WorkflowRunKind, workflowId: string) =>
  ["workflow-platform", "inspection", runKind, workflowId] as const;

/**
 * Run details are fetched only while expanded, under one cache entry per run.
 * Run updates invalidate that entry (refetching only if it is being viewed)
 * instead of creating a new entry per `updatedAt`.
 */
export function WorkflowRunInspector(props: {
  readonly runKind: WorkflowRunKind;
  readonly workflowId: string;
  readonly updatedAt: string;
}) {
  const [open, setOpen] = useState(false);
  const queryClient = useQueryClient();
  const queryKey = workflowRunInspectionQueryKey(props.runKind, props.workflowId);
  const query = useQuery({
    queryKey,
    queryFn: () =>
      ensureNativeApi().workflowPlatform.inspectRun({
        runKind: props.runKind,
        workflowId: props.workflowId,
      }),
    enabled: open,
  });

  const lastUpdatedAtRef = useRef(props.updatedAt);
  useEffect(() => {
    if (lastUpdatedAtRef.current === props.updatedAt) return;
    lastUpdatedAtRef.current = props.updatedAt;
    void queryClient.invalidateQueries({
      queryKey: workflowRunInspectionQueryKey(props.runKind, props.workflowId),
      exact: true,
    });
  }, [props.runKind, props.updatedAt, props.workflowId, queryClient]);

  const inspection = query.data?.inspection ?? null;
  const summary = !open
    ? "Template, cost and per-step context"
    : inspection
      ? `${inspection.templateId}@${inspection.templateVersion} · ${formatUsd(inspection.totalCostUsd)}${inspection.maxCostUsd === null ? "" : ` / ${formatUsd(inspection.maxCostUsd)}`}`
      : query.isError
        ? "Run metadata could not be loaded"
        : "Loading run metadata...";

  return (
    <section
      data-slot="workflow-run-inspector"
      className="rounded-xl border border-border bg-card px-4 py-3"
    >
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <h2 className="flex items-center gap-1.5 text-sm font-semibold text-foreground">
            <CoinsIcon aria-hidden="true" className="size-3.5 text-muted-foreground" /> Run
            inspector
          </h2>
          <p className="mt-0.5 font-mono text-2xs text-muted-foreground">{summary}</p>
        </div>
        <Button
          type="button"
          size="xs"
          variant="ghost"
          aria-expanded={open}
          onClick={() => setOpen((value) => !value)}
        >
          {open ? <ChevronUpIcon /> : <ChevronDownIcon />}
          {open ? "Hide" : "Inspect"}
        </Button>
      </div>
      {open && query.isError && !inspection ? (
        <div
          role="alert"
          className="mt-3 flex items-center justify-between gap-3 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2"
        >
          <p className="min-w-0 text-2xs text-destructive-foreground">
            {query.error instanceof Error ? query.error.message : "The run could not be inspected."}
          </p>
          <Button
            type="button"
            size="xs"
            variant="outline"
            disabled={query.isFetching}
            onClick={() => void query.refetch()}
          >
            {query.isFetching ? "Retrying..." : "Retry"}
          </Button>
        </div>
      ) : null}
      {open && inspection ? (
        <div className="mt-3 space-y-3">
          <div className="grid gap-2 sm:grid-cols-2">
            {inspection.nodes.map((node) => (
              <div
                key={node.nodeId}
                className="rounded-lg border border-border bg-muted/40 px-3 py-2"
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="truncate text-ui font-medium text-foreground">{node.label}</span>
                  <span className="shrink-0 text-2xs text-muted-foreground">{node.status}</span>
                </div>
                <p className="mt-1 truncate font-mono text-2xs text-muted-foreground">
                  {node.kind}
                  {node.slot ? ` · ${node.slot.provider}:${node.slot.model}` : ""}
                </p>
                {node.estimatedContextTokens !== null || node.turnCostUsd !== null ? (
                  <p className="mt-1 text-2xs text-muted-foreground">
                    {node.estimatedContextTokens !== null
                      ? `${node.estimatedContextTokens.toLocaleString()} context tokens`
                      : "Tokens unavailable"}
                    {node.turnCostUsd !== null ? ` · ${formatUsd(node.turnCostUsd)}` : ""}
                  </p>
                ) : null}
                {node.sessionNotes ? (
                  <p className="mt-1 line-clamp-2 text-2xs text-muted-foreground">
                    {node.sessionNotes.title}: {node.sessionNotes.currentState}
                  </p>
                ) : null}
                {node.compactionInput ? (
                  <p className="mt-1 line-clamp-2 text-2xs text-muted-foreground">
                    Compacted input: {node.compactionInput.summary}
                  </p>
                ) : null}
              </div>
            ))}
          </div>
          <p className="text-2xs text-muted-foreground">
            Context: {inspection.projectMemories.length} memories ·{" "}
            {inspection.projectSkills.length} skills
            {inspection.budgetRemainingUsd !== null
              ? ` · ${formatUsd(inspection.budgetRemainingUsd)} budget remaining`
              : ""}
          </p>
        </div>
      ) : null}
    </section>
  );
}
