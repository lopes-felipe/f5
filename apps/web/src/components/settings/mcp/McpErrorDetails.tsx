import { createMcpDiagnosticsSanitizer } from "@t3tools/shared/mcpDiagnostics";
import type { McpProjectServersConfig } from "@t3tools/contracts";
import { useCopyToClipboard } from "../../../hooks/useCopyToClipboard";
import { Button } from "../../ui/button";

export function McpErrorDetails({
  message,
  servers = {},
}: {
  readonly message: string;
  readonly servers?: McpProjectServersConfig;
}) {
  const { copyToClipboard, isCopied } = useCopyToClipboard();
  const text = createMcpDiagnosticsSanitizer(servers).text(message);
  return (
    <details className="rounded border border-border p-2 text-xs">
      <summary className="cursor-pointer text-destructive">Connection details</summary>
      <pre className="my-2 max-h-48 overflow-auto whitespace-pre-wrap break-words font-mono">
        {text}
      </pre>
      <Button size="xs" variant="outline" onClick={() => copyToClipboard(text, undefined)}>
        {isCopied ? "Copied" : "Copy error"}
      </Button>
    </details>
  );
}
