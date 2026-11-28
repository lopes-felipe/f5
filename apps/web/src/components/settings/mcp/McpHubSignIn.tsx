import type { McpHubAuthServerStatus, McpHubSignInAttempt, ProjectId } from "@t3tools/contracts";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import { isWebUrl } from "../../../browser/webUrl";
import { mcpHubAuthQueryOptions, mcpQueryKeys } from "../../../lib/mcpReactQuery";
import { ensureNativeApi } from "../../../nativeApi";
import { Badge } from "../../ui/badge";
import { Button } from "../../ui/button";
import { Input } from "../../ui/input";
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
  statusUpdatedAt,
}: {
  readonly server: McpHubAuthServerStatus;
  readonly projectId: ProjectId | null;
  /** When the server's status was last fetched (epoch ms). */
  readonly statusUpdatedAt: number;
}) {
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState<"start" | "finish" | "sign-out" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pasted, setPasted] = useState("");
  const [started, setStarted] = useState<{
    readonly attempt: McpHubSignInAttempt;
    readonly at: number;
  } | null>(null);
  // The server's view wins once it has caught up; the local attempt covers the gap
  // until a status fetched after it shows the attempt ended (timed out or cancelled).
  const localAttempt =
    started && !(statusUpdatedAt > started.at && !server.pending) ? started.attempt : null;
  const attempt = server.pending ?? (server.signedIn ? null : localAttempt);
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
      setStarted({ attempt: result.attempt, at: Date.now() });
      setPasted("");
      // Opened only because the user clicked Sign in.
      await openPage(result.attempt.authorizationUrl);
    });

  const finish = (current: McpHubSignInAttempt) =>
    run("finish", async () => {
      try {
        await ensureNativeApi().mcp.completeHubSignIn({
          attemptId: current.attemptId,
          redirectedUrl: pasted.trim(),
        });
      } catch (cause) {
        // A failed completion ends the attempt on the server; start again from here.
        setStarted(null);
        throw cause;
      }
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

/** One server's F5 sign-in row without the settings heading, for the chat's MCP chip. */
export function McpHubSignInRow({
  serverName,
  projectId,
}: {
  readonly serverName: string;
  readonly projectId: ProjectId | null;
}) {
  const authStatus = useQuery(mcpHubAuthQueryOptions({ projectId }));
  const server = authStatus.data?.servers.find((entry) => entry.name === serverName);
  if (!server) return null;
  return (
    <ul className="text-xs">
      <SignInRow
        key={`${projectId ?? "common"}:${server.name}`}
        server={server}
        projectId={projectId}
        statusUpdatedAt={authStatus.dataUpdatedAt}
      />
    </ul>
  );
}

/**
 * F5's own sign-in for one remote server, used by the agents the hub serves.
 * Tokens are shared by every project and agent in the profile, so this works from
 * either scope with no conversation running. F5 opens the browser only on a click.
 */
export function McpHubSignIn({
  serverName,
  projectId,
}: {
  readonly serverName: string;
  readonly projectId: ProjectId | null;
}) {
  const authStatus = useQuery(mcpHubAuthQueryOptions({ projectId }));
  const server = authStatus.data?.servers.find((entry) => entry.name === serverName);
  return (
    <section aria-label="F5 sign-in" className="space-y-2 text-xs">
      <p className="font-medium text-foreground">F5 sign-in</p>
      <p className="text-muted-foreground">
        F5 signs in for every agent. A sign-in is shared by every project that uses the same server.
      </p>
      <p className="text-muted-foreground">
        Sign-ins Codex and Claude saved before they reached servers through F5 are not carried over,
        so a server that needed one asks once more here.
      </p>
      {authStatus.error ? (
        <p className="text-destructive">
          {readErrorMessage(authStatus.error, "Failed to load sign-in state.")}
        </p>
      ) : server ? (
        <ul>
          <SignInRow
            key={`${projectId ?? "common"}:${server.name}`}
            server={server}
            projectId={projectId}
            statusUpdatedAt={authStatus.dataUpdatedAt}
          />
        </ul>
      ) : authStatus.data ? (
        <p className="text-muted-foreground">Sign-in applies to enabled HTTP and SSE servers.</p>
      ) : null}
    </section>
  );
}
