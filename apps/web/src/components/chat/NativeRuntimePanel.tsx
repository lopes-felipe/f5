import { Button } from "../ui/button";
import { Input } from "../ui/input";
import {
  Dialog,
  DialogTrigger,
  DialogPopup,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogPanel,
} from "../ui/dialog";
import type { CompactRuntimeConfiguredActivityPayload } from "@t3tools/contracts";
import { SlidersHorizontalIcon } from "lucide-react";
import { parseNativeReviewTarget } from "@t3tools/shared/nativeReviewTarget";
import { readNativeTaskIdentity } from "@t3tools/shared/nativeTaskIdentity";
import { useEffect, useRef, useState } from "react";
import { CommandId } from "@t3tools/contracts";
import type {
  NativeOperationCommand,
  NativeOperationRecord,
  ProviderSessionCapabilities,
  ThreadId,
  OrchestrationThreadActivity,
  ThreadBackgroundWorkEntry,
} from "@t3tools/contracts";
import { readNativeApi } from "../../nativeApi";
import { recentRuntimeNotices, resolveRuntimeModelReport } from "./runtimePresentation";

const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" ? (value as Record<string, unknown>) : {};
interface NativeRuntimePanelProps {
  threadId: ThreadId;
  capabilities: ProviderSessionCapabilities | null | undefined;
  activities: readonly OrchestrationThreadActivity[];
  requestedModel: string;
  runtime: CompactRuntimeConfiguredActivityPayload | null;
  outcome?: string | undefined;
  prompt: string;
  latestMessageAt?: string | undefined;
  onSuggestion: (text: string) => void;
  onStop: () => Promise<void>;
}

export function NativeRuntimePanel(props: NativeRuntimePanelProps) {
  return <NativeRuntimePanelContent key={props.threadId} {...props} />;
}

