import type {
  WorkflowBenchmarkFinding,
  WorkflowBenchmarkInput,
  WorkflowBenchmarkMetricScope,
  WorkflowBenchmarkPhase,
  WorkflowBenchmarkSummary,
  WorkflowBenchmarkTurn,
  WorkflowBenchmarkUsage,
  WorkflowFindingOrigin,
  WorkflowRunKind,
} from "@t3tools/contracts";
import { OrchestrationCommandExecutionId, OrchestrationFileChangeId } from "@t3tools/contracts";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useDebouncedValue } from "@tanstack/react-pacer";
import { Link } from "@tanstack/react-router";
import { ChevronDownIcon, ChevronRightIcon } from "lucide-react";
import {
  Fragment,
  useEffect,
  useLayoutEffect,
  useRef,
  type Dispatch,
  type RefObject,
  type SetStateAction,
} from "react";
import { formatUsd } from "../../lib/formatUsd";
import { workflowBenchmarkQueryKey } from "../../lib/workflowQueries";
import { threadCommandExecutionQueryOptions } from "../../lib/orchestrationReactQuery";
import { ensureNativeApi, readNativeApi } from "../../nativeApi";
import { formatElapsed } from "../../session-logic";
import { formatCompactTokens } from "../chat/composer/contextMeter.logic";
import { Button } from "../ui/button";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "../ui/collapsible";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import type {
  BenchmarkFindingsView,
  BenchmarkReviewTurn,
  BenchmarkView,
} from "./workflowBenchmarkViewState";

type Run = Pick<WorkflowBenchmarkInput, "runKind" | "workflowId">;
type FindingSelect = Extract<WorkflowBenchmarkInput["select"], { kind: "findings" }>;
type Phase = WorkflowBenchmarkSummary["phases"][number];
type SetBenchmarkView = Dispatch<SetStateAction<BenchmarkView>>;
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

function formatCreditEstimate(credits: number) {
  return credits > 0 && credits < 0.01 ? "<0.01" : `≈${credits.toFixed(2)}`;
}

