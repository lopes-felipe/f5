import type { WorkflowRunKind } from "@t3tools/contracts";
import { useQuery } from "@tanstack/react-query";
import { ChevronDownIcon, ChevronUpIcon, CoinsIcon } from "lucide-react";
import { useState } from "react";

import { ensureNativeApi } from "../../nativeApi";
import { Button } from "../ui/button";

function usd(value: number): string {
  return value < 0.01 && value > 0 ? "<$0.01" : `$${value.toFixed(2)}`;
}

export function WorkflowRunInspector(props: {
  readonly runKind: WorkflowRunKind;
  readonly workflowId: string;
  readonly updatedAt: string;
}) {
  const [open, setOpen] = useState(false);
  const query = useQuery({
    queryKey: ["workflow-platform", "inspection", props.runKind, props.workflowId, props.updatedAt],
    queryFn: () =>
      ensureNativeApi().workflowPlatform.inspectRun({
        runKind: props.runKind,
        workflowId: props.workflowId,
      }),
  });
  const inspection = query.data?.inspection ?? null;
  if (!inspection && !query.isLoading) return null;

  return (
    <section className="rounded-lg border border-border bg-background p-3">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="flex items-center gap-1.5 text-sm font-semibold text-foreground">
            <CoinsIcon className="size-3.5" /> Run inspector
          </p>
          <p className="mt-1 text-xs text-muted-foreground">
            {inspection
              ? `${inspection.templateId}@${inspection.templateVersion} · ${usd(inspection.totalCostUsd)}${inspection.maxCostUsd === null ? "" : ` / ${usd(inspection.maxCostUsd)}`}`
              : "Loading run metadata..."}
          </p>
        </div>
        <Button type="button" size="xs" variant="ghost" onClick={() => setOpen((value) => !value)}>
          {open ? <ChevronUpIcon /> : <ChevronDownIcon />}
          {open ? "Hide" : "Inspect"}
        </Button>
      </div>
      {open && inspection ? (
        <div className="mt-3 space-y-3">
          <div className="grid gap-2 sm:grid-cols-2">
            {inspection.nodes.map((node) => (
              <div
                key={node.nodeId}
                className="rounded-md border border-border/70 bg-card px-2.5 py-2"
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="truncate text-xs font-medium text-foreground">{node.label}</span>
                  <span className="shrink-0 text-[10px] uppercase tracking-wide text-muted-foreground">
                    {node.status}
                  </span>
                </div>
                <p className="mt-1 truncate text-[11px] text-muted-foreground">
                  {node.kind}
                  {node.slot ? ` · ${node.slot.provider}:${node.slot.model}` : ""}
                </p>
                {node.estimatedContextTokens !== null || node.turnCostUsd !== null ? (
                  <p className="mt-1 text-[11px] text-muted-foreground">
                    {node.estimatedContextTokens !== null
                      ? `${node.estimatedContextTokens.toLocaleString()} context tokens`
                      : "Tokens unavailable"}
                    {node.turnCostUsd !== null ? ` · ${usd(node.turnCostUsd)}` : ""}
                  </p>
                ) : null}
                {node.sessionNotes ? (
                  <p className="mt-1 line-clamp-2 text-[11px] text-muted-foreground">
                    {node.sessionNotes.title}: {node.sessionNotes.currentState}
                  </p>
                ) : null}
                {node.compactionInput ? (
                  <p className="mt-1 line-clamp-2 text-[11px] text-muted-foreground">
                    Compacted input: {node.compactionInput.summary}
                  </p>
                ) : null}
              </div>
            ))}
          </div>
          <p className="text-[11px] text-muted-foreground">
            Context: {inspection.projectMemories.length} memories ·{" "}
            {inspection.projectSkills.length} skills
            {inspection.budgetRemainingUsd !== null
              ? ` · ${usd(inspection.budgetRemainingUsd)} budget remaining`
              : ""}
          </p>
        </div>
      ) : null}
    </section>
  );
}
