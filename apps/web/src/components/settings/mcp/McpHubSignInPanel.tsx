import type { McpHubAuthServerStatus, McpHubSignInAttempt, ProjectId } from "@t3tools/contracts";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import { isWebUrl } from "../../../browser/webUrl";
import { mcpHubAuthQueryOptions, mcpQueryKeys } from "../../../lib/mcpReactQuery";
import { ensureNativeApi } from "../../../nativeApi";
import { Badge } from "../../ui/badge";
import { Button } from "../../ui/button";
import { Input } from "../../ui/input";
import { MCP_HUB_PROVIDER_LABELS } from "./McpHubStatusPanel";
import { readErrorMessage } from "./mcpSettingsHelpers";

function describeExpiry(server: McpHubAuthServerStatus): string | null {
  if (!server.signedIn) return null;
  if (server.refreshable) return "Renews automatically";
  if (!server.expiresAt) return null;
  return `Access expires ${new Date(server.expiresAt).toLocaleString()}`;
}

function SignInRow({
  server,
  projectId,
}: {
  readonly server: McpHubAuthServerStatus;
  readonly projectId: ProjectId | null;
}) {
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState<"start" | "finish" | "sign-out" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pasted, setPasted] = useState("");
  const [started, setStarted] = useState<McpHubSignInAttempt | null>(null);
  // The server's view wins once it has caught up; the local attempt covers the gap.
  const attempt = server.pending ?? (server.signedIn ? null : started);
  const scope = projectId ? { projectId } : {};

  const refresh = () =>
    queryClient.invalidateQueries({ queryKey: mcpQueryKeys.hubAuth(projectId) });

  const openPage = (url: string) => {
    if (!isWebUrl(url)) {
      setError("This sign-in link is not a web address, so it was not opened.");
      return Promise.resolve();
    }
    return ensureNativeApi()
      .shell.openExternal(url)
      .catch(() =>
        setError("Could not open the browser. Open the sign-in page again or copy its address."),
      );
  };

  const run = async (kind: "start" | "finish" | "sign-out", action: () => Promise<void>) => {
    setBusy(kind);
    setError(null);
    try {
      await action();
    } catch (cause) {
      setError(readErrorMessage(cause, `Could not update sign-in for ${server.name}.`));
    } finally {
      setBusy(null);
      void refresh();
    }
  };

  const start = () =>
    run("start", async () => {
      const result = await ensureNativeApi().mcp.startHubSignIn({
        serverName: server.name,
        ...scope,
      });
      if (result.status !== "pending") return;
      setStarted(result.attempt);
      setPasted("");
      // Opened only because the user clicked Sign in.
      await openPage(result.attempt.authorizationUrl);
    });

  const finish = (current: McpHubSignInAttempt) =>
    run("finish", async () => {
      await ensureNativeApi().mcp.completeHubSignIn({
        attemptId: current.attemptId,
        redirectedUrl: pasted.trim(),
      });
      setStarted(null);
      setPasted("");
    });

  const signOut = () =>
    run("sign-out", async () => {
      await ensureNativeApi().mcp.signOutHubServer({ serverName: server.name, ...scope });
      setStarted(null);
    });

  const expiry = describeExpiry(server);
  return (
    <li className="space-y-2 rounded border border-border px-2 py-1.5">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium text-foreground">{server.name}</span>
        {server.signedIn ? (
          <Badge variant="success">Signed in</Badge>
        ) : attempt ? (
          <Badge variant="info">Waiting for browser</Badge>
        ) : (
          <Badge variant="outline">Not signed in</Badge>
        )}
        {expiry ? <span className="text-muted-foreground">{expiry}</span> : null}
        <span className="ml-auto flex gap-2">
          {attempt ? (
            <Button
              size="xs"
              variant="outline"
              disabled={busy !== null}
              onClick={() => void openPage(attempt.authorizationUrl)}
            >
              Open sign-in page
            </Button>
          ) : null}
          <Button size="xs" variant="outline" disabled={busy !== null} onClick={() => void start()}>
            {busy === "start"
              ? "Starting..."
              : server.signedIn
                ? "Sign in again"
                : attempt
                  ? "Restart sign-in"
                  : "Sign in"}
          </Button>
          {server.signedIn ? (
            <Button
              size="xs"
              variant="outline"
              disabled={busy !== null}
              onClick={() => void signOut()}
            >
              {busy === "sign-out" ? "Signing out..." : "Sign out"}
            </Button>
          ) : null}
        </span>
      </div>
      {attempt ? (
        <form
          className="flex flex-wrap items-center gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            if (pasted.trim()) void finish(attempt);
          }}
        >
          <span className="basis-full text-muted-foreground">
            Sign-in finishes on its own when the browser returns to this computer. If your browser
            runs on another machine, paste the address it ended on (starting with{" "}
            <code>{attempt.redirectUrl}</code>).
          </span>
          <Input
            size="sm"
            className="min-w-0 flex-1"
            aria-label={`Redirected address for ${server.name}`}
            placeholder={`${attempt.redirectUrl}?code=...`}
            value={pasted}
            onChange={(event) => setPasted(event.currentTarget.value)}
          />
          <Button
            type="submit"
            size="xs"
            variant="outline"
            disabled={busy !== null || pasted.trim().length === 0}
          >
            {busy === "finish" ? "Finishing..." : "Finish sign-in"}
          </Button>
        </form>
      ) : null}
      {error ? <p className="text-destructive">{error}</p> : null}
    </li>
  );
}

/**
 * Sign-in for remote servers the hub connects to. Tokens are shared by every
 * project and agent in the profile, so this works from either scope with no
 * conversation running. F5 opens the browser only when the user clicks.
 */
export function McpHubSignInPanel({ projectId }: { readonly projectId: ProjectId | null }) {
  const authStatus = useQuery(mcpHubAuthQueryOptions({ projectId }));
  const servers = authStatus.data?.servers ?? [];
  if (!authStatus.error && servers.length === 0) return null;
  return (
    <section
      aria-label="Sign-in for other agents"
      className="space-y-2 rounded-lg border border-border p-3 text-xs"
    >
      <p className="font-medium text-foreground">Sign-in for other agents</p>
      <p className="text-muted-foreground">
        F5 signs in to remote servers for {MCP_HUB_PROVIDER_LABELS.join(", ")}. A sign-in is shared
        by every project that uses the same server.
      </p>
      {authStatus.error ? (
        <p className="text-destructive">
          {readErrorMessage(authStatus.error, "Failed to load sign-in state.")}
        </p>
      ) : null}
      <ul className="space-y-2">
        {servers.map((server) => (
          <SignInRow key={server.name} server={server} projectId={projectId} />
        ))}
      </ul>
    </section>
  );
}
