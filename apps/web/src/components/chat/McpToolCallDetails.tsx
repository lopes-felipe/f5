import ChatMarkdown from "../ChatMarkdown";

/** The Input and Result sections shared by MCP tool cards and automation step drawers. */
export function McpToolCallDetails(props: {
  mcpInput: string | undefined;
  mcpResult: string | undefined;
  markdownCwd: string | undefined;
}) {
  const { mcpInput, mcpResult, markdownCwd } = props;
  return (
    <div className="space-y-3">
      {mcpInput && (
        <div>
          <p className="text-2xs font-medium text-muted-foreground">Input</p>
          <pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap wrap-break-word rounded-md bg-muted/40 p-2 font-mono text-xs leading-5 text-foreground">
            {mcpInput}
          </pre>
        </div>
      )}
      {mcpResult && (
        <div>
          <p className="text-2xs font-medium text-muted-foreground">Result</p>
          <div className="mt-1 max-h-80 overflow-auto rounded-md bg-muted/40 p-2 text-ui text-foreground">
            <ChatMarkdown text={mcpResult} cwd={markdownCwd} isStreaming={false} />
          </div>
        </div>
      )}
    </div>
  );
}
