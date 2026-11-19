import type {
  WorkflowBenchmarkFinding,
  WorkflowBenchmarkInput,
  WorkflowBenchmarkPhase,
  WorkflowBenchmarkSummary,
  WorkflowBenchmarkUsage,
  WorkflowFindingOrigin,
  WorkflowRunKind,
} from "@t3tools/contracts";
import { OrchestrationCommandExecutionId, OrchestrationFileChangeId } from "@t3tools/contracts";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useDebouncedValue } from "@tanstack/react-pacer";
import { Link } from "@tanstack/react-router";
import { ChevronDownIcon, ChevronRightIcon } from "lucide-react";
import { Fragment, useEffect, useRef, useState, type RefObject } from "react";
import { formatUsd } from "../../lib/formatUsd";
import { workflowBenchmarkQueryKey } from "../../lib/workflowQueries";
import { threadCommandExecutionQueryOptions } from "../../lib/orchestrationReactQuery";
import { ensureNativeApi, readNativeApi } from "../../nativeApi";
import { formatElapsed } from "../../session-logic";
import { formatCompactTokens } from "../chat/composer/contextMeter.logic";
import { Button } from "../ui/button";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "../ui/collapsible";

type Run = Pick<WorkflowBenchmarkInput, "runKind" | "workflowId">;
type FindingSelect = Extract<WorkflowBenchmarkInput["select"], { kind: "findings" }>;
type Phase = WorkflowBenchmarkSummary["phases"][number];
const PAGE_SIZE = 50;

function queryOptions(run: Run, select: WorkflowBenchmarkInput["select"]) {
  return {
    queryKey: [...workflowBenchmarkQueryKey(run.runKind, run.workflowId), select],
    queryFn: () => ensureNativeApi().workflowPlatform.getBenchmark({ ...run, select }),
    staleTime: Infinity,
    refetchOnMount: "always" as const,
    retry: 2,
  };
}

function formatUsage(usage: WorkflowBenchmarkUsage, compact = false) {
  if (
    usage.pending &&
    usage.tokens === null &&
    usage.costUsd === null &&
    !usage.missingTokens &&
    !usage.missingCost
  )
    return "Pending";
  const tokens =
    usage.tokens === null ? "Tokens unavailable" : `${formatCompactTokens(usage.tokens)} tokens`;
  const cost =
    usage.costUsd === null
      ? "price unavailable"
      : `${usage.estimated ? "≈" : ""}${formatUsd(usage.costUsd)}`;
  const partial =
    (usage.tokens !== null && usage.missingTokens > 0) ||
    (usage.costUsd !== null && usage.missingCost > 0) ||
    usage.pending > 0;
  return `${tokens} (${cost})${partial ? (compact ? " · partial" : " · known portion") : ""}`;
}

function Usage({ usage }: { readonly usage?: WorkflowBenchmarkUsage | undefined }) {
  if (!usage) return <span aria-label="Did not participate">—</span>;
  return (
    <span title={usage.estimated ? "Includes estimated usage cost" : undefined}>
      {formatUsage(usage)}
    </span>
  );
}

function Pages(props: { offset: number; count: number; onChange: (offset: number) => void }) {
  if (props.count <= PAGE_SIZE && props.offset === 0) return null;
  return (
    <div className="flex flex-wrap items-center gap-2 px-3 py-2 text-xs">
      <span className="me-auto">
        {Math.min(props.offset + 1, props.count)}–{Math.min(props.offset + PAGE_SIZE, props.count)}{" "}
        of {props.count}
      </span>
      <Button
        size="xs"
        variant="outline"
        disabled={props.offset === 0}
        onClick={() => props.onChange(Math.max(0, props.offset - PAGE_SIZE))}
      >
        Previous
      </Button>
      <Button
        size="xs"
        variant="outline"
        disabled={props.offset + PAGE_SIZE >= props.count}
        onClick={() => props.onChange(props.offset + PAGE_SIZE)}
      >
        Next
      </Button>
    </div>
  );
}

