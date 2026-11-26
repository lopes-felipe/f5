import type { McpRepositoryServer, ProjectId } from "@t3tools/contracts";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import {
  invalidateMcpConfigQueries,
  mcpQueryKeys,
  mcpRepositoryServersQueryOptions,
} from "../../../lib/mcpReactQuery";
import { ensureNativeApi } from "../../../nativeApi";
import { Badge } from "../../ui/badge";
import { Button } from "../../ui/button";
import {
  Dialog,
  DialogClose,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../../ui/dialog";
import { mcpRepositoryCredentialUses } from "./mcpRepositoryCredentials";
import { readErrorMessage } from "./mcpSettingsHelpers";

const STATE_LABELS: Record<McpRepositoryServer["state"], string> = {
  approved: "Approved",
  "needs-approval": "Needs approval",
  changed: "Changed",
};

function summary(server: McpRepositoryServer["server"]): string {
  return server.type === "stdio"
    ? [server.command, ...(server.args ?? [])].join(" ")
    : `${server.type.toUpperCase()} ${server.url}`;
}

/** Fields shown in their own rows; every other field is listed under its own name. */
const DETAILED_FIELDS = new Set(["type", "command", "args", "cwd", "env", "url", "headers"]);

/** What the server will run or reach, in full, for the approval decision. */
function DefinitionDetails(props: { server: McpRepositoryServer["server"] }) {
  const { server } = props;
  const credentialUses = mcpRepositoryCredentialUses(server);
  const otherRows: Array<[string, string]> = Object.entries(server)
    .filter(([key, value]) => !DETAILED_FIELDS.has(key) && value !== undefined)
    .toSorted(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => [key, typeof value === "string" ? value : JSON.stringify(value)]);
  const rows: Array<[string, string]> =
    server.type === "stdio"
      ? [
          ["Command", server.command],
          ["Arguments", (server.args ?? []).join("\n") || "None"],
          ...(server.cwd ? ([["Working directory", server.cwd]] as Array<[string, string]>) : []),
          [
            "Environment",
            Object.entries(server.env ?? {})
              .map(([key, value]) => `${key}=${value}`)
              .join("\n") || "None",
          ],
        ]
      : [
          ["Transport", server.type.toUpperCase()],
          ["URL", server.url],
          [
            "Headers",
            Object.entries(server.headers ?? {})
              .map(([key, value]) => `${key}: ${value}`)
              .join("\n") || "None",
          ],
        ];
  return (
    <div className="grid gap-3">
      {credentialUses.length ? (
        <div
          role="alert"
          aria-label="Values from your environment"
          className="rounded-md border border-warning/40 bg-warning/10 px-2 py-1.5 text-xs"
        >
          <p className="font-medium text-foreground">
            Sends values from your environment to this server
          </p>
          <ul className="mt-1 list-disc space-y-0.5 pl-4 font-mono">
            {credentialUses.map((use) => (
              <li key={use}>{use}</li>
            ))}
          </ul>
        </div>
      ) : null}
      <dl className="grid gap-2 text-xs">
        {[...rows, ...otherRows].map(([label, value]) => (
          <div key={label} className="grid gap-0.5">
            <dt className="font-medium text-foreground">{label}</dt>
            <dd className="whitespace-pre-wrap break-all rounded-md bg-muted px-2 py-1 font-mono">
              {value}
            </dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

/**
 * Servers from the project's `.mcp.json`. They are read-only here and never start
 * until approved; a changed definition needs approval again.
 */
export function McpRepositoryServers(props: { projectId: ProjectId }) {
  const queryClient = useQueryClient();
  const query = useQuery(mcpRepositoryServersQueryOptions({ projectId: props.projectId }));
  const [reviewing, setReviewing] = useState<McpRepositoryServer | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const result = query.data;
  if (!result || (!result.found && result.issues.length === 0)) return null;

  const setTrust = async (server: McpRepositoryServer, trusted: boolean) => {
    setBusy(true);
    setError(null);
    try {
      const next = await ensureNativeApi().mcp.setRepositoryServerTrust({
        projectId: props.projectId,
        serverName: server.name,
        trusted,
        ...(trusted ? { definitionHash: server.definitionHash } : {}),
      });
      queryClient.setQueryData(mcpQueryKeys.repositoryServers(props.projectId), next);
      await invalidateMcpConfigQueries(queryClient);
      setReviewing(null);
    } catch (cause) {
      setError(readErrorMessage(cause, "The approval could not be changed."));
      // The file may have changed under the dialog; show what is there now.
      await query.refetch();
    } finally {
      setBusy(false);
    }
  };

  return (
    <section aria-label="Repository servers" className="space-y-2">
      <p className="text-sm font-medium text-foreground">From this repository</p>
      <p className="text-xs text-muted-foreground">
        Read from <code className="font-mono">{result.path ?? ".mcp.json"}</code>. These servers
        start only after you approve them, and again after any change to their definition.
      </p>
      {error ? (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      ) : null}
      {result.servers.length ? (
        <ul className="divide-y divide-border rounded-lg border border-border bg-background">
          {result.servers.map((server) => (
            <li key={server.name} className="flex flex-wrap items-center gap-2 px-3 py-2">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium">{server.name}</span>
                  <Badge variant={server.state === "approved" ? "outline" : "warning"}>
                    {STATE_LABELS[server.state]}
                  </Badge>
                  {server.overridden ? (
                    <Badge variant="outline">Overridden by project</Badge>
                  ) : null}
                  {server.disabled ? (
                    <Badge variant="outline">Turned off for this project</Badge>
                  ) : null}
                </div>
                <p className="truncate font-mono text-xs text-muted-foreground">
                  {summary(server.server)}
                </p>
              </div>
              {server.state === "approved" ? (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy}
                  onClick={() => void setTrust(server, false)}
                >
                  Revoke
                </Button>
              ) : (
                <Button size="sm" disabled={busy} onClick={() => setReviewing(server)}>
                  {server.state === "changed" ? "Review change" : "Review"}
                </Button>
              )}
            </li>
          ))}
        </ul>
      ) : null}
      {result.issues.length ? (
        <ul className="list-disc space-y-0.5 pl-5 text-xs text-muted-foreground">
          {result.issues.map((issue) => (
            <li key={issue}>{issue}</li>
          ))}
        </ul>
      ) : null}

      <Dialog open={reviewing !== null} onOpenChange={(open) => (open ? null : setReviewing(null))}>
        <DialogPopup className="max-w-lg">
          <DialogHeader>
            <DialogTitle className="text-base">Approve {reviewing?.name}?</DialogTitle>
            <DialogDescription>
              {reviewing?.state === "changed"
                ? "This server's definition in .mcp.json changed since you approved it. "
                : ""}
              Approving lets F5 start it for this project's conversations. It runs with your
              permissions, so only approve what you trust.
            </DialogDescription>
          </DialogHeader>
          <DialogPanel>
            {reviewing ? <DefinitionDetails server={reviewing.server} /> : null}
          </DialogPanel>
          <DialogFooter variant="bare">
            <DialogClose render={<Button type="button" variant="outline" />}>Cancel</DialogClose>
            <Button
              type="button"
              disabled={busy || !reviewing}
              onClick={() => reviewing && void setTrust(reviewing, true)}
            >
              Approve
            </Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>
    </section>
  );
}
