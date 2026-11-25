import type { McpProjectServersConfig } from "@t3tools/contracts";

import { useUpdateSettings } from "../../../hooks/useSettings";
import { useNativeProvidersOnHub } from "../../../lib/mcpHubChat";
import { Switch } from "../../ui/switch";

/**
 * How Codex and Claude reach configured servers. With F5's hub (the default), remote
 * servers they were signed in to need one sign-in in F5, since their saved sign-ins are
 * not moved. `mcpNativePassthrough` restores their own connections for one release.
 */
export function McpHubNotice(props: { readonly servers: McpProjectServersConfig | undefined }) {
  const passthrough = !useNativeProvidersOnHub();
  const { updateSettings } = useUpdateSettings();
  const remote = Object.values(props.servers ?? {}).some(
    (server) => server.type !== "stdio" && server.enabled !== false,
  );
  return (
    <section
      aria-label="How Codex and Claude connect"
      className="space-y-2 rounded-lg border border-border bg-background px-3 py-2 text-xs"
    >
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1 space-y-1">
          <p className="font-medium text-foreground">
            {passthrough
              ? "Codex and Claude connect to servers themselves"
              : "Codex and Claude connect through F5"}
          </p>
          <p className="text-muted-foreground">
            {passthrough
              ? "They start these servers with their own settings and sign-ins. This option goes away in a later release."
              : "F5 runs these servers for every agent, in the conversation's folder, and keeps their secrets and sign-ins."}
          </p>
          {!passthrough && remote ? (
            <p className="text-muted-foreground">
              Sign-ins Codex and Claude saved earlier are not carried over: a server that needs one
              asks once in F5, on its Sign-in tab or in the chat's MCP chip.
            </p>
          ) : null}
        </div>
        <Switch
          aria-label="Let Codex and Claude connect to servers themselves"
          checked={passthrough}
          onCheckedChange={(checked) => updateSettings({ mcpNativePassthrough: checked })}
        />
      </div>
      <p className="text-muted-foreground">New sessions use the change.</p>
    </section>
  );
}
