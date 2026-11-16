import { useLayoutEffect, useRef, useState } from "react";

import { useCopyToClipboard } from "~/hooks/useCopyToClipboard";
import { cn } from "~/lib/utils";
import ChatMarkdown from "../ChatMarkdown";
import { toastManager } from "../ui/toast";
import { CopyIconButton } from "./CopyIconButton";
import { parseJsonObject } from "./MessagesTimeline.logic";

/** Ingestion cuts long MCP payloads and marks the cut with an ellipsis. */
function isTruncatedPayload(text: string): boolean {
  return text.endsWith("…");
}

/** The text a section's copy button writes: pretty JSON when the input parses. */
export function mcpInputCopyText(mcpInput: string): string {
  const input = parseJsonObject(mcpInput);
  return input ? JSON.stringify(input, null, 2) : mcpInput;
}

function formatInputValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === undefined) return "undefined";
  return JSON.stringify(value) ?? String(value);
}

function SectionHeader(props: { label: string; copyText: string; truncated: boolean }) {
  const { copyToClipboard, isCopied } = useCopyToClipboard({
    onError: (error) => {
      toastManager.add({
        type: "error",
        title: `Could not copy ${props.label.toLowerCase()}`,
        description:
          error instanceof Error ? error.message : "An unexpected clipboard error occurred.",
      });
    },
  });
  return (
    <div className="flex min-h-5 items-center gap-2">
      <p className="text-2xs font-semibold tracking-widest text-muted-foreground uppercase">
        {props.label}
      </p>
      {props.truncated ? (
        <span
          className="text-2xs text-muted-foreground"
          title="F5 stores the first 4,000 characters of MCP payloads"
        >
          truncated
        </span>
      ) : null}
      <CopyIconButton
        className="ml-auto"
        label={`Copy ${props.label.toLowerCase()}`}
        copied={isCopied}
        onClick={() => copyToClipboard(props.copyText)}
      />
    </div>
  );
}

function McpInputSection(props: { mcpInput: string }) {
  const input = parseJsonObject(props.mcpInput);
  const entries = input ? Object.entries(input) : [];
  return (
    <div>
      <SectionHeader
        label="Input"
        copyText={mcpInputCopyText(props.mcpInput)}
        truncated={isTruncatedPayload(props.mcpInput)}
      />
      {input && entries.length > 0 ? (
        <dl
          className="mt-1 grid max-h-48 grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1 overflow-auto font-mono text-xs leading-5"
          data-testid="mcp-input-grid"
        >
          {entries.map(([key, value]) => (
            <div key={key} className="contents">
              <dt className="text-muted-foreground">{key}</dt>
              <dd className="wrap-break-word whitespace-pre-wrap text-foreground">
                {formatInputValue(value)}
              </dd>
            </div>
          ))}
        </dl>
      ) : (
        <pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap wrap-break-word rounded-md bg-muted/40 p-2 font-mono text-xs leading-5 text-foreground">
          {props.mcpInput}
        </pre>
      )}
    </div>
  );
}

function McpResultSection(props: {
  mcpResult: string;
  markdownCwd: string | undefined;
  failed: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const [overflows, setOverflows] = useState(false);
  const blockRef = useRef<HTMLDivElement>(null);

  // Rendered markdown height isn't known up front, so measure whether the cap clips it.
  useLayoutEffect(() => {
    const block = blockRef.current;
    if (!block || expanded) return;
    const measure = () => setOverflows(block.scrollHeight > block.clientHeight + 1);
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    const content = block.firstElementChild;
    if (content) observer.observe(content);
    return () => observer.disconnect();
  }, [expanded, props.mcpResult]);

  const capped = !expanded;
  return (
    <div>
      <SectionHeader
        label="Result"
        copyText={props.mcpResult}
        truncated={isTruncatedPayload(props.mcpResult)}
      />
      <div
        ref={blockRef}
        className={cn(
          "mt-1 rounded-md p-2 text-ui text-foreground",
          props.failed ? "bg-destructive/8" : "bg-muted/40",
          capped ? "max-h-28 overflow-hidden" : "max-h-80 overflow-auto",
          capped && overflows && "[mask-image:linear-gradient(to_bottom,black_55%,transparent)]",
        )}
        data-testid="mcp-result"
      >
        <div>
          <ChatMarkdown text={props.mcpResult} cwd={props.markdownCwd} isStreaming={false} />
        </div>
      </div>
      {overflows || expanded ? (
        <button
          type="button"
          className="mt-1 rounded-sm text-xs text-info-foreground outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring"
          aria-expanded={expanded}
          onClick={() => setExpanded((value) => !value)}
        >
          {expanded ? "Show less" : "Show full result"}
        </button>
      ) : null}
    </div>
  );
}

/** The Input and Result sections shared by MCP tool cards and automation step drawers. */
export function McpToolCallDetails(props: {
  mcpInput: string | undefined;
  mcpResult: string | undefined;
  markdownCwd: string | undefined;
  failed?: boolean;
}) {
  const { mcpInput, mcpResult, markdownCwd } = props;
  return (
    <div className="space-y-3">
      {mcpInput && <McpInputSection mcpInput={mcpInput} />}
      {mcpResult && (
        <McpResultSection
          mcpResult={mcpResult}
          markdownCwd={markdownCwd}
          failed={props.failed === true}
        />
      )}
    </div>
  );
}
