import type { BackgroundWorkStatus } from "@t3tools/contracts";
import {
  ArrowUpRightIcon,
  CheckIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  CircleIcon,
  CopyIcon,
  EyeOffIcon,
  SquareIcon,
  TriangleAlertIcon,
  WorkflowIcon,
  XIcon,
  type LucideIcon,
} from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";

import { useCopyToClipboard } from "../hooks/useCopyToClipboard";
import { agentTypeLabel, type AgentsPanelEntry } from "../lib/agentsModel";
import type { NativeTaskInspection } from "../lib/nativeTaskActions";
import { cn } from "../lib/utils";
import { Button } from "./ui/button";
import { Spinner } from "./ui/spinner";

const STATUS_PRESENTATION: Record<
  BackgroundWorkStatus,
  { readonly label: string; readonly icon: LucideIcon | null; readonly className: string }
> = {
  running: { label: "Running", icon: null, className: "text-info" },
  monitoring: { label: "Monitoring", icon: CircleIcon, className: "text-info" },
  idle: { label: "Idle", icon: CircleIcon, className: "text-faint-foreground" },
  completed: { label: "Completed", icon: CheckIcon, className: "text-success" },
  failed: { label: "Failed", icon: XIcon, className: "text-destructive" },
  stopped: { label: "Stopped", icon: SquareIcon, className: "text-muted-foreground" },
  interrupted: { label: "Interrupted", icon: TriangleAlertIcon, className: "text-warning" },
};

const PROMPT_COLLAPSED_LINES = 12;

export function agentStatusLabel(entry: Pick<AgentsPanelEntry, "status" | "live">): string {
  // A row the server no longer reports as live is not running, whatever its last status says.
  if (!entry.live && (entry.status === "running" || entry.status === "monitoring")) {
    return "Stopped";
  }
  return STATUS_PRESENTATION[entry.status].label;
}

export function elapsedLabel(
  startedAt: string,
  completedAt: string | null,
  now: number,
): string | null {
  const start = Date.parse(startedAt);
  const end = completedAt ? Date.parse(completedAt) : now;
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  const totalSeconds = Math.max(0, Math.floor((end - start) / 1_000));
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  if (minutes < 60) return `${minutes}m ${String(totalSeconds % 60).padStart(2, "0")}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${String(minutes % 60).padStart(2, "0")}m`;
}

function firstLine(value: string | null): string | null {
  if (!value) return null;
  const line = value
    .split("\n")
    .map((part) => part.trim())
    .find((part) => part.length > 0);
  return line ?? null;
}

/** Second row line: live progress while running, the outcome once settled. */
function activityLine(entry: AgentsPanelEntry): string | null {
  const output = firstLine(entry.detail);
  const outcome = output && output !== entry.title ? output : null;
  if (entry.live) {
    return [entry.lastTool, outcome].filter(Boolean).join(" · ") || null;
  }
  return outcome;
}

export function AgentStatusGlyph(props: { readonly entry: AgentsPanelEntry }) {
  const label = agentStatusLabel(props.entry);
  const presentation = STATUS_PRESENTATION[props.entry.status];
  const settledButRunning = !props.entry.live && presentation.icon === null;
  if (props.entry.status === "running" && props.entry.live) {
    return (
      <span role="img" aria-label={label} className="flex size-4 shrink-0 items-center">
        <Spinner aria-hidden="true" className={cn("size-3.5", presentation.className)} />
      </span>
    );
  }
  const Icon = settledButRunning ? SquareIcon : (presentation.icon ?? CircleIcon);
  const pulsing = props.entry.status === "monitoring" && props.entry.live;
  return (
    <span role="img" aria-label={label} className="flex size-4 shrink-0 items-center">
      <Icon
        aria-hidden="true"
        className={cn(
          "size-3.5",
          settledButRunning ? "text-muted-foreground" : presentation.className,
          (Icon === CircleIcon || Icon === SquareIcon) && "size-2.5 fill-current",
          pulsing && "animate-pulse",
        )}
      />
    </span>
  );
}