function NativeRuntimePanelContent(props: NativeRuntimePanelProps) {
  const [open, setOpen] = useState(false);
  const { threadId, capabilities, activities, prompt } = props;
  const [records, setRecords] = useState<readonly NativeOperationRecord[]>([]);
  const [tasks, setTasks] = useState<readonly ThreadBackgroundWorkEntry[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [detail, setDetail] = useState<unknown>(null);
  const [inspection, setInspection] = useState<{
    nativeId: string;
    nextCursor: string | null;
  } | null>(null);
  const [reading, setReading] = useState(false);
  const [objective, setObjective] = useState("");
  const [budget, setBudget] = useState(10000);
  const [reviewTarget, setReviewTarget] = useState("");
  const [usedSuggestion, setUsedSuggestion] = useState<string | null>(null);
  const mutationVersion = useRef(0);
  const promptBefore = useRef(prompt);
  const suggestion = activities.findLast((entry) => entry.kind === "prompt.suggestion");
  useEffect(() => {
    if (promptBefore.current !== prompt && suggestion) setUsedSuggestion(suggestion.id);
    promptBefore.current = prompt;
  }, [prompt, suggestion]);
  useEffect(() => {
    let alive = true;
    let refreshing = false;
    const refresh = async () => {
      if (refreshing) return;
      refreshing = true;
      const api = readNativeApi();
      if (!api?.nativeOperations) {
        refreshing = false;
        return;
      }
      try {
        const version = mutationVersion.current;
        const [next, snapshot] = await Promise.all([
          api.nativeOperations.list({ threadId }),
          open ? api.agents.getSnapshot() : Promise.resolve({ entries: [] }),
        ]);
        if (alive) {
          // Ignore a poll started before a local receipt arrived. The next poll
          // replaces the snapshot authoritatively, including missing records.
          if (version === mutationVersion.current) setRecords(next);
          setTasks(snapshot.entries.filter((entry) => entry.threadId === threadId));
        }
      } catch {
        /* Connection surfaces already report transport failures. */
      } finally {
        refreshing = false;
      }
    };
    void refresh();
    const timer = window.setInterval(() => void refresh(), 5000);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, [threadId, capabilities?.generation, open]);
  const supported = (action: string) =>
    capabilities?.actions.some((entry) => entry.action === action && entry.supported) === true;
  const execute = async (command: NativeOperationCommand) => {
    const api = readNativeApi()?.nativeOperations;
    if (!api || !capabilities || busy) return;
    setBusy(true);
    setError(null);
    try {
      const record = await api.execute({
        threadId,
        operationId: crypto.randomUUID(),
        generation: capabilities.generation,
        command,
      });
      mutationVersion.current++;
      setRecords((current) => [
        record,
        ...current.filter((entry) => entry.operationId !== record.operationId),
      ]);
      if (record.error) setError(record.error);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The native operation failed.");
    } finally {
      setBusy(false);
    }
  };
  const review = async () => {
    try {
      await execute({ kind: "review", target: parseNativeReviewTarget(reviewTarget) });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Review target is invalid.");
    }
  };
  const resolve = async (record: NativeOperationRecord, action: "reconcile" | "acknowledge") => {
    const api = readNativeApi()?.nativeOperations;
    if (!api?.resolve || !capabilities || busy) return;
    if (
      action === "acknowledge" &&
      !window.confirm(
        "Stop the provider and accept this uncertain outcome? Files, conversation or forks may already have changed. F5 will release the reservation without repeating the operation. Inspect any affected workspace before continuing.",
      )
    )
      return;
    setBusy(true);
    setError(null);
    try {
      const next = await api.resolve({
        threadId,
        operationId: record.operationId,
        generation: capabilities.generation,
        action,
      });
      mutationVersion.current++;
      setRecords((current) =>
        current.map((entry) => (entry.operationId === next.operationId ? next : entry)),
      );
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Outcome resolution failed.");
    } finally {
      setBusy(false);
    }
  };
  const inspect = async (nativeId: string, cursor?: string) => {
    if (!capabilities) return;
    const api = readNativeApi()?.nativeOperations;
    if (!api?.inspect) {
      setError("Native output API is unavailable.");
      return;
    }
    setReading(true);
    try {
      const identity = readNativeTaskIdentity(nativeId);
      const page = await api.inspect({
        threadId,
        generation: capabilities.generation,
        kind: "task",
        nativeId: identity.taskId,
        ...(identity.runId ? { runId: identity.runId } : {}),
        limit: 20,
        ...(cursor ? { cursor } : {}),
      });
      setDetail(page);
      setInspection({
        nativeId,
        nextCursor:
          typeof object(page).nextCursor === "string" ? (object(page).nextCursor as string) : null,
      });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Native output is unavailable.");
    } finally {
      setReading(false);
    }
  };
  const info = props.runtime;
  const normalized = info?.runtimeInfo;
  const effective = normalized?.effective;
  const requested = normalized?.requested;
  const warnings = recentRuntimeNotices(activities);
  const modelReport = resolveRuntimeModelReport({ configuredRuntime: info, activities });
  const goal = object(
    activities.findLast(
      (entry) => entry.kind === "native.metadata" && "nativeGoal" in object(entry.payload),
    )?.payload,
  ).nativeGoal;
  const attachments = activities.filter(
    (entry) => entry.kind === "native.metadata" && "nativeAttachment" in object(entry.payload),
  );
  const visibleSuggestion =
    suggestion &&
    usedSuggestion !== suggestion.id &&
    !prompt &&
    (!props.latestMessageAt || suggestion.createdAt > props.latestMessageAt);
  const running =
    busy ||
    records.some((record) =>
      ["requested", "dispatched", "running", "indeterminate"].includes(record.state),
    );
  return (
    <div
      data-slot="native-runtime-controls"
      className="flex h-7 min-w-0 max-w-full items-center gap-2 px-2 text-xs text-muted-foreground"
    >
      {visibleSuggestion && (
        <Button
          variant="ghost"
          size="xs"
          className="min-w-0 max-w-64 shrink"
          onClick={() => {
            setUsedSuggestion(suggestion.id);
            props.onSuggestion(suggestion.summary);
          }}
        >
          <span className="truncate">Suggested prompt: {suggestion.summary}</span>
        </Button>
      )}
      {goal != null && (
        <span className="min-w-0 max-w-48 truncate" title={String(object(goal).objective ?? "")}>
          Goal · {String(object(goal).status ?? "unknown")}
        </span>
      )}
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogTrigger render={<Button variant="ghost" size="xs" />}>
          <SlidersHorizontalIcon /> Runtime details{running ? " · pending" : ""}
        </DialogTrigger>
        <DialogPopup className="max-h-[min(80dvh,48rem)] max-w-2xl">
          <DialogHeader>
            <DialogTitle>Runtime details</DialogTitle>
            <DialogDescription>
              Session settings, provider notices and native actions.
            </DialogDescription>
          </DialogHeader>
          <DialogPanel className="space-y-5 text-sm">
            <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-2 [&_dt]:text-muted-foreground [&_dd]:break-words">
              <dt>Requested model</dt>
              <dd>
                {requested?.model ??
                  (modelReport.reroute ? info?.model : undefined) ??
                  props.requestedModel}
              </dd>
              <dt>Effective model</dt>
              <dd>{modelReport.model ?? "Not reported by provider"}</dd>
              {(effective?.effort ?? info?.effort ?? info?.reasoning) && (
                <>
                  <dt>Effort</dt>
                  <dd>{effective?.effort ?? info?.effort ?? info?.reasoning}</dd>
                </>
              )}
              {(effective?.thinking ?? info?.thinkingState) && (
                <>
                  <dt>Thinking</dt>
                  <dd>{effective?.thinking ?? info?.thinkingState}</dd>
                </>
              )}
              {(effective?.fastMode ?? info?.fastModeState) && (
                <>
                  <dt>Fast mode</dt>
                  <dd>{effective?.fastMode ?? info?.fastModeState}</dd>
                </>
              )}
              {props.outcome && (
                <>
                  <dt>Latest turn</dt>
                  <dd>{props.outcome}</dd>
                </>
              )}
            </dl>
            {normalized?.fallback && <p>{normalized.fallback}</p>}
            {warnings.length > 0 && (
              <section aria-label="Provider notices" className="space-y-2">
                <h3 className="font-medium">Provider notices</h3>
                {warnings.map((warning) => (
                  <div
                    key={warning.id}
                    className="break-words rounded-lg border border-border bg-muted/40 p-3 text-muted-foreground"
                  >
                    <p className="font-medium text-foreground">{warning.title}</p>
                    {warning.details.map((detail) => (
                      <p key={detail} className="mt-1">
                        {detail}
                      </p>
                    ))}
                  </div>
                ))}
              </section>
            )}
            {(supported("nativeCompaction") ||
              supported("nativeReview") ||
              supported("nativeGoals") ||
              running) && (
              <section aria-label="Native actions" className="space-y-3">
                <h3 className="font-medium">Native actions</h3>
                {supported("nativeCompaction") && (
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={running}
                    onClick={() => {
                      const api = readNativeApi();
                      if (!api) {
                        setError("Compaction API is unavailable.");
                        return;
                      }
                      void api.orchestration
                        .dispatchCommand({
                          type: "thread.compact.request",
                          commandId: CommandId.makeUnsafe(crypto.randomUUID()),
                          threadId,
                          trigger: "manual",
                          createdAt: new Date().toISOString(),
                        })
                        .catch((cause: unknown) =>
                          setError(cause instanceof Error ? cause.message : "Compaction failed."),
                        );
                    }}
                  >
                    Compact conversation
                  </Button>
                )}
                {supported("nativeReview") && (
                  <div className="space-y-2">
                    <label htmlFor={`review-target-${threadId}`} className="text-muted-foreground">
                      Review target
                    </label>
                    <div className="flex items-center gap-2">
                      <Input
                        id={`review-target-${threadId}`}
                        aria-label="Review base branch or commit"
                        placeholder="Branch, commit:<SHA>, or blank for changes"
                        value={reviewTarget}
                        onChange={(event) => setReviewTarget(event.target.value)}
                      />
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={running}
                        onClick={() => void review()}
                      >
                        Review
                      </Button>
                    </div>
                  </div>
                )}
                {supported("nativeGoals") && (
                  <div className="space-y-2">
                    <label htmlFor={`goal-${threadId}`} className="text-muted-foreground">
                      Goal objective
                    </label>
                    <Input
                      id={`goal-${threadId}`}
                      aria-label="Goal objective"
                      placeholder="What should the agent achieve?"
                      value={objective}
                      onChange={(event) => setObjective(event.target.value)}
                    />
                    <div className="flex flex-wrap items-center gap-2">
                      <label htmlFor={`goal-budget-${threadId}`} className="text-muted-foreground">
                        Token budget
                      </label>
                      <Input
                        id={`goal-budget-${threadId}`}
                        aria-label="Goal token budget"
                        className="w-28"
                        type="number"
                        min={1}
                        value={budget}
                        onChange={(event) => setBudget(Number(event.target.value))}
                      />
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={
                          running ||
                          !objective.trim() ||
                          !Number.isSafeInteger(budget) ||
                          budget < 1
                        }
                        onClick={() =>
                          void execute({ kind: "goalSet", objective, tokenBudget: budget })
                        }
                      >
                        Start goal
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={running}
                        onClick={() => void execute({ kind: "goalClear" })}
                      >
                        Clear settled goal
                      </Button>
                    </div>
                  </div>
                )}
                {running && (
                  <Button variant="outline" size="sm" onClick={() => void props.onStop()}>
                    Interrupt conversation turn
                  </Button>
                )}
              </section>
            )}
            {tasks.length > 0 && (
              <section aria-label="Background tasks" className="space-y-2">
                <h3 className="font-medium">Background tasks</h3>
                {tasks.map((task) => (
                  <div
                    key={task.workItemId}
                    className="flex flex-wrap items-center gap-2 rounded-lg border p-3"
                  >
                    <span className="min-w-0 flex-1 break-words">
                      {task.phase ?? task.workItemId} · {task.status}
                    </span>
                    {supported("childTaskInspection") && (
                      <Button
                        variant="outline"
                        size="xs"
                        disabled={reading}
                        onClick={() => void inspect(task.workItemId)}
                      >
                        Inspect output
                      </Button>
                    )}
                    {task.active && supported("childTaskStop") && (
                      <Button
                        variant="outline"
                        size="xs"
                        disabled={busy}
                        onClick={() =>
                          void execute({
                            kind: "stopTask",
                            ...readNativeTaskIdentity(task.workItemId),
                          })
                        }
                      >
                        Stop task
                      </Button>
                    )}
                  </div>
                ))}
              </section>
            )}
            {attachments.slice(-20).map((entry) => (
              <p key={entry.id}>
                From Codex:{" "}
                {String(
                  object(object(entry.payload).nativeAttachment).attachmentType ?? "attachment",
                )}{" "}
                · {String(object(object(entry.payload).nativeAttachment).operation ?? "updated")}
              </p>
            ))}
            {records.length > 0 && (
              <section aria-label="Operation history" className="space-y-2">
                <h3 className="font-medium">Operation history</h3>
                {records.slice(0, 8).map((record) => (
                  <div key={record.operationId} className="space-y-2 rounded-lg border p-3">
                    <p>
                      {record.command.kind} · {record.state}
                      {record.staleGeneration ? " · belongs to an older session" : ""}
                    </p>
                    {record.error && (
                      <p className="break-words text-muted-foreground">{record.error}</p>
                    )}
                    {record.command.kind === "fork" && (
                      <p className="break-words text-muted-foreground">
                        Preserved workspace: {record.command.cwd}
                      </p>
                    )}
                    {(record.state === "indeterminate" ||
                      (record.state === "cancelled" && record.command.kind === "revertFiles")) && (
                      <div className="flex flex-wrap gap-2">
                        <Button
                          variant="outline"
                          size="xs"
                          disabled={busy || !capabilities}
                          onClick={() => void resolve(record, "reconcile")}
                        >
                          Recheck outcome
                        </Button>
                        <Button
                          variant="outline"
                          size="xs"
                          disabled={busy || !capabilities}
                          onClick={() => void resolve(record, "acknowledge")}
                        >
                          {record.state === "cancelled"
                            ? "Finish acknowledgement"
                            : "Stop provider and acknowledge"}
                        </Button>
                      </div>
                    )}
                  </div>
                ))}
              </section>
            )}
            {detail !== null && (
              <pre className="max-h-72 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-muted p-3 text-xs">
                {JSON.stringify(detail, null, 2)}
              </pre>
            )}
            {inspection?.nextCursor && (
              <Button
                variant="outline"
                size="sm"
                disabled={reading}
                onClick={() => void inspect(inspection.nativeId, inspection.nextCursor!)}
              >
                Next output page
              </Button>
            )}
            {error && (
              <p role="alert" className="break-words text-destructive">
                {error}
              </p>
            )}
          </DialogPanel>
        </DialogPopup>
      </Dialog>
    </div>
  );
}
