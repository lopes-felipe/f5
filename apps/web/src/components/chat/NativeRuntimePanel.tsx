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

const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" ? (value as Record<string, unknown>) : {};
export function NativeRuntimePanel(props: {
  threadId: ThreadId;
  capabilities: ProviderSessionCapabilities | null | undefined;
  activities: readonly OrchestrationThreadActivity[];
  requestedModel: string;
  outcome?: string | undefined;
  prompt: string;
  latestMessageAt?: string | undefined;
  onSuggestion: (text: string) => void;
  onStop: () => Promise<void>;
}) {
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
  const promptBefore = useRef(prompt);
  const suggestion = activities.findLast((entry) => entry.kind === "prompt.suggestion");
  useEffect(() => {
    if (promptBefore.current !== prompt && suggestion) setUsedSuggestion(suggestion.id);
    promptBefore.current = prompt;
  }, [prompt, suggestion]);
  useEffect(() => {
    let alive = true;
    const refresh = async () => {
      const api = readNativeApi();
      if (!api?.nativeOperations) return;
      try {
        const [next, snapshot] = await Promise.all([
          api.nativeOperations.list({ threadId }),
          api.agents.getSnapshot(),
        ]);
        if (alive) {
          setRecords(next);
          setTasks(snapshot.entries.filter((entry) => entry.threadId === threadId));
        }
      } catch {
        /* Connection and capability surfaces already report transport failures. */
      }
    };
    void refresh();
    const timer = window.setInterval(() => void refresh(), 5000);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, [threadId, capabilities?.generation]);
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
      if (
        action === "acknowledge" &&
        record.command.kind === "revertFiles" &&
        record.operationId.startsWith("native-files:")
      ) {
        await readNativeApi()?.orchestration.dispatchCommand({
          type: "thread.rewind-draft.resolve",
          commandId: CommandId.makeUnsafe(crypto.randomUUID()),
          threadId,
          operationId: CommandId.makeUnsafe(record.operationId.slice("native-files:".length)),
          intent: "cancel",
          createdAt: new Date().toISOString(),
        });
      }
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
    setReading(true);
    try {
      const identity = readNativeTaskIdentity(nativeId);
      const page = await readNativeApi()?.nativeOperations?.inspect({
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
  const configured = object(
    activities.findLast((entry) => entry.kind === "runtime.configured")?.payload,
  );
  const info = object(configured.payload ?? configured);
  const normalized = object(info.runtimeInfo);
  const effective = object(normalized.effective);
  const requested = object(normalized.requested);
  const warnings = activities
    .filter((entry) =>
      [
        "runtime.warning",
        "runtime.error",
        "model.rerouted",
        "config.warning",
        "deprecation.notice",
        "mcp.status",
      ].includes(entry.kind),
    )
    .slice(-4);
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
  if (!capabilities) return null;
  return (
    <div className="text-xs text-muted-foreground">
      {visibleSuggestion && (
        <button
          type="button"
          className="mb-2 rounded border px-2 py-1 text-left"
          onClick={() => {
            setUsedSuggestion(suggestion.id);
            props.onSuggestion(suggestion.summary);
          }}
        >
          Suggested next prompt: {suggestion.summary}
        </button>
      )}
      {goal != null && (
        <div>
          Goal: {String(object(goal).objective ?? "")} · {String(object(goal).status ?? "unknown")}{" "}
          · {String(object(goal).tokensUsed ?? 0)} tokens
        </div>
      )}
      <details className="mb-2">
        <summary>Runtime{running ? " · native operation pending" : ""}</summary>
        <p>
          Requested model: {String(requested.model ?? props.requestedModel)}. Effective model:{" "}
          {String(effective.model ?? info.model ?? "awaiting provider report")}
          {effective.effort || info.effort
            ? ` · effort ${String(effective.effort ?? info.effort)}`
            : ""}
          {effective.thinking || info.thinkingState
            ? ` · thinking ${String(effective.thinking ?? info.thinkingState)}`
            : ""}
          {effective.fastMode || info.fastModeState
            ? ` · fast mode ${String(effective.fastMode ?? info.fastModeState)}`
            : ""}
          {normalized.fallback ? ` · fallback: ${String(normalized.fallback)}` : ""}
          {props.outcome ? ` · outcome: ${props.outcome}` : ""}
        </p>
        {warnings.map((warning) => (
          <p key={warning.id}>{warning.summary}</p>
        ))}
        <div className="flex flex-wrap items-center gap-2 py-2">
          {supported("nativeCompaction") && (
            <button
              type="button"
              disabled={running}
              onClick={() => {
                void readNativeApi()
                  ?.orchestration.dispatchCommand({
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
              Compact natively
            </button>
          )}
          {supported("nativeReview") && (
            <>
              <input
                aria-label="Review base branch or commit"
                placeholder="Branch, commit:<SHA>, or blank for changes"
                value={reviewTarget}
                onChange={(event) => setReviewTarget(event.target.value)}
              />
              <button type="button" disabled={running} onClick={() => void review()}>
                Review
              </button>
            </>
          )}
          {supported("nativeGoals") && (
            <>
              <input
                aria-label="Goal objective"
                placeholder="Goal objective"
                value={objective}
                onChange={(event) => setObjective(event.target.value)}
              />
              <input
                aria-label="Goal token budget"
                type="number"
                min={1}
                value={budget}
                onChange={(event) => setBudget(Number(event.target.value))}
              />
              <button
                type="button"
                disabled={
                  running || !objective.trim() || !Number.isSafeInteger(budget) || budget < 1
                }
                onClick={() => void execute({ kind: "goalSet", objective, tokenBudget: budget })}
              >
                Start goal
              </button>
              <button
                type="button"
                disabled={running}
                onClick={() => void execute({ kind: "goalClear" })}
              >
                Clear goal
              </button>
            </>
          )}
          {running && (
            <button type="button" onClick={() => void props.onStop()}>
              Interrupt conversation turn
            </button>
          )}
        </div>
        {tasks.map((task) => (
          <div key={task.workItemId} className="flex gap-2">
            <span>
              {task.phase ?? task.workItemId} · {task.status}
            </span>
            {supported("childTaskInspection") && (
              <button type="button" onClick={() => void inspect(task.workItemId)}>
                Inspect output
              </button>
            )}
            {task.active && supported("childTaskStop") && (
              <button
                type="button"
                disabled={busy}
                onClick={() =>
                  void execute({
                    kind: "stopTask",
                    ...readNativeTaskIdentity(task.workItemId),
                  })
                }
              >
                Stop task
              </button>
            )}
          </div>
        ))}
        {attachments.slice(-20).map((entry) => (
          <div key={entry.id}>
            From Codex:{" "}
            {String(object(object(entry.payload).nativeAttachment).attachmentType ?? "attachment")}{" "}
            · {String(object(object(entry.payload).nativeAttachment).operation ?? "updated")}
          </div>
        ))}
        {records.slice(0, 8).map((record) => (
          <div key={record.operationId}>
            {record.command.kind} · {record.state}
            {record.staleGeneration ? " · result belongs to an older session" : ""}
            {record.error ? ` · ${record.error}` : ""}
            {record.command.kind === "fork" && (
              <span> · Preserved workspace: {record.command.cwd}</span>
            )}
            {record.state === "indeterminate" && (
              <>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void resolve(record, "reconcile")}
                >
                  Recheck outcome
                </button>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void resolve(record, "acknowledge")}
                >
                  Stop provider and acknowledge
                </button>
              </>
            )}
          </div>
        ))}
        {detail !== null && (
          <pre className="max-h-72 overflow-auto whitespace-pre-wrap">
            {JSON.stringify(detail, null, 2)}
          </pre>
        )}
        {inspection?.nextCursor && (
          <button
            type="button"
            disabled={reading}
            onClick={() => void inspect(inspection.nativeId, inspection.nextCursor!)}
          >
            Next output page
          </button>
        )}
        {error && <p role="alert">{error}</p>}
      </details>
    </div>
  );
}
