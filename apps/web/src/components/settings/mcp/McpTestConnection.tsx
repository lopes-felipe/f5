import type {
  McpProbeServerResult,
  McpServerDefinition,
  ProjectId,
  ProviderInstanceId,
} from "@t3tools/contracts";
import { useState } from "react";
import { ensureNativeApi } from "../../../nativeApi";
import { useCopyToClipboard } from "../../../hooks/useCopyToClipboard";
import { Button } from "../../ui/button";
import { readErrorMessage } from "./mcpSettingsHelpers";

export function McpTestConnection(props: {
  projectId: ProjectId | null;
  instanceId: ProviderInstanceId;
  getServer: () => { name: string; server: McpServerDefinition };
  onResult?: (result: McpProbeServerResult) => void;
  onOpenTools?: () => void;
}) {
  const [showTools, setShowTools] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<McpProbeServerResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { copyToClipboard, isCopied } = useCopyToClipboard();
  return (
    <div className="space-y-2 text-xs">
      <Button
        size="xs"
        variant="outline"
        disabled={busy}
        onClick={() => {
          setBusy(true);
          setError(null);
          setResult(null);
          try {
            const { name, server } = props.getServer();
            void ensureNativeApi()
              .mcp.probeServer({
                ...(props.projectId ? { projectId: props.projectId } : {}),
                instanceId: props.instanceId,
                serverName: name,
                server,
              })
              .then((value) => {
                setResult(value);
                props.onResult?.(value);
              })
              .catch((cause) => setError(readErrorMessage(cause, "Test failed.")))
              .finally(() => setBusy(false));
          } catch (cause) {
            setError(readErrorMessage(cause, "Invalid draft."));
            setBusy(false);
          }
        }}
      >
        {busy ? "Testing…" : "Test"}
      </Button>
      {error ? (
        <p role="alert" className="text-destructive">
          {error}
        </p>
      ) : null}
      {result ? (
        <div role="status" className="space-y-2 rounded border p-3">
          <p>
            {result.ok
              ? "Connected"
              : result.authRequired
                ? "Sign-in required"
                : "Connection failed"}{" "}
            · {result.durationMs} ms
          </p>
          {result.serverInfo ? (
            <p>
              {result.serverInfo.name} {result.serverInfo.version}
            </p>
          ) : null}
          {result.protocolVersion ? <p>Protocol {result.protocolVersion}</p> : null}
          <Button
            size="xs"
            variant="outline"
            onClick={() =>
              props.onOpenTools ? props.onOpenTools() : setShowTools((shown) => !shown)
            }
          >
            {result.tools.length}
            {result.toolsTruncated ? "+" : ""} tools
          </Button>
          {showTools && !props.onOpenTools ? (
            <div className="max-h-48 space-y-2 overflow-auto">
              {result.tools.map((tool) => (
                <div key={tool.name}>
                  <p>{tool.name}</p>
                  {tool.description ? <p>{tool.description}</p> : null}
                </div>
              ))}
            </div>
          ) : null}
          <p>
            {result.resourceCount} resources · {result.promptCount} prompts
          </p>
          {result.error ? (
            <p className="whitespace-pre-wrap break-words text-destructive">{result.error}</p>
          ) : null}
          {result.authRequired ? (
            <p className="text-muted-foreground">
              {props.projectId
                ? "A test can't sign in. Use Sign in on this server when its live status reports it needs sign-in."
                : "A test can't sign in. Switch the settings scope to a project, or use the sign-in prompt above the composer in a conversation."}
            </p>
          ) : null}
          {result.stderrTail ? (
            <pre className="max-h-36 overflow-auto whitespace-pre-wrap break-all">
              {result.stderrTail}
            </pre>
          ) : null}
          <Button
            size="xs"
            variant="outline"
            onClick={() => void copyToClipboard(JSON.stringify(result, null, 2))}
          >
            {isCopied ? "Copied" : "Copy details"}
          </Button>
        </div>
      ) : null}
    </div>
  );
}
