import { Button } from "../ui/button";
import {
  Dialog,
  DialogTrigger,
  DialogPopup,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogPanel,
} from "../ui/dialog";
import type {
  CompactRuntimeConfiguredActivityPayload,
  ProjectId,
  ProviderKind,
} from "@t3tools/contracts";
import { readMcpStatusActivityPayload } from "@t3tools/shared/orchestrationActivityPayload";
import { SlidersHorizontalIcon } from "lucide-react";
import { readNativeTaskIdentity } from "@t3tools/shared/nativeTaskIdentity";
import {
  describeFastModeDisabledReason,
  fastModeDisabledReasonHelp,
  refusedFastModeReason,
} from "@t3tools/shared/runtimeInfo";
import { OpenLinkAnchor } from "../OpenLinkAnchor";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { useEffect, useState } from "react";
import type {
  NativeOperationRecord,
  ProviderSessionCapabilities,
  ThreadId,
  OrchestrationThreadActivity,
  ThreadBackgroundWorkEntry,
} from "@t3tools/contracts";
import type { ThreadSession } from "../../types";
import { readNativeApi } from "../../nativeApi";
import { describeBackgroundTask } from "./NativeRuntimeTray.logic";
import { recentRuntimeNotices, resolveRuntimeModelReport } from "./runtimePresentation";
import { McpSignInList, needsAuthMcpServers, supportsMcpSignIn } from "./McpSignInTray";

/**
 * Same names as the composer tray, plus the agent's own type so finished
 * agents stay distinguishable; settled tasks keep their outcome.
 */
function backgroundTaskLabel(task: ThreadBackgroundWorkEntry): string {
  const { title, kindLabel, agentName } = describeBackgroundTask(task, Date.now());
  return [
    title,
    kindLabel,
    agentName !== title ? agentName : null,
    task.active ? null : task.status,
  ]
    .filter(Boolean)
    .join(" · ");
}

const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" ? (value as Record<string, unknown>) : {};
interface NativeRuntimePanelProps {
  provider?: ProviderKind | null | undefined;
  sessionStatus?: ThreadSession["status"] | null | undefined;
  projectId?: ProjectId | undefined;
  threadId: ThreadId;
  capabilities: ProviderSessionCapabilities | null | undefined;
  activities: readonly OrchestrationThreadActivity[];
  requestedModel: string;
  runtime: CompactRuntimeConfiguredActivityPayload | null;
  outcome?: string | undefined;
  /** An icon-only trigger for the chat header (compact chat layout). */
  compact?: boolean | undefined;
}

/**
 * Read-only runtime diagnostics behind a header button: reported model and
 * settings, provider notices, background task output and operation history.
 * Actions (suggestions, recovery, task stop, goals) live in the composer
 * tray and Add menu.
 */
export function NativeRuntimePanel(props: NativeRuntimePanelProps) {
  return <NativeRuntimePanelContent key={props.threadId} {...props} />;
}