function DetailSection(props: {
  readonly title: string;
  readonly action?: ReactNode;
  readonly children: ReactNode;
}) {
  return (
    <section className="min-w-0">
      <div className="mb-1 flex items-center gap-2">
        <h4 className="text-2xs font-medium tracking-wider text-muted-foreground uppercase">
          {props.title}
        </h4>
        <div className="ml-auto flex items-center gap-1">{props.action}</div>
      </div>
      {props.children}
    </section>
  );
}

function CopyButton(props: { readonly value: string; readonly label: string }) {
  const { copyToClipboard, isCopied } = useCopyToClipboard();
  return (
    <Button
      size="icon-xs"
      variant="ghost"
      aria-label={props.label}
      onClick={() => copyToClipboard(props.value, undefined)}
    >
      {isCopied ? <CheckIcon /> : <CopyIcon />}
    </Button>
  );
}

function PromptBlock(props: { readonly prompt: string }) {
  const lines = props.prompt.split("\n");
  const collapsible = lines.length > PROMPT_COLLAPSED_LINES;
  const [expanded, setExpanded] = useState(false);
  const shown =
    collapsible && !expanded ? lines.slice(0, PROMPT_COLLAPSED_LINES).join("\n") : props.prompt;
  return (
    <DetailSection title="Prompt" action={<CopyButton value={props.prompt} label="Copy prompt" />}>
      <pre className="max-h-96 overflow-auto rounded-md bg-muted/40 p-2 font-mono text-xs whitespace-pre-wrap break-words">
        {shown}
      </pre>
      {collapsible ? (
        <Button
          size="xs"
          variant="link"
          className="mt-1 h-auto px-0"
          onClick={() => setExpanded((value) => !value)}
        >
          {expanded ? "Show less" : `Show all ${lines.length} lines`}
        </Button>
      ) : null}
    </DetailSection>
  );
}

function MetadataRow(props: { readonly label: string; readonly children: ReactNode }) {
  return (
    <>
      <dt className="text-muted-foreground">{props.label}</dt>
      <dd className="min-w-0 truncate">{props.children}</dd>
    </>
  );
}

export interface AgentRowActions {
  readonly canStop: boolean;
  readonly canInspect: boolean;
  readonly stopping: boolean;
  readonly onStop: () => void;
  readonly onDismiss: () => void;
  readonly onNavigate: () => void;
  readonly onOpenThread: () => void;
  readonly onInspect: (cursor?: string) => Promise<NativeTaskInspection | null>;
  readonly onLoadPrompt: () => Promise<string | null>;
}

interface InspectedOutput {
  /** Pages in the order they were read; later pages append. */
  readonly pages: ReadonlyArray<unknown>;
  readonly nextCursor: string | null;
}

/** The entry's prompt, loaded on demand when the snapshot left it out. */
function useEntryPrompt(entry: AgentsPanelEntry, load: () => Promise<string | null>) {
  const [loaded, setLoaded] = useState<string | null>(null);
  const needsLoad = entry.prompt === null;
  // The callback is recreated on every render; load once per entry.
  const loadRef = useRef(load);
  loadRef.current = load;
  useEffect(() => {
    if (!needsLoad) return;
    let alive = true;
    void loadRef.current().then((prompt) => {
      if (alive) setLoaded(prompt);
    });
    return () => {
      alive = false;
    };
  }, [entry.id, needsLoad]);
  return entry.prompt ?? loaded;
}

