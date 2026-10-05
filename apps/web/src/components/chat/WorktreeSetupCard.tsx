import {
  WORKTREE_SETUP_TAIL_LINES,
  type WorktreeSetupSnapshot,
  type WorktreeSetupStage,
  worktreeSetupStageLabel,
} from "@t3tools/contracts";
import {
  CheckIcon,
  ChevronDownIcon,
  ChevronUpIcon,
  CircleAlertIcon,
  CircleIcon,
  GitBranchIcon,
  MinusIcon,
  XIcon,
} from "lucide-react";
import { useEffect, useState } from "react";

import { cn } from "~/lib/utils";
import { Button } from "../ui/button";
import { Spinner } from "../ui/spinner";
import { COMPOSER_TRAY_PANEL_CLASS_NAME, type ComposerPanelVariant } from "./composer/ComposerTray";

export interface WorktreeSetupCardProps {
  readonly snapshot: WorktreeSetupSnapshot;
  readonly busy: boolean;
  /** Stops a running setup, or discards a settled one. Null hides the action. */
  readonly onCancel: (() => void) | null;
  readonly onRetry: (() => void) | null;
  readonly onWorkLocally: (() => void) | null;
  readonly variant?: ComposerPanelVariant | undefined;
}

function formatElapsed(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${String(seconds % 60).padStart(2, "0")}s`;
}

function useNowWhile(active: boolean): number {
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const id = window.setInterval(() => setNowMs(Date.now()), 1_000);
    return () => window.clearInterval(id);
  }, [active]);
  return nowMs;
}

function stageElapsedMs(stage: WorktreeSetupStage, nowMs: number): number | null {
  if (!stage.startedAt) return null;
  const start = Date.parse(stage.startedAt);
  const end = stage.endedAt ? Date.parse(stage.endedAt) : nowMs;
  return Number.isFinite(start) && Number.isFinite(end) ? Math.max(0, end - start) : null;
}

function StageIcon({ status }: { status: WorktreeSetupStage["status"] }) {
  const className = "size-3.5 shrink-0";
  switch (status) {
    case "done":
      return <CheckIcon aria-hidden className={className} />;
    case "running":
      return <Spinner className={className} />;
    case "failed":
      return <XIcon aria-hidden className={className} />;
    case "warning":
      return <CircleAlertIcon aria-hidden className={className} />;
    case "skipped":
      return <MinusIcon aria-hidden className={className} />;
    case "pending":
      return <CircleIcon aria-hidden className={className} />;
  }
}

export function worktreeSetupHeadline(snapshot: WorktreeSetupSnapshot): string {
  switch (snapshot.phase) {
    case "running":
      return snapshot.agentStarted
        ? "Agent started; setup script still running"
        : "Setting up worktree";
    case "done":
      return snapshot.stages.some((stage) => stage.status === "failed")
        ? "Worktree ready; setup script failed"
        : "Worktree ready";
    case "failed":
      return "Worktree setup failed";
    case "cancelled":
      return "Worktree setup cancelled";
    case "cancelled_kept":
      return "Worktree setup cancelled; worktree kept";
  }
}

/**
 * Whether the card still has something to say: setup is running, a settled
 * setup still holds its queued first turn (so Retry, Work locally and Discard
 * apply), or a finished setup carries a script failure or warning.
 */
export function shouldShowWorktreeSetupCard(
  snapshot: WorktreeSetupSnapshot,
  context: { readonly firstTurnQueued: boolean },
): boolean {
  if (snapshot.phase === "running") return true;
  if (snapshot.phase === "done") {
    return snapshot.stages.some((stage) => stage.status === "failed" || stage.status === "warning");
  }
  return context.firstTurnQueued;
}

/**
 * A setup that finished with only warnings needs no action, so it starts
 * collapsed to its header. Failures, running and cancelled setups stay open.
 */
export function isWorktreeSetupCollapsible(snapshot: WorktreeSetupSnapshot): boolean {
  return (
    snapshot.phase === "done" &&
    !snapshot.stages.some((stage) => stage.status === "failed") &&
    snapshot.error === null
  );
}

function StageRow({
  stage,
  nowMs,
  label,
}: {
  stage: WorktreeSetupStage;
  nowMs: number;
  label: string;
}) {
  const elapsed = stageElapsedMs(stage, nowMs);
  const trailing =
    stage.status === "pending"
      ? null
      : stage.id === "checkout" && stage.status === "running" && stage.percent !== null
        ? `${stage.percent}%`
        : stage.detail;
  return (
    <div
      className={cn(
        "flex min-h-6 min-w-0 items-center gap-2 text-xs",
        stage.status === "failed" && "text-destructive-foreground",
        stage.status === "warning" && "text-warning-foreground",
        stage.status === "pending" && "opacity-50",
      )}
      data-worktree-setup-stage={stage.id}
      data-worktree-setup-status={stage.status}
    >
      <StageIcon status={stage.status} />
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {trailing ? (
        <span
          className="min-w-0 max-w-[45%] truncate text-muted-foreground tabular-nums"
          title={trailing}
        >
          {trailing}
        </span>
      ) : null}
      {elapsed !== null && stage.status !== "skipped" && stage.status !== "pending" ? (
        <span className="shrink-0 text-muted-foreground tabular-nums">
          {formatElapsed(elapsed)}
        </span>
      ) : null}
    </div>
  );
}

/** Fixed-height tail so streaming output never shifts the timeline. */
function OutputTail({ lines, failed }: { lines: ReadonlyArray<string>; failed: boolean }) {
  const slots = Array.from({ length: WORKTREE_SETUP_TAIL_LINES }, (_, slot) => ({
    slot,
    line: lines[lines.length - WORKTREE_SETUP_TAIL_LINES + slot] ?? "",
  }));
  return (
    <pre
      className={cn(
        "ml-5 overflow-hidden rounded-md border px-2 py-1 font-mono text-2xs leading-relaxed select-text",
        failed
          ? "border-destructive/20 text-destructive-foreground"
          : "border-border text-muted-foreground",
      )}
      data-worktree-setup-tail
    >
      {slots.map(({ slot, line }) => (
        <div key={slot} className="truncate whitespace-pre">
          {line || " "}
        </div>
      ))}
    </pre>
  );
}

export function WorktreeSetupCard(props: WorktreeSetupCardProps) {
  const { snapshot } = props;
  const running = snapshot.phase === "running";
  const nowMs = useNowWhile(running);
  const started = Date.parse(snapshot.startedAt);
  const ended = snapshot.endedAt ? Date.parse(snapshot.endedAt) : nowMs;
  const scriptStage = snapshot.stages.find((stage) => stage.id === "setup-script");
  const collapsible = isWorktreeSetupCollapsible(snapshot);
  const [expanded, setExpanded] = useState(false);
  const collapsed = collapsible && !expanded;
  const warningCount = snapshot.stages.filter((stage) => stage.status === "warning").length;
  return (
    <section
      aria-label="Worktree setup"
      className={
        props.variant === "tray"
          ? COMPOSER_TRAY_PANEL_CLASS_NAME
          : "mx-auto mb-2 w-full max-w-(--chat-content-max-width) rounded-xl border border-border bg-card px-3 py-2 shadow-sm"
      }
      data-worktree-setup-phase={snapshot.phase}
      data-worktree-setup-collapsed={collapsed || undefined}
    >
      <header className="flex min-h-6 min-w-0 items-center gap-2 text-xs">
        <GitBranchIcon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
        <span
          className={cn(
            "min-w-0 flex-1 truncate font-medium",
            snapshot.phase === "failed" && "text-destructive-foreground",
            snapshot.phase === "cancelled_kept" && "text-warning-foreground",
          )}
        >
          {worktreeSetupHeadline(snapshot)}
          <span className="ml-2 font-normal text-muted-foreground">{snapshot.request.branch}</span>
        </span>
        {collapsible && warningCount > 0 ? (
          <span className="flex shrink-0 items-center gap-1 text-warning-foreground">
            <CircleAlertIcon aria-hidden className="size-3.5" />
            {warningCount === 1 ? "1 warning" : `${warningCount} warnings`}
          </span>
        ) : null}
        {Number.isFinite(started) && Number.isFinite(ended) ? (
          <span className="shrink-0 text-muted-foreground tabular-nums">
            {formatElapsed(ended - started)}
          </span>
        ) : null}
        {collapsible ? (
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            aria-label={collapsed ? "Show setup details" : "Hide setup details"}
            aria-expanded={!collapsed}
            onClick={() => setExpanded((value) => !value)}
          >
            {collapsed ? <ChevronDownIcon /> : <ChevronUpIcon />}
          </Button>
        ) : null}
      </header>
      {collapsed ? null : (
        <div className="mt-1.5 flex flex-col gap-0.5">
          {snapshot.stages.map((stage) => (
            <div key={stage.id} className="flex flex-col gap-1">
              <StageRow
                stage={stage}
                nowMs={nowMs}
                label={
                  stage.id === "setup-script" && snapshot.setupScript
                    ? `${snapshot.setupScript.name}${snapshot.setupScript.async ? "" : " (agent waits)"}`
                    : worktreeSetupStageLabel(stage.id)
                }
              />
              {stage.id === "setup-script" && scriptStage && scriptStage.tail.length > 0 ? (
                <OutputTail lines={scriptStage.tail} failed={scriptStage.status === "failed"} />
              ) : null}
            </div>
          ))}
        </div>
      )}
      {snapshot.error ? (
        <p className="mt-1.5 text-xs text-muted-foreground" role="status">
          {snapshot.error}
        </p>
      ) : null}
      {props.onCancel || props.onRetry || props.onWorkLocally ? (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {props.onRetry ? (
            <Button
              type="button"
              size="xs"
              variant="outline"
              disabled={props.busy}
              onClick={props.onRetry}
            >
              Retry
            </Button>
          ) : null}
          {props.onWorkLocally ? (
            <Button
              type="button"
              size="xs"
              variant="outline"
              disabled={props.busy}
              onClick={props.onWorkLocally}
            >
              Work locally
            </Button>
          ) : null}
          {props.onCancel ? (
            <Button
              type="button"
              size="xs"
              variant="ghost"
              disabled={props.busy}
              onClick={props.onCancel}
            >
              {running ? "Cancel setup" : "Discard"}
            </Button>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
