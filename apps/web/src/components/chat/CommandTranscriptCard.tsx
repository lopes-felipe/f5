import type {
  OrchestrationCommandExecution,
  OrchestrationCommandExecutionSummary,
  ThreadId,
} from "@t3tools/contracts";
import {
  commandExecutionBackgroundStatus,
  deriveCommandExecutionLabel,
  normalizeCommandExecutionDetail,
  resolveCommandExecutionDisplayCommand,
  resolveCommandExecutionSummaryText,
} from "@t3tools/shared/commandSummary";
import {
  BanIcon,
  CheckIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  CircleStopIcon,
  LoaderCircleIcon,
  XIcon,
  type LucideIcon,
} from "lucide-react";
import { memo, useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";

import type { TimestampFormat } from "../../appSettings";
import { formatWorkspaceRelativePath } from "../../filePathDisplay";
import type { DisplayCommandTokenKind } from "../../lib/commandExecutions";
import { tokenizeDisplayCommand } from "../../lib/commandExecutions";
import {
  scheduleThreadCommandExecutionRefreshIfMissing,
  threadCommandExecutionQueryOptions,
} from "../../lib/orchestrationReactQuery";
import { formatElapsed } from "../../session-logic";
import { formatTimestamp } from "../../timestampFormat";
import { useCopyToClipboard } from "~/hooks/useCopyToClipboard";
import { cn } from "~/lib/utils";
import { useNowIso } from "../../lib/nowTicker";
import { toastManager } from "../ui/toast";
import { CopyIconButton } from "./CopyIconButton";

interface CommandTranscriptCardProps {
  threadId?: ThreadId | null;
  execution: OrchestrationCommandExecutionSummary | OrchestrationCommandExecution;
  expanded: boolean;
  timestampFormat: TimestampFormat;
  /** Commands that ran here show no cwd line; any other cwd is shown in the expanded body. */
  workspaceRoot?: string | undefined;
  /**
   * Whether the thread is working. A command left `running` on an idle thread
   * (a missed completion) keeps its last elapsed time instead of counting up.
   */
  threadWorking?: boolean;
  onToggle: () => void;
  onExpandedBodyResize?: () => void;
}

interface StatusPresentation {
  readonly label: string;
  readonly Icon: LucideIcon;
  readonly iconClassName: string;
  readonly borderClassName: string;
}

const STATUS_PRESENTATION: Record<
  OrchestrationCommandExecutionSummary["status"],
  StatusPresentation
> = {
  running: {
    label: "Running",
    Icon: LoaderCircleIcon,
    iconClassName: "animate-spin text-info motion-reduce:animate-none",
    borderClassName: "border-l-info/70",
  },
  completed: {
    label: "Completed",
    Icon: CheckIcon,
    iconClassName: "text-success",
    borderClassName: "border-l-success/70",
  },
  failed: {
    label: "Failed",
    Icon: XIcon,
    iconClassName: "text-destructive",
    borderClassName: "border-l-destructive/80",
  },
  interrupted: {
    label: "Interrupted",
    Icon: CircleStopIcon,
    iconClassName: "text-warning",
    borderClassName: "border-l-warning/70",
  },
  declined: {
    label: "Declined",
    Icon: BanIcon,
    iconClassName: "text-muted-foreground",
    borderClassName: "border-l-border",
  },
};

// Shell syntax colours from the semantic set so themes recolour them too.
const COMMAND_TOKEN_CLASS_NAME: Record<DisplayCommandTokenKind, string> = {
  command: "text-info-foreground",
  env: "text-attention-foreground",
  flag: "text-warning-foreground",
  number: "text-warning-foreground",
  operator: "text-muted-foreground",
  path: "text-success-foreground",
  string: "text-success-foreground",
  substitution: "text-attention-foreground",
  text: "text-foreground",
  variable: "text-destructive-foreground",
  whitespace: "text-inherit",
};

// Matches the MCP card's section headers.
const SECTION_LABEL_CLASS_NAME =
  "text-2xs font-semibold tracking-widest text-muted-foreground uppercase";

const INLINE_OUTPUT_PREVIEW_CHAR_LIMIT = 16_000;
const INLINE_OUTPUT_PREVIEW_HEAD_CHARS = 8_000;
const INLINE_OUTPUT_PREVIEW_MARKER = "\n\n[... output preview shortened ...]\n\n";
const FAILED_OUTPUT_TAIL_LINES = 4;
const FAILED_OUTPUT_TAIL_CHAR_LIMIT = 600;
const FAILED_OUTPUT_TAIL_SCAN_CHARS = 8_000;

const HighlightedCommandText = memo(function HighlightedCommandText(props: { command: string }) {
  const tokens = tokenizeDisplayCommand(props.command);
  let offset = 0;
  return (
    <>
      {tokens.map((token) => {
        const tokenOffset = offset;
        offset += token.text.length;
        return (
          <span
            key={`command-token:${tokenOffset}:${token.kind}`}
            className={COMMAND_TOKEN_CLASS_NAME[token.kind]}
          >
            {token.text}
          </span>
        );
      })}
    </>
  );
});

function resolveExecutionOutput(
  execution: OrchestrationCommandExecutionSummary | OrchestrationCommandExecution,
): string {
  return "output" in execution ? execution.output : "";
}

function resolveExecutionOutputTruncated(
  execution: OrchestrationCommandExecutionSummary | OrchestrationCommandExecution,
): boolean {
  return "outputTruncated" in execution ? execution.outputTruncated : false;
}

const compactCharCountFormatter = new Intl.NumberFormat("en-US", {
  notation: "compact",
  maximumFractionDigits: 1,
});

function buildInlineOutputPreview(output: string): {
  text: string;
  shortened: boolean;
  shownChars: number;
} {
  if (output.length <= INLINE_OUTPUT_PREVIEW_CHAR_LIMIT) {
    return { text: output, shortened: false, shownChars: output.length };
  }

  const headChars = Math.min(INLINE_OUTPUT_PREVIEW_HEAD_CHARS, INLINE_OUTPUT_PREVIEW_CHAR_LIMIT);
  const tailChars = Math.max(
    0,
    INLINE_OUTPUT_PREVIEW_CHAR_LIMIT - headChars - INLINE_OUTPUT_PREVIEW_MARKER.length,
  );
  const head = output.slice(0, headChars);
  const tail = tailChars > 0 ? output.slice(-tailChars) : "";
  return {
    text: `${head}${INLINE_OUTPUT_PREVIEW_MARKER}${tail}`,
    shortened: true,
    shownChars: head.length + tail.length,
  };
}

/**
 * Last few non-empty lines of a failed command's output, kept to a character
 * budget from the end so minified or single-line output stays cheap to render.
 */
function buildOutputTail(output: string): string {
  const tail = output
    .slice(-FAILED_OUTPUT_TAIL_SCAN_CHARS)
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .slice(-FAILED_OUTPUT_TAIL_LINES)
    .join("\n");
  return tail.length > FAILED_OUTPUT_TAIL_CHAR_LIMIT
    ? `…${tail.slice(-(FAILED_OUTPUT_TAIL_CHAR_LIMIT - 1))}`
    : tail;
}

function comparablePath(path: string): string {
  return path.replaceAll("\\", "/").replace(/\/+$/, "").toLowerCase();
}

function resolveCwdLabel(
  cwd: string | undefined,
  workspaceRoot: string | undefined,
): string | null {
  if (!cwd) return null;
  // Same case-insensitive comparison the workspace-relative formatter uses.
  if (workspaceRoot && comparablePath(cwd) === comparablePath(workspaceRoot)) {
    return null;
  }
  return formatWorkspaceRelativePath(cwd, workspaceRoot);
}

function CommandStatusIcon(props: { status: OrchestrationCommandExecutionSummary["status"] }) {
  const { label, Icon, iconClassName } = STATUS_PRESENTATION[props.status];
  return (
    <span role="img" aria-label={label} title={label} className="inline-flex shrink-0">
      <Icon className={cn("size-3.5", iconClassName)} aria-hidden />
    </span>
  );
}

const CommandTranscriptOutput = memo(function CommandTranscriptOutput(props: {
  executionId: OrchestrationCommandExecutionSummary["id"];
  outputText: string;
  outputTruncated: boolean;
  isLoadingOutput: boolean;
  outputError: string | null;
}) {
  const [showFullOutput, setShowFullOutput] = useState(false);
  const preview = useMemo(() => buildInlineOutputPreview(props.outputText), [props.outputText]);
  const { copyToClipboard, isCopied } = useCopyToClipboard({
    onCopy: () => {
      toastManager.add({ type: "success", title: "Output copied" });
    },
    onError: (error) => {
      console.error("[CommandTranscriptCard] output copy failed:", error);
      toastManager.add({
        type: "error",
        title: "Could not copy output",
        description:
          error instanceof Error ? error.message : "An unexpected clipboard error occurred.",
      });
    },
  });

  useEffect(() => {
    setShowFullOutput(false);
  }, [props.executionId]);

  const displayOutput = showFullOutput || !preview.shortened ? props.outputText : preview.text;
  const showPreviewToggle =
    !props.isLoadingOutput && props.outputError === null && preview.shortened;
  const canCopyOutput =
    !props.isLoadingOutput && props.outputError === null && props.outputText.length > 0;

  return (
    <div>
      <div className="flex min-h-5 items-center justify-between gap-2">
        <p className={SECTION_LABEL_CLASS_NAME}>Output</p>
        {canCopyOutput && (
          <CopyIconButton
            label={isCopied ? "Output copied" : "Copy output"}
            copied={isCopied}
            onClick={() => {
              copyToClipboard(props.outputText);
            }}
          />
        )}
      </div>
      <div className="mt-1 max-h-80 overflow-auto rounded-md bg-background/70 p-2">
        <pre className="whitespace-pre-wrap break-words font-mono text-[length:var(--f5-chat-font-size)] text-foreground">
          {props.isLoadingOutput
            ? "Loading output..."
            : props.outputError
              ? props.outputError
              : displayOutput.length > 0
                ? displayOutput
                : "(no output)"}
        </pre>
      </div>
      {showPreviewToggle && (
        <div className="mt-1 flex flex-wrap items-center gap-x-1.5 text-xs">
          {!showFullOutput && (
            <>
              <span className="text-2xs text-muted-foreground">
                {`Shortened preview, ${compactCharCountFormatter.format(preview.shownChars)} of ${compactCharCountFormatter.format(props.outputText.length)} characters`}
              </span>
              <span aria-hidden className="text-faint-foreground">
                ·
              </span>
            </>
          )}
          <button
            type="button"
            className="rounded-sm text-info-foreground outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring"
            aria-expanded={showFullOutput}
            onClick={() => {
              setShowFullOutput((current) => !current);
            }}
          >
            {showFullOutput ? "Show preview" : "Show full output"}
          </button>
        </div>
      )}
      {props.outputTruncated && (
        <p className="mt-1 text-2xs text-muted-foreground">
          Transcript output was truncated to fit the retention limit.
        </p>
      )}
    </div>
  );
});

export const CommandTranscriptCard = memo(function CommandTranscriptCard({
  threadId = null,
  execution,
  expanded,
  timestampFormat,
  workspaceRoot,
  threadWorking = true,
  onToggle,
  onExpandedBodyResize,
}: CommandTranscriptCardProps) {
  const expandedBodyRef = useRef<HTMLDivElement | null>(null);
  const queryClient = useQueryClient();
  // Failed commands load their output while collapsed so the error tail shows.
  const detailEnabled = expanded || execution.status === "failed";
  const detailQuery = useQuery(
    threadCommandExecutionQueryOptions({
      threadId,
      commandExecutionId: execution.id,
      enabled: detailEnabled,
    }),
  );
  const detailExecution = detailQuery.data?.commandExecution ?? null;
  const detailSource = detailExecution ?? execution;
  const fallbackOutput = resolveExecutionOutput(execution);
  const displayCommand = resolveCommandExecutionDisplayCommand(execution);
  const { copyToClipboard, isCopied } = useCopyToClipboard({
    onCopy: () => {
      toastManager.add({ type: "success", title: "Command copied" });
    },
    onError: (error) => {
      console.error("[CommandTranscriptCard] clipboard copy failed:", error);
      toastManager.add({
        type: "error",
        title: "Could not copy command",
        description:
          error instanceof Error ? error.message : "An unexpected clipboard error occurred.",
      });
    },
  });
  const normalizedDetail = normalizeCommandExecutionDetail(detailSource.detail);
  const summaryText = resolveCommandExecutionSummaryText(execution);
  const showCommandSection = summaryText !== displayCommand;
  const showDetailSection =
    normalizedDetail !== null &&
    normalizedDetail !== (detailExecution?.output ?? fallbackOutput) &&
    normalizedDetail !== detailSource.command &&
    normalizedDetail !== displayCommand &&
    normalizedDetail !== detailSource.title;
  const outputText = detailExecution?.output ?? fallbackOutput;
  const outputTruncated =
    detailExecution?.outputTruncated ?? resolveExecutionOutputTruncated(execution);
  const isLoadingOutput =
    expanded && detailExecution === null && detailQuery.isFetching && outputText.length === 0;
  const outputError =
    expanded && detailExecution === null && detailQuery.isError && outputText.length === 0
      ? detailQuery.error instanceof Error
        ? detailQuery.error.message
        : "Failed to load output."
      : null;
  const waitingForDetail = threadId !== null && detailExecution === null && outputError === null;
  // Codex and most other providers send no description, so fall back to a
  // label derived from the command, unless the body already shows it.
  const derivedLabel = useMemo(() => deriveCommandExecutionLabel(displayCommand), [displayCommand]);
  const description =
    detailSource.description ??
    execution.description ??
    (derivedLabel !== summaryText ? derivedLabel : null);
  const backgroundStatus = commandExecutionBackgroundStatus(detailSource);
  const cwdLabel = resolveCwdLabel(detailSource.cwd ?? execution.cwd, workspaceRoot);
  const showFailedOutputTail = !expanded && detailSource.status === "failed";
  const failedOutputTail = useMemo(
    () => (showFailedOutputTail ? buildOutputTail(outputText) : ""),
    [outputText, showFailedOutputTail],
  );

  useEffect(() => {
    // Collapsed failed cards only want a best-effort tail; don't poll for them.
    if (!expanded || !threadId || detailExecution !== null || detailQuery.data === undefined) {
      return;
    }
    const controller = new AbortController();
    void scheduleThreadCommandExecutionRefreshIfMissing(
      queryClient,
      {
        threadId,
        commandExecutionId: execution.id,
      },
      { signal: controller.signal },
    ).catch((error) => {
      if (error instanceof Error && error.name === "AbortError") {
        return;
      }
      console.warn("Failed to refresh provisional command transcript detail.", {
        threadId,
        commandExecutionId: execution.id,
        error,
      });
    });
    return () => {
      controller.abort();
    };
  }, [detailExecution, detailQuery.data, execution.id, expanded, queryClient, threadId]);

  useEffect(() => {
    if (!onExpandedBodyResize) return;
    const expandedBody = expandedBodyRef.current;
    if (!expandedBody || typeof ResizeObserver === "undefined") {
      return;
    }
    const observer = new ResizeObserver(() => {
      onExpandedBodyResize();
    });
    observer.observe(expandedBody);
    return () => {
      observer.disconnect();
    };
  }, [expanded, onExpandedBodyResize]);

  // Only a running command on a working thread subscribes to the shared clock.
  const nowIso = useNowIso(detailSource.status === "running" && threadWorking);
  const duration = formatElapsed(
    detailSource.startedAt,
    detailSource.completedAt ??
      (detailSource.status === "running" ? nowIso : detailSource.updatedAt),
  );
  const startedAtLabel = formatTimestamp(detailSource.startedAt, timestampFormat);
  const showExitCode = detailSource.exitCode !== null && detailSource.exitCode !== 0;

  return (
    <div
      className={cn(
        "group rounded-xl border border-l-2 border-border/60 bg-card/35",
        STATUS_PRESENTATION[detailSource.status].borderClassName,
      )}
    >
      <div className="flex w-full items-start gap-2.5 px-3 py-2.5">
        <button
          type="button"
          onClick={onToggle}
          className="flex min-w-0 flex-1 items-start gap-2.5 text-left"
          aria-expanded={expanded}
        >
          <span className="mt-px text-muted-foreground">
            {expanded ? (
              <ChevronDownIcon className="size-4" />
            ) : (
              <ChevronRightIcon className="size-4" />
            )}
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex min-h-4 min-w-0 items-center gap-2">
              <CommandStatusIcon status={detailSource.status} />
              {description && (
                <span className="min-w-0 truncate text-xs text-muted-foreground">
                  {description}
                </span>
              )}
              {backgroundStatus !== null && (
                <span
                  className="shrink-0 rounded-full border border-border/70 px-1.5 text-2xs leading-4 text-muted-foreground"
                  title={`Ran in the background (${backgroundStatus})`}
                >
                  background
                </span>
              )}
              <span
                className="ml-auto flex shrink-0 items-center gap-2 text-2xs tabular-nums text-muted-foreground"
                title={`Started ${startedAtLabel}`}
              >
                {showExitCode && (
                  <span className="text-destructive-foreground">exit {detailSource.exitCode}</span>
                )}
                <span>{duration ?? startedAtLabel}</span>
              </span>
            </div>
            <code
              className={cn(
                "mt-1 whitespace-pre-wrap break-all font-mono text-[length:var(--f5-chat-font-size)] text-foreground",
                expanded ? "block" : "line-clamp-2",
              )}
              title={expanded ? undefined : displayCommand}
            >
              {summaryText === displayCommand ? (
                <HighlightedCommandText command={displayCommand} />
              ) : (
                summaryText
              )}
            </code>
          </div>
        </button>
        <div className="shrink-0 opacity-0 transition-opacity duration-200 focus-within:opacity-100 group-hover:opacity-100">
          <CopyIconButton
            label={isCopied ? "Copied" : "Copy command"}
            copied={isCopied}
            onClick={(event) => {
              event.stopPropagation();
              copyToClipboard(displayCommand);
            }}
          />
        </div>
      </div>

      {failedOutputTail.length > 0 && (
        // Outside the toggle so the error text stays selectable; bottom-anchored
        // so wrapped earlier lines clip at the top and the last line stays visible.
        <div className="-mt-1 flex max-h-20 flex-col justify-end overflow-hidden pr-3 pb-2.5 pl-[2.375rem]">
          <pre
            data-testid="command-failed-output-tail"
            className="whitespace-pre-wrap break-all rounded-md bg-destructive/6 px-2 py-1 font-mono text-xs text-muted-foreground"
          >
            {failedOutputTail}
          </pre>
        </div>
      )}

      {expanded && (
        <div ref={expandedBodyRef} className="border-t border-border/60 px-3 py-3">
          <div className="space-y-3">
            {cwdLabel !== null && (
              <p
                className="truncate font-mono text-2xs text-muted-foreground"
                title={detailSource.cwd ?? execution.cwd}
              >
                in {cwdLabel}
              </p>
            )}

            {showCommandSection && (
              <div>
                <p className={SECTION_LABEL_CLASS_NAME}>Command</p>
                <pre className="mt-1 overflow-x-auto whitespace-pre-wrap break-all rounded-md bg-background/70 p-2 font-mono text-[length:var(--f5-chat-font-size)] text-foreground">
                  <HighlightedCommandText command={displayCommand} />
                </pre>
              </div>
            )}

            <CommandTranscriptOutput
              executionId={execution.id}
              outputText={waitingForDetail ? "" : outputText}
              outputTruncated={outputTruncated}
              isLoadingOutput={isLoadingOutput || waitingForDetail}
              outputError={outputError}
            />

            {showDetailSection && (
              <div>
                <p className={SECTION_LABEL_CLASS_NAME}>Detail</p>
                <p className="mt-1 whitespace-pre-wrap text-sm text-muted-foreground">
                  {normalizedDetail}
                </p>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
});