function AgentDetail(props: {
  readonly entry: AgentsPanelEntry;
  readonly providerName?: string | undefined;
  readonly now: number;
  readonly showThread: boolean;
  readonly actions: AgentRowActions;
}) {
  const { entry, actions } = props;
  const [output, setOutput] = useState<InspectedOutput | null>(null);
  const [reading, setReading] = useState(false);
  const prompt = useEntryPrompt(entry, actions.onLoadPrompt);
  const elapsed = elapsedLabel(entry.startedAt, entry.completedAt, props.now);
  const inspect = async (cursor?: string) => {
    setReading(true);
    try {
      const result = await actions.onInspect(cursor);
      if (!result) return;
      setOutput((current) => ({
        pages: cursor && current ? [...current.pages, result.page] : [result.page],
        nextCursor: result.nextCursor,
      }));
    } finally {
      setReading(false);
    }
  };

  return (
    <div
      className="ml-6 flex flex-col gap-3 border-l border-border/60 py-2 pr-2 pl-3"
      data-testid="agent-detail"
    >
      {prompt ? <PromptBlock prompt={prompt} /> : null}
      <DetailSection
        title={entry.live ? "Latest output" : "Result"}
        action={
          actions.canInspect ? (
            <Button
              size="xs"
              variant="ghost"
              disabled={reading}
              onClick={() => void inspect(output?.nextCursor ?? undefined)}
            >
              {reading ? <Spinner aria-hidden="true" className="size-3" /> : null}
              {output ? (output.nextCursor ? "Load more" : "Refresh output") : "Inspect output"}
            </Button>
          ) : null
        }
      >
        {output ? (
          <pre className="max-h-96 overflow-auto rounded-md bg-muted/40 p-2 font-mono text-xs whitespace-pre-wrap break-all">
            {output.pages.map((page) => JSON.stringify(page ?? null, null, 2)).join("\n\n")}
          </pre>
        ) : entry.detail ? (
          <>
            <pre className="max-h-72 overflow-auto rounded-md bg-muted/40 p-2 font-mono text-xs whitespace-pre-wrap break-words">
              {entry.detail}
            </pre>
            {entry.outputTruncated ? (
              <p className="mt-1 text-2xs text-muted-foreground">
                Output was truncated to the most relevant part.
              </p>
            ) : null}
          </>
        ) : (
          <p className="text-xs text-muted-foreground">No output recorded yet.</p>
        )}
      </DetailSection>
      <dl className="grid grid-cols-[max-content_minmax(0,1fr)] gap-x-3 gap-y-1 text-xs">
        <MetadataRow label="Status">{agentStatusLabel(entry)}</MetadataRow>
        {entry.phase ? (
          <MetadataRow label="Type">
            <span className="font-mono">{entry.phase}</span>
          </MetadataRow>
        ) : null}
        {entry.model ? (
          <MetadataRow label="Model">
            <span className="font-mono">{entry.model}</span>
          </MetadataRow>
        ) : null}
        {entry.effort ? (
          <MetadataRow label="Effort">
            <span className="font-mono">{entry.effort}</span>
          </MetadataRow>
        ) : null}
        <MetadataRow label="Provider">
          <span>{props.providerName ?? entry.provider}</span>
        </MetadataRow>
        <MetadataRow label="Started">{new Date(entry.startedAt).toLocaleString()}</MetadataRow>
        {elapsed ? <MetadataRow label="Duration">{elapsed}</MetadataRow> : null}
        {entry.lastTool ? (
          <MetadataRow label="Last tool">
            <span className="font-mono">{entry.lastTool}</span>
          </MetadataRow>
        ) : null}
        {props.showThread ? (
          <MetadataRow label="Thread">
            <button
              type="button"
              className="truncate text-left underline-offset-2 hover:underline"
              onClick={actions.onOpenThread}
            >
              {entry.projectName ? `${entry.projectName} · ` : ""}
              {entry.threadTitle}
            </button>
          </MetadataRow>
        ) : null}
        <MetadataRow label="ID">
          <span className="flex min-w-0 items-center gap-1">
            <span className="truncate font-mono text-muted-foreground">
              {entry.nativeWorkItemId}
            </span>
            <CopyButton value={entry.nativeWorkItemId} label="Copy work item ID" />
          </span>
        </MetadataRow>
      </dl>
      <div className="flex flex-wrap items-center gap-1.5">
        {entry.live && actions.canStop ? (
          <Button
            size="xs"
            variant="destructive-outline"
            disabled={actions.stopping}
            onClick={actions.onStop}
          >
            {actions.stopping ? <Spinner aria-hidden="true" className="size-3" /> : <SquareIcon />}
            Stop
          </Button>
        ) : null}
        <Button size="xs" variant="outline" onClick={actions.onNavigate}>
          Jump to timeline
        </Button>
        {!entry.active ? (
          <Button size="xs" variant="ghost" onClick={actions.onDismiss}>
            <EyeOffIcon />
            Dismiss
          </Button>
        ) : null}
      </div>
    </div>
  );
}