function NativeRuntimePanelContent(props: NativeRuntimePanelProps) {
  const [open, setOpen] = useState(false);
  const { threadId, capabilities, activities } = props;
  const [records, setRecords] = useState<readonly NativeOperationRecord[]>([]);
  const [tasks, setTasks] = useState<readonly ThreadBackgroundWorkEntry[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [detail, setDetail] = useState<unknown>(null);
  const [inspection, setInspection] = useState<{
    nativeId: string;
    nextCursor: string | null;
  } | null>(null);
  const [reading, setReading] = useState(false);
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
        const [next, snapshot] = await Promise.all([
          api.nativeOperations.list({ threadId }),
          open ? api.agents.getSnapshot() : Promise.resolve({ entries: [] }),
        ]);
        if (alive) {
          setRecords(next);
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
  const inspect = async (nativeId: string, cursor?: string) => {
    if (!capabilities) return;
    const api = readNativeApi()?.nativeOperations;
    if (!api?.inspect) {
      setError("Native output API is unavailable.");
      return;
    }
    setReading(true);
    setError(null);
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
  const fastModeRefusal = refusedFastModeReason(info);
  const fastModeHelp = fastModeRefusal ? fastModeDisabledReasonHelp(fastModeRefusal) : undefined;
  const signInProvider = supportsMcpSignIn(props.provider, props.sessionStatus)
    ? props.provider
    : null;
  const signInServers =
    signInProvider && props.projectId
      ? needsAuthMcpServers(activities, props.capabilities?.generation)
      : [];
  // needs-auth servers get their own section with Sign in instead of read-only notices.
  const warnings = recentRuntimeNotices(
    signInServers.length > 0
      ? activities.filter(
          (entry) =>
            entry.kind !== "mcp.status.updated" ||
            readMcpStatusActivityPayload(entry.payload)?.status !== "needs-auth",
        )
      : activities,
  );
  const modelReport = resolveRuntimeModelReport({ configuredRuntime: info, activities });
  const attachments = activities.filter(
    (entry) => entry.kind === "native.metadata" && "nativeAttachment" in object(entry.payload),
  );
  const pending = records.some((record) =>
    ["requested", "dispatched", "running", "indeterminate"].includes(record.state),
  );
  return (
    <div
      data-slot="native-runtime-controls"
      className={
        props.compact
          ? "flex shrink-0 items-center"
          : "flex h-7 min-w-0 max-w-full items-center gap-2 px-2 text-xs text-muted-foreground"
      }
    >
      <Dialog open={open} onOpenChange={setOpen}>
        {props.compact ? (
          <Tooltip>
            <TooltipTrigger
              render={
                <DialogTrigger
                  render={
                    <Button
                      variant="ghost"
                      size="icon-xs"
                      className="relative text-muted-foreground"
                      aria-label={pending ? "Runtime details, pending" : "Runtime details"}
                    />
                  }
                />
              }
            >
              <SlidersHorizontalIcon />
              {pending ? (
                <span
                  aria-hidden
                  className="absolute top-0.5 right-0.5 size-1.5 rounded-full bg-info"
                />
              ) : null}
            </TooltipTrigger>
            <TooltipPopup>Runtime details{pending ? " · pending" : ""}</TooltipPopup>
          </Tooltip>
        ) : (
          <DialogTrigger render={<Button variant="ghost" size="xs" />}>
            <SlidersHorizontalIcon /> Runtime details{pending ? " · pending" : ""}
          </DialogTrigger>
        )}
        <DialogPopup className="max-h-[min(80dvh,48rem)] max-w-2xl">
          <DialogHeader>
            <DialogTitle>Runtime details</DialogTitle>
            <DialogDescription>
              Session settings, provider notices and native operation history.
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
              {fastModeRefusal && (
                <>
                  <dt>Fast mode unavailable</dt>
                  <dd>{describeFastModeDisabledReason(fastModeRefusal)}</dd>
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
            {fastModeHelp && (
              <section aria-label="Fast mode help" className="space-y-1">
                <p className="text-muted-foreground">{fastModeHelp.text}</p>
                {fastModeHelp.links.length > 0 && (
                  <p className="flex flex-wrap gap-x-4">
                    {fastModeHelp.links.map((link) => (
                      <OpenLinkAnchor
                        key={link.url}
                        className="underline"
                        href={link.url}
                        target="_blank"
                        rel="noreferrer"
                      >
                        {link.label}
                      </OpenLinkAnchor>
                    ))}
                  </p>
                )}
              </section>
            )}
            {signInServers.length > 0 && signInProvider && props.projectId && (
              <section aria-label="MCP sign-in" className="space-y-2">
                <h3 className="font-medium">MCP servers that need sign-in</h3>
                <p className="text-muted-foreground">
                  Sign in opens your browser. Tokens are saved for this account, so later
                  conversations connect without asking.
                </p>
                <McpSignInList
                  servers={signInServers}
                  provider={signInProvider}
                  projectId={props.projectId}
                  threadId={threadId}
                />
              </section>
            )}
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
            {tasks.length > 0 && (
              <section aria-label="Background tasks" className="space-y-2">
                <h3 className="font-medium">Background tasks</h3>
                {tasks.map((task) => (
                  <div
                    key={task.workItemId}
                    className="flex flex-wrap items-center gap-2 rounded-lg border p-3"
                  >
                    <span className="min-w-0 flex-1 break-words">{backgroundTaskLabel(task)}</span>
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