function TurnDetails({ run, phase }: { run: Run; phase: WorkflowBenchmarkPhase }) {
  const [offset, setOffset] = useState(0);
  const query = useQuery(queryOptions(run, { kind: "turns", phase, offset }));
  const data = query.data?.kind === "turns" ? query.data : null;
  if (!data)
    return (
      <p className="px-3 py-2" role="status">
        {query.isError ? "Turn details unavailable." : "Loading turns…"}
      </p>
    );
  if (!data.count) return <p className="px-3 py-2">No attributed turns.</p>;
  return (
    <>
      <table className="w-full min-w-max text-left text-xs">
        <thead>
          <tr className="text-muted-foreground">
            {["Thread", "Model", "Role", "Attempt", "Duration", "Status", "Usage"].map((label) => (
              <th scope="col" className="px-3 py-2" key={label}>
                {label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {data.items.map((turn) => (
            <tr className="border-t border-border" key={turn.id}>
              <td className="px-3 py-2">
                {turn.threadId ? (
                  <Link
                    className="underline underline-offset-2"
                    to="/$threadId"
                    params={{ threadId: turn.threadId }}
                  >
                    {turn.threadTitle ?? turn.threadId}
                  </Link>
                ) : (
                  "Awaiting thread"
                )}
              </td>
              <td className="px-3 py-2">
                {turn.model.label}
                {turn.modelSource === "configured" && (
                  <span className="block text-muted-foreground">Configured model</span>
                )}
              </td>
              <td className="px-3 py-2">
                {turn.role}
                {turn.target && (
                  <span className="block text-muted-foreground">{turn.target.label}</span>
                )}
              </td>
              <td className="px-3 py-2">{turn.attempt}</td>
              <td className="px-3 py-2">
                {turn.durationMs === null
                  ? "Unavailable"
                  : (formatElapsed(
                      new Date(0).toISOString(),
                      new Date(turn.durationMs).toISOString(),
                    ) ?? "<1s")}
              </td>
              <td className="px-3 py-2 capitalize">{turn.status}</td>
              <td className="px-3 py-2">
                <Usage usage={turn.usage} />
                {turn.aggregateRerouteUsage && (
                  <span className="block text-muted-foreground">
                    Turn totals cover a model reroute
                  </span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <Pages offset={offset} count={data.count} onChange={setOffset} />
    </>
  );
}

function SourceLink({
  origin,
  children,
  diffFileChangeId,
}: {
  origin: WorkflowFindingOrigin;
  children: string;
  diffFileChangeId?: string | undefined;
}) {
  return (
    <Link
      to="/$threadId"
      params={{ threadId: origin.threadId }}
      search={{
        ...(origin.planId && !diffFileChangeId ? { planId: origin.planId } : {}),
        ...(origin.messageId
          ? { timelineEntryId: origin.messageId, timelineEntryKind: "message" as const }
          : {}),
        ...(diffFileChangeId
          ? {
              diff: "1" as const,
              diffTurnId: origin.turnId,
              diffFileChangeId: OrchestrationFileChangeId.make(diffFileChangeId),
            }
          : {}),
      }}
      className="underline underline-offset-2"
    >
      {children}
    </Link>
  );
}

function TestEvidence({
  evidence,
}: {
  evidence: NonNullable<WorkflowBenchmarkFinding["testEvidence"]>;
}) {
  const { data, isPending } = useQuery(
    threadCommandExecutionQueryOptions({
      threadId: evidence.origin.threadId,
      commandExecutionId: OrchestrationCommandExecutionId.make(evidence.id),
    }),
  );
  const execution = data?.commandExecution;
  return (
    <div className="space-y-1">
      <SourceLink origin={evidence.origin}>Test evidence</SourceLink>
      {execution ? (
        <p className="break-all font-mono">
          {execution.command} · Exit {execution.exitCode ?? "unavailable"}
        </p>
      ) : (
        <p className="text-muted-foreground">
          {isPending ? "Loading test execution…" : "Test execution unavailable"}
        </p>
      )}
    </div>
  );
}

const labels = {
  confirmed: "Confirmed · open",
  checking: "In verification",
  dismissed: "Dismissed",
  fixed: "Fixed",
  addressed: "Addressed",
} as const;
const filterStyle = "h-8 min-w-0 rounded-md border border-border bg-background px-2 text-xs";

function Findings({
  run,
  phase,
  models,
}: {
  run: Run;
  phase: Phase;
  models: WorkflowBenchmarkSummary["models"];
}) {
  const [filter, setFilter] = useState<Omit<FindingSelect, "kind" | "phase">>({});
  const [search] = useDebouncedValue(filter.search?.trim() ?? "", { wait: 250 });
  const heading = useRef<HTMLHeadingElement>(null);
  const [openFinding, setOpenFinding] = useState<string | null>(null);
  const query = useQuery(
    queryOptions(run, {
      ...filter,
      search,
      kind: "findings",
      phase: phase.id,
    }),
  );
  const data = query.data?.kind === "findings" ? query.data : null;
  const selected = data?.items.find(
    (finding) => finding.id === openFinding || finding.aliases.includes(openFinding ?? ""),
  );
  const modelLabel = (id: string) => models.find((model) => model.id === id)?.label ?? id;
  useEffect(() => {
    heading.current?.scrollIntoView({ block: "nearest" });
    heading.current?.focus({ preventScroll: true });
  }, []);
  return (
    <section
      className="min-w-0 border-t border-border px-4 py-3"
      aria-label={`${phase.label} findings`}
    >
      <h3 ref={heading} tabIndex={-1} className="mb-2 text-sm font-semibold">
        {phase.label} findings
      </h3>
      {data && (
        <div className="mb-3 space-y-1 text-xs text-muted-foreground">
          <p>
            {data.counts.confirmed} confirmed · {data.counts.checking} in verification ·{" "}
            {data.counts.dismissed} dismissed
          </p>
          {data.counts.confirmed > 0 && (
            <p>
              {[
                ...data.counts.exclusive.map(
                  ({ model, count }) => `${count} exclusive to ${modelLabel(model)}`,
                ),
                `${data.counts.shared} shared`,
              ].join(" · ")}
            </p>
          )}
        </div>
      )}
      <div className="flex flex-wrap gap-2">
        <input
          className={filterStyle}
          type="search"
          aria-label="Search findings"
          placeholder="Search findings"
          maxLength={500}
          value={filter.search ?? ""}
          onChange={(event) => setFilter({ ...filter, offset: 0, search: event.target.value })}
        />
        <select
          className={filterStyle}
          aria-label="Filter by model"
          value={filter.model ?? ""}
          onChange={(event) => {
            const { model: _model, ...rest } = filter;
            setFilter({
              ...rest,
              offset: 0,
              ...(event.target.value ? { model: event.target.value } : {}),
            });
          }}
        >
          <option value="">All models</option>
          {models.map((model) => (
            <option key={model.id} value={model.id}>
              {model.label}
            </option>
          ))}
        </select>
        <select
          className={filterStyle}
          aria-label="Filter by severity"
          value={filter.severity ?? ""}
          onChange={(event) => {
            const { severity: _severity, ...rest } = filter;
            const severity = event.target.value as FindingSelect["severity"];
            setFilter({ ...rest, offset: 0, ...(severity ? { severity } : {}) });
          }}
        >
          <option value="">All severities</option>
          {(["critical", "high", "medium", "low"] as const).map((severity) => (
            <option key={severity} value={severity}>
              {severity[0]!.toUpperCase() + severity.slice(1)}
            </option>
          ))}
        </select>
        <select
          className={filterStyle}
          aria-label="Filter by status"
          value={filter.status ?? ""}
          onChange={(event) => {
            const { status: _status, ...rest } = filter;
            const status = event.target.value as FindingSelect["status"];
            setFilter({ ...rest, offset: 0, ...(status ? { status } : {}) });
          }}
        >
          <option value="">All statuses</option>
          {Object.entries(labels).map(([status, label]) => (
            <option key={status} value={status}>
              {label}
            </option>
          ))}
        </select>
      </div>
      {!data ? (
        <p className="mt-2 text-xs" role="status">
          {query.isError ? "Findings unavailable." : "Loading findings…"}
        </p>
      ) : (
        <>
          <p className="mt-3 text-xs text-muted-foreground">{data.count} matching findings</p>
          <div className="overflow-x-auto">
            <table className="mt-1 w-full min-w-[32rem] text-left text-xs">
              <thead>
                <tr>
                  {["Severity", "Problem", "Found by", "Status"].map((label) => (
                    <th scope="col" className="px-2 py-2" key={label}>
                      {label}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {data.items.map((finding) => (
                  <Fragment key={finding.id}>
                    <tr className="border-t border-border align-top">
                      <td className="px-2 py-2 capitalize">{finding.severity}</td>
                      <td className="max-w-96 px-2 py-2">
                        <button
                          type="button"
                          className="text-left font-medium underline-offset-2 hover:underline"
                          aria-expanded={selected?.id === finding.id}
                          onClick={() =>
                            setOpenFinding(selected?.id === finding.id ? null : finding.id)
                          }
                        >
                          {finding.title}
                        </button>
                        {finding.location && (
                          <p className="mt-1 break-all text-muted-foreground">{finding.location}</p>
                        )}
                      </td>
                      <td className="px-2 py-2">
                        {[...new Set(finding.reporters.map(({ model }) => model.label))].join(", ")}
                      </td>
                      <td className="px-2 py-2">
                        {finding.resolution
                          ? `${labels[finding.status]} by ${finding.resolution.model.label}`
                          : labels[finding.status]}
                        {finding.test && (
                          <p className="mt-1 text-muted-foreground">
                            {finding.test === "passed"
                              ? "Test passed"
                              : finding.test === "confirmed"
                                ? "Confirmed by test"
                                : "Test reported"}
                          </p>
                        )}
                      </td>
                    </tr>
                    {selected?.id === finding.id && (
                      <tr className="border-t border-border bg-muted/30">
                        <td colSpan={4} className="space-y-2 px-3 py-2">
                          <p className="whitespace-pre-wrap">{finding.description}</p>
                          {finding.evidence.map((evidence) => (
                            <p key={evidence} className="whitespace-pre-wrap text-muted-foreground">
                              {evidence}
                            </p>
                          ))}
                          <ul className="flex flex-wrap gap-x-4 gap-y-1">
                            {finding.reporters.map(({ model, origin }) => (
                              <li key={JSON.stringify(origin)}>
                                <SourceLink origin={origin}>{`${model.label} source`}</SourceLink>
                              </li>
                            ))}
                          </ul>
                          {finding.resolution && (
                            <p>
                              <SourceLink
                                origin={finding.resolution.origin}
                                diffFileChangeId={finding.resolution.diffFileChangeId}
                              >
                                {finding.resolution.diffFileChangeId
                                  ? "Open correction diff"
                                  : "Resolution source"}
                              </SourceLink>
                              {finding.resolution.evidence && (
                                <span className="ms-2">{finding.resolution.evidence}</span>
                              )}
                            </p>
                          )}
                          {finding.testEvidence && <TestEvidence evidence={finding.testEvidence} />}
                        </td>
                      </tr>
                    )}
                  </Fragment>
                ))}
              </tbody>
            </table>
          </div>
          <Pages
            offset={filter.offset ?? 0}
            count={data.count}
            onChange={(offset) => setFilter({ ...filter, offset })}
          />
        </>
      )}
    </section>
  );
}

export function WorkflowBenchmark(props: {
  readonly workflowId: string;
  readonly runKind: WorkflowRunKind;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly triggerRef: RefObject<HTMLButtonElement | null>;
}) {
  const { runKind, workflowId } = props;
  const run = { runKind, workflowId };
  const [expanded, setExpanded] = useState<ReadonlySet<WorkflowBenchmarkPhase>>(new Set());
  const [findingPhase, setFindingPhase] = useState<WorkflowBenchmarkPhase | null>(null);
  const client = useQueryClient();
  const summary = useQuery(queryOptions(run, { kind: "summary" }));
  const data = summary.data?.kind === "summary" ? summary.data : null;

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const unsubscribe = readNativeApi()?.workflowPlatform?.onBenchmarkChanged?.((change) => {
      if (change.runKind !== runKind || change.workflowId !== workflowId || timer) return;
      timer = setTimeout(() => {
        timer = undefined;
        const queryKey = workflowBenchmarkQueryKey(runKind, workflowId);
        void client.cancelQueries({ queryKey }).then(() => client.invalidateQueries({ queryKey }));
      }, 100);
    });
    return () => {
      clearTimeout(timer);
      unsubscribe?.();
    };
  }, [client, runKind, workflowId]);
  const selectedPhase = data?.phases.find((phase) => phase.id === findingPhase);
  return (
    <Collapsible open={props.open} onOpenChange={props.onOpenChange} data-slot="workflow-benchmark">
      <section className="rounded-xl border border-border bg-card">
        <h2 className="text-sm font-semibold text-foreground">
          <CollapsibleTrigger
            ref={props.triggerRef}
            className="group flex min-h-10 w-full flex-wrap items-center gap-x-3 gap-y-1 rounded-xl px-4 py-2 text-start outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <span className="flex-1">Workflow benchmark</span>
            {data && (
              <span className="text-xs font-normal tabular-nums text-muted-foreground">
                <span className="sr-only">Usage cost </span>
                {formatUsage(data.total, true)} · {data.findings} findings
              </span>
            )}
            {!props.open && summary.isError && (
              <span className="text-xs font-normal text-muted-foreground">Update pending</span>
            )}
            <ChevronDownIcon
              aria-hidden="true"
              className="size-4 text-muted-foreground transition-transform group-data-panel-open:rotate-180"
            />
          </CollapsibleTrigger>
        </h2>
        <CollapsiblePanel>
          <div className="border-t border-border">
            {summary.isError && (
              <p className="px-4 py-2 text-xs text-muted-foreground" role="status">
                Benchmark update pending.{" "}
                <button className="underline" type="button" onClick={() => void summary.refetch()}>
                  Retry
                </button>
              </p>
            )}
            {!data && !summary.isError && (
              <p className="px-4 py-3 text-xs" role="status">
                Loading benchmark…
              </p>
            )}
            {data && (
              <>
                <div className="overflow-x-auto">
                  <table className="w-full min-w-max text-left text-xs tabular-nums">
                    <caption className="sr-only">Usage cost by phase and model</caption>
                    <thead>
                      <tr className="text-muted-foreground">
                        <th scope="col" className="px-4 py-2">
                          Phase
                        </th>
                        {data.models.map((model) => (
                          <th scope="col" className="px-4 py-2 text-right" key={model.id}>
                            {model.label}
                          </th>
                        ))}
                        <th scope="col" className="px-4 py-2 text-right">
                          Phase total
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.phases.map((phase) => (
                        <Fragment key={phase.id}>
                          <tr className="border-t border-border">
                            <th scope="row" className="px-4 py-2 font-medium">
                              <div className="flex items-center gap-2">
                                <button
                                  type="button"
                                  aria-expanded={expanded.has(phase.id)}
                                  className="flex items-center gap-1 hover:underline"
                                  onClick={() =>
                                    setExpanded((previous) => {
                                      const next = new Set(previous);
                                      if (next.has(phase.id)) next.delete(phase.id);
                                      else next.add(phase.id);
                                      return next;
                                    })
                                  }
                                >
                                  <ChevronRightIcon
                                    aria-hidden="true"
                                    className={
                                      expanded.has(phase.id) ? "size-3 rotate-90" : "size-3"
                                    }
                                  />
                                  {phase.label}
                                </button>
                                {phase.review && (
                                  <button
                                    type="button"
                                    aria-expanded={findingPhase === phase.id}
                                    aria-label={`${phase.findings} findings in ${phase.label}`}
                                    className="text-muted-foreground underline-offset-2 hover:underline"
                                    onClick={() =>
                                      setFindingPhase(findingPhase === phase.id ? null : phase.id)
                                    }
                                  >
                                    {phase.findings} findings
                                  </button>
                                )}
                              </div>
                            </th>
                            {data.models.map((model) => (
                              <td className="px-4 py-2 text-right" key={model.id}>
                                <Usage
                                  usage={phase.cells.find((cell) => cell.model === model.id)?.usage}
                                />
                              </td>
                            ))}
                            <td className="px-4 py-2 text-right font-semibold">
                              <Usage usage={phase.total} />
                            </td>
                          </tr>
                          {expanded.has(phase.id) && (
                            <tr className="border-t border-border bg-muted/30">
                              <td colSpan={data.models.length + 2}>
                                <TurnDetails run={run} phase={phase.id} />
                              </td>
                            </tr>
                          )}
                        </Fragment>
                      ))}
                    </tbody>
                    <tfoot>
                      <tr className="border-t border-border font-semibold">
                        <th scope="row" className="px-4 py-2">
                          Total
                        </th>
                        {data.models.map((model) => (
                          <td className="px-4 py-2 text-right" key={model.id}>
                            <Usage
                              usage={
                                data.modelTotals.find((cell) => cell.model === model.id)?.usage
                              }
                            />
                          </td>
                        ))}
                        <td className="px-4 py-2 text-right">
                          <Usage usage={data.total} />
                        </td>
                      </tr>
                    </tfoot>
                  </table>
                </div>
                {(data.historicalPartial ||
                  data.ambiguous > 0 ||
                  data.coverage.length > 0 ||
                  data.evaluationsIncomplete > 0) && (
                  <div className="space-y-1 border-t border-border px-4 py-2 text-xs text-muted-foreground">
                    {data.historicalPartial && <p>Partial historical coverage</p>}
                    {data.ambiguous > 0 && <p>{data.ambiguous} turns with ambiguous attribution</p>}
                    {data.evaluationsIncomplete > 0 && (
                      <p>{data.evaluationsIncomplete} incomplete finding evaluations</p>
                    )}
                    {data.coverage.map((coverage) => (
                      <p key={coverage.model}>
                        {data.models.find((model) => model.id === coverage.model)?.label}:{" "}
                        {coverage.structured}/{coverage.completed} structured reviews
                        {coverage.invalid > 0 ? ` · ${coverage.invalid} invalid` : ""}
                        {coverage.completed - coverage.structured - coverage.invalid > 0
                          ? ` · ${coverage.completed - coverage.structured - coverage.invalid} unavailable`
                          : ""}
                      </p>
                    ))}
                  </div>
                )}
                {selectedPhase && (
                  <Findings
                    key={selectedPhase.id}
                    run={run}
                    phase={selectedPhase}
                    models={data.models}
                  />
                )}
              </>
            )}
          </div>
        </CollapsiblePanel>
      </section>
    </Collapsible>
  );
}