export function AgentRow(props: {
  readonly entry: AgentsPanelEntry;
  readonly providerName?: string | undefined;
  readonly now: number;
  readonly expanded: boolean;
  readonly showThread: boolean;
  readonly onToggle: () => void;
  readonly actions: AgentRowActions;
}) {
  const { entry, actions } = props;
  const elapsed = elapsedLabel(entry.startedAt, entry.completedAt, props.now);
  const typeLabel = agentTypeLabel(entry.phase);
  const line = activityLine(entry);
  const detailId = `agent-detail-${entry.id.replace(/[^a-zA-Z0-9_-]/g, "_")}`;

  return (
    <div className="group/agent rounded-md" data-testid="agent-row">
      <div className="relative flex items-start gap-2 rounded-md px-2 py-1.5 hover:bg-accent/50 focus-within:bg-accent/50">
        <button
          type="button"
          className="absolute inset-0 rounded-md focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
          aria-expanded={props.expanded}
          aria-controls={props.expanded ? detailId : undefined}
          aria-label={`${props.expanded ? "Collapse" : "Expand"} ${entry.title}`}
          onClick={props.onToggle}
        />
        <span className="pointer-events-none mt-0.5 flex items-center">
          {props.expanded ? (
            <ChevronDownIcon aria-hidden="true" className="size-3 text-muted-foreground" />
          ) : (
            <ChevronRightIcon aria-hidden="true" className="size-3 text-muted-foreground" />
          )}
        </span>
        <span className="pointer-events-none mt-px">
          <AgentStatusGlyph entry={entry} />
        </span>
        <span className="pointer-events-none min-w-0 flex-1">
          <span className="flex min-w-0 items-center gap-1.5">
            <span className="truncate text-sm font-medium text-foreground">{entry.title}</span>
            {entry.kind === "workflow" ? (
              <WorkflowIcon
                aria-label="Workflow"
                className="size-3 shrink-0 text-muted-foreground"
              />
            ) : null}
            {typeLabel && typeLabel.toLowerCase() !== entry.title.toLowerCase() ? (
              <span className="shrink-0 rounded-sm bg-muted px-1 font-mono text-2xs text-muted-foreground">
                {typeLabel}
              </span>
            ) : null}
            <span className="ml-auto shrink-0 text-xs text-muted-foreground tabular-nums group-hover/agent:invisible group-focus-within/agent:invisible">
              {elapsed}
            </span>
          </span>
          {props.providerName || line ? (
            <span className="mt-0.5 block min-w-0 truncate text-xs text-muted-foreground">
              {props.providerName ? (
                <>
                  <span>{props.providerName}</span>
                  {line ? " · " : null}
                </>
              ) : null}
              {line}
            </span>
          ) : null}
        </span>
        <span className="pointer-events-none absolute top-1 right-1 flex items-center gap-0.5 rounded-md bg-background/90 opacity-0 group-focus-within/agent:pointer-events-auto group-focus-within/agent:opacity-100 group-hover/agent:pointer-events-auto group-hover/agent:opacity-100">
          {entry.live && actions.canStop ? (
            <Button
              size="icon-xs"
              variant="ghost"
              aria-label={`Stop ${entry.title}`}
              disabled={actions.stopping}
              onClick={actions.onStop}
            >
              {actions.stopping ? (
                <Spinner aria-hidden="true" className="size-3" />
              ) : (
                <SquareIcon />
              )}
            </Button>
          ) : null}
          <Button
            size="icon-xs"
            variant="ghost"
            aria-label={`Jump to ${entry.title} in timeline`}
            onClick={actions.onNavigate}
          >
            <ArrowUpRightIcon />
          </Button>
          {!entry.active ? (
            <Button
              size="icon-xs"
              variant="ghost"
              aria-label={`Dismiss ${entry.title}`}
              onClick={actions.onDismiss}
            >
              <EyeOffIcon />
            </Button>
          ) : null}
        </span>
      </div>
      {props.expanded ? (
        <div id={detailId}>
          <AgentDetail
            entry={entry}
            providerName={props.providerName}
            now={props.now}
            showThread={props.showThread}
            actions={actions}
          />
        </div>
      ) : null}
    </div>
  );
}