function UsageColumnHeader({
  label,
  summary,
  modelId,
}: {
  label: string;
  summary: WorkflowBenchmarkSummary;
  modelId?: string;
}) {
  const usage =
    modelId === undefined
      ? summary.total
      : summary.modelTotals.find((cell) => cell.model === modelId)?.usage;
  if (!usage) return label;

  const credits = usage.estimatedCodexCredits;
  return (
    <Tooltip>
      <TooltipTrigger
        type="button"
        className="cursor-help rounded-sm focus-visible:outline-2 focus-visible:outline-ring"
      >
        {label}
      </TooltipTrigger>
      <TooltipPopup side="bottom">
        <div className="space-y-1 py-1 text-start tabular-nums">
          <p>{formatUsage(usage, true)}</p>
          {credits !== undefined && (
            <>
              <p>{formatCreditEstimate(credits)} Codex Standard credits</p>
              <dl className="grid grid-cols-[1fr_auto] gap-x-3 text-muted-foreground">
                {summary.phases.map((phase) => {
                  const phaseCredits = (
                    modelId === undefined
                      ? phase.total
                      : phase.cells.find((cell) => cell.model === modelId)?.usage
                  )?.estimatedCodexCredits;
                  if (phaseCredits === undefined) return null;
                  return (
                    <Fragment key={phase.id}>
                      <dt>{phase.label}</dt>
                      <dd className="text-end">{formatCreditEstimate(phaseCredits)}</dd>
                    </Fragment>
                  );
                })}
              </dl>
            </>
          )}
        </div>
      </TooltipPopup>
    </Tooltip>
  );
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

function metricScopeLabel(scope: WorkflowBenchmarkMetricScope) {
  switch (scope) {
    case "main-agent":
      return "Main agent";
    case "provider-total":
      return "Provider total (may include subagents)";
    case "unknown":
      return "Scope unreported";
  }
}

function Subagents({
  agents,
  open,
  onOpenChange,
}: {
  agents: NonNullable<WorkflowBenchmarkTurn["subagents"]>;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <details
      className="mx-auto mt-1 max-w-80"
      open={open}
      onToggle={(event) => {
        if (event.currentTarget.open !== open) onOpenChange(event.currentTarget.open);
      }}
    >
      <summary className="cursor-pointer text-muted-foreground">
        {agents.length} {agents.length === 1 ? "subagent" : "subagents"}
      </summary>
      <ul className="mt-1 space-y-2 border-s border-border ps-2">
        {agents.map((agent) => (
          <li key={agent.id} className="whitespace-normal">
            <div className="break-words font-medium">{agent.label}</div>
            <div className="text-muted-foreground">
              {agent.model?.label ?? "Model unreported"} · {agent.status}
            </div>
            <div className="text-muted-foreground">
              {agent.tokens === null
                ? "Tokens unreported"
                : `${formatCompactTokens(agent.tokens)} tokens`}
              {" · "}
              {agent.costUsd === null ? "Cost unreported" : formatUsd(agent.costUsd)}
            </div>
          </li>
        ))}
      </ul>
    </details>
  );
}

function TurnDetails({
  run,
  phase,
  view,
  setView,
  onToggleFindings,
}: {
  run: Run;
  phase: Phase;
  view: BenchmarkView;
  setView: SetBenchmarkView;
  onToggleFindings: (turn: BenchmarkReviewTurn) => void;
}) {
  const offset = view.turnOffsets[phase.id] ?? 0;
  const selectedTurn = view.findings?.phase === phase.id ? view.findings.turn : undefined;
  const query = useQuery(queryOptions(run, { kind: "turns", phase: phase.id, offset }));
  const data = query.data?.kind === "turns" ? query.data : null;
  return (
    <>
      <table className="w-full min-w-[44rem] text-center text-xs">
        <caption className="sr-only">{phase.label} turns</caption>
        <thead className="bg-muted">
          <tr className="text-muted-foreground">
            {["Thread", "Model", "Role", "Attempt", "Duration", "Status", "Usage"].map((label) => (
              <th scope="col" className="whitespace-nowrap px-3 py-2" key={label}>
                {label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {!data?.items.length && (
            <tr className="border-t border-border">
              <td colSpan={7} className="px-3 py-2">
                <span role="status">
                  {data
                    ? "No attributed turns."
                    : query.isError
                      ? "Turn details unavailable."
                      : "Loading turns…"}
                </span>
              </td>
            </tr>
          )}
          {data?.items.map((turn) => {
            const selected =
              selectedTurn?.turnId === turn.turnId && selectedTurn?.threadId === turn.threadId;
            return (
              <tr
                data-selected={selected}
                className="border-t border-border hover:bg-muted data-[selected=true]:bg-ring/12"
                key={turn.id}
              >
                <td className="px-3 py-2">
                  {turn.threadId ? (
                    <Link
                      data-benchmark-thread-link
                      className="underline underline-offset-2 [overflow-wrap:anywhere]"
                      to="/$threadId"
                      params={{ threadId: turn.threadId }}
                    >
                      {turn.threadTitle ?? turn.threadId}
                    </Link>
                  ) : (
                    "Awaiting thread"
                  )}
                  {!!turn.subagents?.length && (
                    <Subagents
                      agents={turn.subagents}
                      open={view.openSubagents.includes(turn.id)}
                      onOpenChange={(open) =>
                        setView((previous) => ({
                          ...previous,
                          openSubagents: open
                            ? [...previous.openSubagents, turn.id]
                            : previous.openSubagents.filter((id) => id !== turn.id),
                        }))
                      }
                    />
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
                  {(() => {
                    const review = phase.findingTurns?.find(
                      ({ threadId, turnId }) =>
                        threadId === turn.threadId && turnId === turn.turnId,
                    );
                    if (!review || !turn.reviewer) return null;
                    if (review.count === 0) {
                      return <span className="mt-1 block text-muted-foreground">0 findings</span>;
                    }
                    const scope = {
                      threadId: review.threadId,
                      turnId: review.turnId,
                      reviewer: turn.reviewer.id,
                      label: turn.reviewer.label,
                      attempt: turn.attempt,
                    };
                    const label = `${review.count} ${review.count === 1 ? "finding" : "findings"}`;
                    return (
                      <button
                        type="button"
                        className="mx-auto mt-1 block cursor-pointer rounded px-1.5 underline underline-offset-2"
                        aria-label={`${label} from ${scope.label}, attempt ${scope.attempt}`}
                        aria-pressed={selected}
                        onClick={() => onToggleFindings(scope)}
                      >
                        {label}
                      </button>
                    );
                  })()}
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
                  {turn.tokenScope && (
                    <span className="block text-muted-foreground">
                      Tokens: {metricScopeLabel(turn.tokenScope)}
                    </span>
                  )}
                  {turn.costScope && (
                    <span className="block text-muted-foreground">
                      Cost: {metricScopeLabel(turn.costScope)}
                    </span>
                  )}
                  {turn.aggregateRerouteUsage && (
                    <span className="block text-muted-foreground">
                      Turn totals cover a model reroute
                    </span>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {data && (
        <Pages
          offset={offset}
          count={data.count}
          onChange={(offset) =>
            setView((previous) => ({
              ...previous,
              turnOffsets: { ...previous.turnOffsets, [phase.id]: offset },
            }))
          }
        />
      )}
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
      data-benchmark-thread-link
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
  view,
  onChange,
  heading,
}: {
  run: Run;
  phase: Phase;
  models: WorkflowBenchmarkSummary["models"];
  view: BenchmarkFindingsView;
  onChange: (view: BenchmarkFindingsView) => void;
  heading: RefObject<HTMLHeadingElement | null>;
}) {
  const { filter, turn, openFinding } = view;
  const setFilter = (filter: BenchmarkFindingsView["filter"]) => onChange({ ...view, filter });
  const [search] = useDebouncedValue(filter.search?.trim() ?? "", { wait: 250 });
  const query = useQuery(
    queryOptions(run, {
      ...filter,
      search,
      kind: "findings",
      phase: phase.id,
      ...(turn ? { reviewTurn: { threadId: turn.threadId, turnId: turn.turnId } } : {}),
    }),
  );
  const data = query.data?.kind === "findings" ? query.data : null;
  const selected = data?.items.find(
    (finding) => finding.id === openFinding || finding.aliases.includes(openFinding ?? ""),
  );
  return (
    <section
      className="min-w-0 rounded-lg border border-border bg-card px-4 py-3"
      aria-label={`${phase.label} findings`}
    >
      <h3 ref={heading} tabIndex={-1} className="mb-2 text-sm font-semibold outline-none">
        {turn ? `${turn.label} findings · attempt ${turn.attempt}` : `${phase.label} findings`}
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
                  ({ reviewer, count }) => `${count} exclusive to ${reviewer.label}`,
                ),
                `${data.counts.shared} shared`,
              ].join(" · ")}
            </p>
          )}
        </div>
      )}
      <div className="flex flex-wrap items-center gap-2">
        {!!phase.reviewers?.length && (
          <select
            className={filterStyle}
            aria-label="Filter by reviewer"
            value={filter.reviewer ?? ""}
            onChange={(event) => {
              const { reviewer: _reviewer, ...rest } = filter;
              onChange({
                ...view,
                turn: undefined,
                filter: {
                  ...rest,
                  offset: 0,
                  ...(event.target.value ? { reviewer: event.target.value } : {}),
                },
              });
            }}
          >
            <option value="">All reviewers</option>
            {phase.reviewers.map((reviewer) => (
              <option key={reviewer.id} value={reviewer.id}>
                {reviewer.label}
              </option>
            ))}
          </select>
        )}
        {turn && (
          <Button
            size="xs"
            variant="outline"
            onClick={() => onChange({ ...view, turn: undefined, filter: { ...filter, offset: 0 } })}
          >
            Show all turns for this reviewer
          </Button>
        )}
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
          <div
            className="mt-1 overflow-x-auto rounded-md border border-border"
            data-benchmark-scroll={`findings:${phase.id}`}
          >
            <table className="w-full min-w-[32rem] text-center text-xs">
              <thead className="bg-muted text-muted-foreground">
                <tr>
                  {["Severity", "Problem", "Found by", "Status"].map((label) => (
                    <th scope="col" className="whitespace-nowrap px-3 py-2" key={label}>
                      {label}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {data.items.map((finding) => (
                  <Fragment key={finding.id}>
                    <tr
                      data-expanded={selected?.id === finding.id}
                      className="border-t border-border align-middle hover:bg-muted data-[expanded=true]:bg-foreground/8"
                    >
                      <td className="px-2 py-2 capitalize">{finding.severity}</td>
                      <td className="max-w-96 px-2 py-2">
                        <button
                          type="button"
                          className="cursor-pointer text-center font-medium underline-offset-2 hover:underline"
                          aria-expanded={selected?.id === finding.id}
                          onClick={() =>
                            onChange({
                              ...view,
                              openFinding: selected?.id === finding.id ? null : finding.id,
                            })
                          }
                        >
                          {finding.title}
                        </button>
                        {finding.location && (
                          <p className="mt-1 break-all text-muted-foreground">{finding.location}</p>
                        )}
                      </td>
                      <td className="px-2 py-2">
                        {[
                          ...new Set(
                            finding.reporters.map(({ reviewer, model, discoveredBy }) =>
                              discoveredBy
                                ? `${discoveredBy.label} via ${reviewer?.label ?? model.label}`
                                : (reviewer?.label ?? model.label),
                            ),
                          ),
                        ].join(", ")}
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
                      <tr className="border-t border-border bg-muted">
                        <td
                          colSpan={4}
                          className="space-y-2 border-s-2 border-s-ring/60 px-4 py-3 text-start"
                        >
                          <p className="whitespace-pre-wrap">{finding.description}</p>
                          {finding.evidence.map((evidence) => (
                            <p key={evidence} className="whitespace-pre-wrap text-muted-foreground">
                              {evidence}
                            </p>
                          ))}
                          <ul className="flex flex-wrap gap-x-4 gap-y-1">
                            {finding.reporters.map(({ model, origin, reviewer, discoveredBy }) => (
                              <li key={JSON.stringify([origin, discoveredBy?.id])}>
                                <SourceLink
                                  origin={origin}
                                >{`${reviewer?.label ?? model.label} source`}</SourceLink>
                                {reviewer && (
                                  <span className="ms-1 text-muted-foreground">
                                    ({model.label})
                                  </span>
                                )}
                                {discoveredBy && (
                                  <p className="mt-1 text-muted-foreground">
                                    Found by {discoveredBy.label} · incorporated by{" "}
                                    {reviewer?.label ?? model.label}
                                    {discoveredBy.evidence && (
                                      <span className="block whitespace-pre-wrap">
                                        {discoveredBy.evidence}
                                      </span>
                                    )}
                                  </p>
                                )}
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
  readonly view: BenchmarkView;
  readonly setView: SetBenchmarkView;
  readonly triggerRef: RefObject<HTMLButtonElement | null>;
}) {
  const { runKind, workflowId, view, setView } = props;
  const run = { runKind, workflowId };
  const { findings, expanded, open } = view;
  const heading = useRef<HTMLHeadingElement>(null);
  const focusFindings = useRef(false);
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
  useLayoutEffect(() => {
    if (!focusFindings.current || !heading.current) return;
    focusFindings.current = false;
    heading.current.scrollIntoView({ block: "nearest" });
    heading.current.focus({ preventScroll: true });
  }, [findings, data, open]);

  function toggleFindings(phase: WorkflowBenchmarkPhase, turn?: BenchmarkReviewTurn) {
    const alreadySelected =
      findings?.phase === phase &&
      findings.turn?.threadId === turn?.threadId &&
      findings.turn?.turnId === turn?.turnId;
    focusFindings.current = !alreadySelected;
    setView((previous) => ({
      ...previous,
      expanded: previous.expanded.includes(phase)
        ? previous.expanded
        : [...previous.expanded, phase],
      findings: alreadySelected
        ? null
        : { phase, turn, filter: turn ? { reviewer: turn.reviewer } : {}, openFinding: null },
    }));
  }

  return (
    <Collapsible
      open={open}
      onOpenChange={(open) => setView((previous) => ({ ...previous, open }))}
      data-slot="workflow-benchmark"
    >
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
            {!open && summary.isError && (
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
                <div className="overflow-x-auto" data-benchmark-scroll="summary">
                  <table className="w-full text-left text-xs tabular-nums">
                    <caption className="sr-only">Usage cost by phase and model</caption>
                    <thead>
                      <tr className="text-center text-muted-foreground">
                        <th scope="col" className="px-4 py-2">
                          Phase
                        </th>
                        {data.models.map((model) => (
                          <th scope="col" className="px-4 py-2" key={model.id}>
                            <UsageColumnHeader
                              label={model.label}
                              summary={data}
                              modelId={model.id}
                            />
                          </th>
                        ))}
                        <th scope="col" className="px-4 py-2">
                          <UsageColumnHeader label="Phase total" summary={data} />
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.phases.map((phase) => {
                        const turnsOpen = expanded.includes(phase.id);
                        const phaseFindings = findings?.phase === phase.id ? findings : null;
                        const findingCount = `${phase.findings} ${phase.findings === 1 ? "finding" : "findings"}`;
                        return (
                          <Fragment key={phase.id}>
                            <tr
                              data-expanded={turnsOpen}
                              className="border-t border-border hover:bg-muted data-[expanded=true]:bg-foreground/8"
                            >
                              <th scope="row" className="px-4 py-2 font-medium">
                                <div className="flex items-center gap-2 whitespace-nowrap">
                                  <button
                                    type="button"
                                    aria-expanded={turnsOpen}
                                    className="flex cursor-pointer items-center gap-1 hover:underline"
                                    onClick={() =>
                                      setView((previous) => ({
                                        ...previous,
                                        expanded: turnsOpen
                                          ? previous.expanded.filter((id) => id !== phase.id)
                                          : [...previous.expanded, phase.id],
                                        findings:
                                          turnsOpen && previous.findings?.phase === phase.id
                                            ? null
                                            : previous.findings,
                                      }))
                                    }
                                  >
                                    <ChevronRightIcon
                                      aria-hidden="true"
                                      className={turnsOpen ? "size-3 rotate-90" : "size-3"}
                                    />
                                    {phase.label}
                                  </button>
                                  {phase.review &&
                                    (phase.findings === 0 ? (
                                      <span className="text-muted-foreground">{findingCount}</span>
                                    ) : (
                                      <button
                                        type="button"
                                        aria-expanded={
                                          phaseFindings !== null && !phaseFindings.turn
                                        }
                                        aria-label={`${findingCount} in ${phase.label}`}
                                        className="cursor-pointer text-muted-foreground underline-offset-2 hover:underline"
                                        onClick={() => toggleFindings(phase.id)}
                                      >
                                        {findingCount}
                                      </button>
                                    ))}
                                </div>
                              </th>
                              {data.models.map((model) => (
                                <td className="px-4 py-2 text-right" key={model.id}>
                                  <Usage
                                    usage={
                                      phase.cells.find((cell) => cell.model === model.id)?.usage
                                    }
                                  />
                                </td>
                              ))}
                              <td className="px-4 py-2 text-right font-semibold">
                                <Usage usage={phase.total} />
                              </td>
                            </tr>
                            {turnsOpen && (
                              <tr className="border-t border-border bg-muted">
                                <td colSpan={data.models.length + 2} className="px-4 py-3">
                                  <div className="space-y-3 [contain:inline-size]">
                                    <div
                                      className="overflow-x-auto rounded-lg border border-border border-s-2 border-s-ring/60 bg-background"
                                      data-benchmark-scroll={`turns:${phase.id}`}
                                    >
                                      <TurnDetails
                                        run={run}
                                        phase={phase}
                                        view={view}
                                        setView={setView}
                                        onToggleFindings={(turn) => toggleFindings(phase.id, turn)}
                                      />
                                    </div>
                                    {phaseFindings && (
                                      <Findings
                                        key={JSON.stringify([
                                          phase.id,
                                          phaseFindings.turn?.threadId,
                                          phaseFindings.turn?.turnId,
                                        ])}
                                        run={run}
                                        phase={phase}
                                        models={data.models}
                                        view={phaseFindings}
                                        onChange={(findings) =>
                                          setView((previous) => ({ ...previous, findings }))
                                        }
                                        heading={heading}
                                      />
                                    )}
                                  </div>
                                </td>
                              </tr>
                            )}
                          </Fragment>
                        );
                      })}
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
              </>
            )}
          </div>
        </CollapsiblePanel>
      </section>
    </Collapsible>
  );
}
