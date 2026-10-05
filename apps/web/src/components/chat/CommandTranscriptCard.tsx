import type {
  OrchestrationCommandExecution,
  OrchestrationCommandExecutionSummary,
  ThreadId,
} from "@t3tools/contracts";
import {
  normalizeCommandExecutionDetail,
  resolveCommandExecutionDisplayCommand,
  resolveCommandExecutionSummaryText,
} from "@t3tools/shared/commandSummary";
import { CheckIcon, ChevronDownIcon, ChevronRightIcon, CopyIcon } from "lucide-react";
import { memo, useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";

import type { TimestampFormat } from "../../appSettings";
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
import { Button } from "../ui/button";
import { toastManager } from "../ui/toast";

interface CommandTranscriptCardProps {
  threadId?: ThreadId | null;
  execution: OrchestrationCommandExecutionSummary | OrchestrationCommandExecution;
  expanded: boolean;
  nowIso: string;
  timestampFormat: TimestampFormat;
  onToggle: () => void;
  onExpandedBodyResize?: () => void;
}

const STATUS_BADGE_CLASS_NAME: Record<OrchestrationCommandExecutionSummary["status"], string> = {
  running: "border-info/32 bg-info/8 text-info-foreground dark:bg-info/16",
  completed: "border-success/32 bg-success/8 text-success-foreground dark:bg-success/16",
  failed:
    "border-destructive/32 bg-destructive/8 text-destructive-foreground dark:bg-destructive/16",
  interrupted: "border-warning/32 bg-warning/8 text-warning-foreground dark:bg-warning/16",
  declined: "border-border bg-muted/40 text-muted-foreground",
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

const INLINE_OUTPUT_PREVIEW_CHAR_LIMIT = 16_000;
const INLINE_OUTPUT_PREVIEW_HEAD_CHARS = 8_000;
const INLINE_OUTPUT_PREVIEW_MARKER = "\n\n[... output preview shortened ...]\n\n";

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

function buildInlineOutputPreview(output: string): { text: string; shortened: boolean } {
  if (output.length <= INLINE_OUTPUT_PREVIEW_CHAR_LIMIT) {
    return { text: output, shortened: false };
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
  };
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

  useEffect(() => {
    setShowFullOutput(false);
  }, [props.executionId]);

  const displayOutput = showFullOutput || !preview.shortened ? props.outputText : preview.text;
  const showPreviewToggle =
    !props.isLoadingOutput && props.outputError === null && preview.shortened;

  return (
    <div>
      <p className="text-2xs uppercase tracking-wider text-muted-foreground">Output</p>
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
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <p className="text-2xs text-muted-foreground">
            Showing a compact preview for this large transcript.
          </p>
          <Button
            type="button"
            size="xs"
            variant="outline"
            onClick={() => {
              setShowFullOutput((current) => !current);
            }}
          >
            {showFullOutput ? "Show preview" : "Show full output"}
          </Button>
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
  nowIso,
  timestampFormat,
  onToggle,
  onExpandedBodyResize,
}: CommandTranscriptCardProps) {
  const expandedBodyRef = useRef<HTMLDivElement | null>(null);
  const queryClient = useQueryClient();
  const detailQuery = useQuery(
    threadCommandExecutionQueryOptions({
      threadId,
      commandExecutionId: execution.id,
      enabled: expanded,
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

  useEffect(() => {
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

  const duration = formatElapsed(
    detailSource.startedAt,
    detailSource.completedAt ??
      (detailSource.status === "running" ? nowIso : detailSource.updatedAt),
  );
  const meta = duration
    ? `${formatTimestamp(detailSource.startedAt, timestampFormat)} • ${duration}`
    : formatTimestamp(detailSource.startedAt, timestampFormat);

  return (
    <div className="group rounded-xl border border-border/60 bg-card/35">
      <div className="flex w-full items-start gap-3 px-3 py-3">
        <button
          type="button"
          onClick={onToggle}
          className="flex min-w-0 flex-1 items-start gap-3 text-left"
          aria-expanded={expanded}
        >
          <span className="mt-0.5 text-muted-foreground">
            {expanded ? (
              <ChevronDownIcon className="size-4" />
            ) : (
              <ChevronRightIcon className="size-4" />
            )}
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <span
                className={cn(
                  "inline-flex rounded-full border px-2 py-0.5 text-2xs font-medium uppercase tracking-wider",
                  STATUS_BADGE_CLASS_NAME[detailSource.status],
                )}
              >
                {detailSource.status}
              </span>
              {detailSource.exitCode !== null && (
                <span className="text-2xs text-muted-foreground">exit {detailSource.exitCode}</span>
              )}
              <span className="text-2xs text-muted-foreground">{meta}</span>
            </div>
            <code className="mt-2 block overflow-x-auto whitespace-pre-wrap break-all font-mono text-[length:var(--f5-chat-font-size)] text-foreground">
              {summaryText === displayCommand ? (
                <HighlightedCommandText command={displayCommand} />
              ) : (
                summaryText
              )}
            </code>
          </div>
        </button>
        <div className="mt-0.5 shrink-0 opacity-0 transition-opacity duration-200 focus-within:opacity-100 group-hover:opacity-100">
          <Button
            type="button"
            size="xs"
            variant="outline"
            title={isCopied ? "Copied" : "Copy command"}
            aria-label={isCopied ? "Copied" : "Copy command"}
            onClick={(event) => {
              event.stopPropagation();
              copyToClipboard(displayCommand);
            }}
          >
            {isCopied ? (
              <CheckIcon className="size-3 text-success" />
            ) : (
              <CopyIcon className="size-3" />
            )}
          </Button>
        </div>
      </div>

      {expanded && (
        <div ref={expandedBodyRef} className="border-t border-border/60 px-3 py-3">
          <div className="space-y-3">
            {showCommandSection && (
              <div>
                <p className="text-2xs uppercase tracking-wider text-muted-foreground">Command</p>
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
                <p className="text-2xs uppercase tracking-wider text-muted-foreground">Detail</p>
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
