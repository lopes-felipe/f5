/**
 * Sign-in for remote MCP servers the hub connects to. Works per server from
 * any settings scope with no conversation running. Each attempt listens on a
 * loopback callback (the server's `oauthCallbackPort`, or an ephemeral port)
 * and also accepts the redirected URL pasted by the user, for browsers on
 * another machine. F5 never opens the browser itself.
 *
 * @module mcp/hub/McpHubAuth
 */
import { randomBytes } from "node:crypto";
import * as Http from "node:http";
import type { AddressInfo } from "node:net";

import {
  auth,
  extractResourceMetadataUrl,
  type OAuthClientProvider,
} from "@modelcontextprotocol/sdk/client/auth.js";
import { LATEST_PROTOCOL_VERSION } from "@modelcontextprotocol/sdk/types.js";
import type { FetchLike } from "@modelcontextprotocol/sdk/shared/transport.js";
import type {
  McpCompleteHubSignInResult,
  McpGetHubAuthStatusResult,
  McpHubSignInAttempt,
  McpProjectServersConfig,
  McpServerDefinition,
  McpStartHubSignInResult,
  McpStatusUpdatedPayload,
  ProjectId,
} from "@t3tools/contracts";
import {
  describeMcpInterpolationSkip,
  interpolateMcpServers,
} from "@t3tools/shared/mcpInterpolation";
import { Data, Effect, Layer, Option, ServiceMap } from "effect";

import { CodexMcpEventBus } from "../../codex/CodexMcpEventBus.ts";
import { ProjectMcpConfigService } from "../ProjectMcpConfigService.ts";
import { McpHub, type McpHubShape } from "./McpHub.ts";
import {
  bumpMcpOAuthEpoch,
  McpOAuthProvider,
  mcpOAuthExpiresAt,
  mcpOAuthKey,
  mcpOAuthServerUrl,
  mcpUsesStaticAuthorization,
  updateMcpOAuthRecord,
  type McpOAuthStorage,
} from "./McpOAuth.ts";

export const SIGN_IN_ATTEMPT_TTL_MS = 10 * 60 * 1000;
const CALLBACK_DRAIN_MS = 5_000;

export class McpHubAuthError extends Data.TaggedError("McpHubAuthError")<{
  readonly message: string;
}> {}

interface Attempt {
  readonly id: string;
  readonly serverName: string;
  readonly key: string;
  readonly serverUrl: string;
  readonly state: string;
  readonly provider: OAuthClientProvider;
  readonly info: McpHubSignInAttempt;
  /** Bound to the attempt's deadline, so a stalled endpoint cannot outlive it. */
  readonly fetchFn: FetchLike;
  readonly resourceMetadataUrl: URL | undefined;
  readonly close: () => void;
  completing?: Promise<McpCompleteHubSignInResult>;
}

export interface McpHubAuthManagerOptions {
  readonly storage: McpOAuthStorage | undefined;
  readonly hub:
    | (Pick<McpHubShape, "reconnectOAuth"> & Partial<Pick<McpHubShape, "accountEnvironment">>)
    | undefined;
  /** The effective servers for a project, or the common servers without one. */
  readonly readServers: (projectId?: ProjectId) => Promise<McpProjectServersConfig>;
  /** Used when no live session gives the server's account environment. */
  readonly environment?: NodeJS.ProcessEnv;
  readonly publish?: (payload: McpStatusUpdatedPayload) => void;
  /** Test seam for the authorization server's HTTP calls. */
  readonly fetchFn?: FetchLike;
  readonly now?: () => number;
}

const fail = (message: string) => new McpHubAuthError({ message });

function callbackPage(title: string, detail: string): string {
  const escape = (text: string) => text.replace(/[&<>"']/gu, (char) => `&#${char.charCodeAt(0)};`);
  return `<!doctype html><meta charset="utf-8"><title>${escape(title)}</title><body style="font-family:system-ui;margin:3rem"><h1 style="font-size:1.25rem">${escape(title)}</h1><p>${escape(detail)}</p></body>`;
}

/** The port of a loopback redirect URL, which F5 can listen on itself. */
function loopbackPort(url: string | undefined): number | undefined {
  if (!url) return undefined;
  try {
    const parsed = new URL(url);
    if (!["127.0.0.1", "localhost", "[::1]"].includes(parsed.hostname) || !parsed.port)
      return undefined;
    return Number(parsed.port);
  } catch {
    return undefined;
  }
}

export class McpHubAuthManager {
  private readonly attempts = new Map<string, Attempt>();
  /** Cleanup for attempts that are still discovering, before they are registered. */
  private readonly starting = new Map<string, () => void>();
  private readonly now: () => number;

  constructor(private readonly options: McpHubAuthManagerOptions) {
    this.now = options.now ?? Date.now;
  }

  private storage(): McpOAuthStorage {
    if (!this.options.storage) throw fail("Sign-in is unavailable: F5 has no secret store here.");
    return this.options.storage;
  }

  /** The environment `${env:…}` resolves against, the same one the server's sessions use. */
  private environmentFor(serverName: string, projectId?: ProjectId): NodeJS.ProcessEnv {
    return (
      this.options.hub?.accountEnvironment?.(serverName, projectId) ??
      this.options.environment ??
      process.env
    );
  }

  private resolveOne(
    serverName: string,
    configured: McpServerDefinition,
    projectId?: ProjectId,
  ):
    | { definition: McpServerDefinition; serverUrl: string; environment: NodeJS.ProcessEnv }
    | { problem: string } {
    const environment = this.environmentFor(serverName, projectId);
    const resolved = interpolateMcpServers({ [serverName]: configured }, environment);
    const skip = resolved.skipped[0];
    if (skip) return { problem: `MCP server ${serverName} ${describeMcpInterpolationSkip(skip)}.` };
    const definition = resolved.servers[serverName] ?? configured;
    const serverUrl = mcpOAuthServerUrl(definition);
    if (!serverUrl) return { problem: `MCP server ${serverName} runs locally and has no sign-in.` };
    if (mcpUsesStaticAuthorization(definition, environment))
      return {
        problem: `MCP server ${serverName} uses its configured Authorization and has no sign-in.`,
      };
    return { definition, serverUrl, environment };
  }

  private async resolveServer(
    serverName: string,
    projectId?: ProjectId,
  ): Promise<{ definition: McpServerDefinition; serverUrl: string }> {
    const servers = await this.options.readServers(projectId);
    const configured = servers[serverName];
    if (!configured) throw fail(`MCP server ${serverName} is not configured here.`);
    const resolved = this.resolveOne(serverName, configured, projectId);
    if ("problem" in resolved) throw fail(resolved.problem);
    return resolved;
  }

  async status(projectId?: ProjectId): Promise<McpGetHubAuthStatusResult> {
    const servers = await this.options.readServers(projectId);
    const result: Array<McpGetHubAuthStatusResult["servers"][number]> = [];
    for (const [name, configured] of Object.entries(servers)) {
      if (configured.enabled === false) continue;
      // Local servers, servers with their own Authorization and servers whose
      // variables do not resolve have nothing to sign in to.
      const resolved = this.resolveOne(name, configured, projectId);
      if ("problem" in resolved) continue;
      const { definition, serverUrl } = resolved;
      const key = mcpOAuthKey(serverUrl, definition.oauthClientId);
      const record = this.options.storage ? await this.options.storage.read(key) : undefined;
      const expiresAt = mcpOAuthExpiresAt(record);
      const pending = [...this.attempts.values()].find((attempt) => attempt.key === key);
      result.push({
        name,
        signedIn: Boolean(record?.tokens?.access_token),
        refreshable: Boolean(record?.tokens?.refresh_token),
        ...(expiresAt !== undefined ? { expiresAt: new Date(expiresAt).toISOString() } : {}),
        ...(pending ? { pending: pending.info } : {}),
      });
    }
    return { servers: result.toSorted((a, b) => a.name.localeCompare(b.name)) };
  }

  async startSignIn(serverName: string, projectId?: ProjectId): Promise<McpStartHubSignInResult> {
    const storage = this.storage();
    const { definition, serverUrl } = await this.resolveServer(serverName, projectId);
    const key = mcpOAuthKey(serverUrl, definition.oauthClientId);
    // One attempt per OAuth record: a new start replaces an abandoned one.
    for (const attempt of this.attempts.values()) if (attempt.key === key) this.cancel(attempt.id);

    const id = randomBytes(12).toString("base64url");
    const state = randomBytes(24).toString("base64url");
    const record = await storage.read(key);
    const configuredRedirect = definition.oauthCallbackUrl;
    // A loopback callback URL names the port to listen on. Otherwise reuse the port
    // the stored registration was made for, so servers that match redirect URIs
    // exactly keep accepting it; fall back to any free port.
    const fixedPort = definition.oauthCallbackPort ?? loopbackPort(configuredRedirect);
    const callbackPath =
      configuredRedirect && loopbackPort(configuredRedirect) !== undefined
        ? new URL(configuredRedirect).pathname
        : "/callback";
    const reusePort = fixedPort === undefined ? loopbackPort(record?.redirectUrl) : undefined;
    const listener =
      reusePort !== undefined
        ? await this.listen(id, reusePort, callbackPath).catch(() =>
            this.listen(id, undefined, callbackPath),
          )
        : await this.listen(id, fixedPort, callbackPath);
    const redirectUrl = configuredRedirect ?? `http://127.0.0.1:${listener.port}/callback`;

    // One deadline covers discovery, registration, the browser and the code exchange,
    // and the listener is tracked from the moment it opens.
    const deadline = new AbortController();
    let ended = false;
    const end = (reason = "This sign-in attempt was cancelled.") => {
      if (ended) return;
      ended = true;
      clearTimeout(timer);
      deadline.abort(fail(reason));
      listener.close();
      this.starting.delete(id);
      this.attempts.delete(id);
    };
    const timer = setTimeout(
      () => end("This sign-in attempt timed out. Start sign-in again."),
      SIGN_IN_ATTEMPT_TTL_MS,
    );
    timer.unref?.();
    this.starting.set(id, end);
    const base = this.options.fetchFn ?? fetch;
    const fetchFn: FetchLike = (url, init) =>
      base(url, {
        ...init,
        signal: init?.signal ? AbortSignal.any([init.signal, deadline.signal]) : deadline.signal,
      });

    let authorizationUrl: URL | undefined;
    let outcome: Awaited<ReturnType<typeof auth>>;
    let resourceMetadataUrl: URL | undefined;
    let provider: McpOAuthProvider;
    try {
      // A registration made for another redirect is useless to servers that match it
      // exactly; register again unless the client ID is configured.
      if (
        !definition.oauthClientId &&
        record?.clientInformation &&
        record.redirectUrl !== redirectUrl
      )
        await updateMcpOAuthRecord(storage, key, (current) => {
          const { clientInformation: _client, redirectUrl: _redirect, ...rest } = current;
          return rest;
        });
      provider = new McpOAuthProvider({
        storage,
        serverUrl,
        definition,
        interactive: {
          redirectUrl,
          state,
          onAuthorizationUrl: (url) => {
            authorizationUrl = url;
          },
        },
      });
      resourceMetadataUrl = await this.probeResourceMetadata(serverUrl, fetchFn);
      outcome = await auth(provider, {
        serverUrl,
        ...(definition.scopes?.length ? { scope: definition.scopes.join(" ") } : {}),
        ...(resourceMetadataUrl ? { resourceMetadataUrl } : {}),
        fetchFn,
      });
    } catch (error) {
      end();
      throw fail(`Could not start sign-in for ${serverName}: ${readMessage(error)}`);
    }
    if (ended)
      throw fail("This sign-in attempt ended before the browser step. Start sign-in again.");
    if (outcome === "AUTHORIZED" || !authorizationUrl) {
      end();
      await this.signedIn(serverName, key);
      return { status: "signed-in" };
    }
    this.starting.delete(id);
    const info: McpHubSignInAttempt = {
      attemptId: id,
      authorizationUrl: authorizationUrl.toString(),
      redirectUrl,
      startedAt: new Date(this.now()).toISOString(),
    };
    this.attempts.set(id, {
      id,
      serverName,
      key,
      serverUrl,
      state,
      provider,
      info,
      fetchFn,
      resourceMetadataUrl,
      close: () => end(),
    });
    return { status: "pending", attempt: info };
  }

  /**
   * The protected-resource metadata URL from the server's 401 challenge. Servers may
   * advertise it only there, and background connections already honour it.
   */
  private async probeResourceMetadata(
    serverUrl: string,
    fetchFn: FetchLike,
  ): Promise<URL | undefined> {
    try {
      const response = await fetchFn(serverUrl, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 0,
          method: "initialize",
          params: {
            protocolVersion: LATEST_PROTOCOL_VERSION,
            capabilities: {},
            clientInfo: { name: "F5", version: "1" },
          },
        }),
      });
      await response.body?.cancel().catch(() => undefined);
      return response.status === 401 ? extractResourceMetadataUrl(response) : undefined;
    } catch {
      return undefined;
    }
  }

  /** Finishes an attempt from the redirected URL, whether the browser or the user brought it. */
  async completeSignIn(
    attemptId: string,
    redirectedUrl: string,
  ): Promise<McpCompleteHubSignInResult> {
    const attempt = this.attempts.get(attemptId);
    if (!attempt) throw fail("This sign-in attempt has ended. Start sign-in again.");
    if (attempt.completing) return attempt.completing;
    let url: URL;
    try {
      url = new URL(redirectedUrl);
    } catch {
      throw fail("Paste the full address the browser was sent to after you authorized F5.");
    }
    const params = url.searchParams;
    if (params.get("state") !== attempt.state)
      throw fail("This address belongs to a different sign-in attempt.");
    const refused = params.get("error");
    if (refused) {
      this.cancel(attempt.id);
      const description = params.get("error_description");
      throw fail(
        `The server refused sign-in: ${description ? `${refused} (${description})` : refused}.`,
      );
    }
    const code = params.get("code");
    if (!code) throw fail("The address has no authorization code.");
    attempt.completing = (async () => {
      try {
        const outcome = await auth(attempt.provider, {
          serverUrl: attempt.serverUrl,
          authorizationCode: code,
          ...(attempt.resourceMetadataUrl
            ? { resourceMetadataUrl: attempt.resourceMetadataUrl }
            : {}),
          fetchFn: attempt.fetchFn,
        });
        if (outcome !== "AUTHORIZED") throw new Error("The server did not issue tokens.");
      } catch (error) {
        this.cancel(attempt.id);
        throw fail(`Sign-in for ${attempt.serverName} failed: ${readMessage(error)}`);
      }
      this.cancel(attempt.id);
      const reconnected = await this.signedIn(attempt.serverName, attempt.key);
      return { status: "signed-in" as const, serverName: attempt.serverName, reconnected };
    })();
    return attempt.completing;
  }

  async signOut(serverName: string, projectId?: ProjectId): Promise<{ signedOut: boolean }> {
    const storage = this.storage();
    const { definition, serverUrl } = await this.resolveServer(serverName, projectId);
    const key = mcpOAuthKey(serverUrl, definition.oauthClientId);
    for (const attempt of this.attempts.values()) if (attempt.key === key) this.cancel(attempt.id);
    // Token writes already in flight (a code exchange or a refresh) are rejected from here on.
    bumpMcpOAuthEpoch(key);
    let hadTokens = false;
    // The client registration is kept, so signing in again skips registration.
    await updateMcpOAuthRecord(storage, key, (record) => {
      hadTokens = Boolean(record.tokens);
      const { tokens: _tokens, tokensSavedAt: _savedAt, ...rest } = record;
      return rest;
    });
    if (!hadTokens) return { signedOut: false };
    await this.options.hub?.reconnectOAuth(key);
    this.options.publish?.({ scope: "common", reason: "hub", serverName });
    return { signedOut: true };
  }

  cancel(attemptId: string): void {
    const attempt = this.attempts.get(attemptId);
    if (!attempt) return;
    this.attempts.delete(attemptId);
    attempt.close();
  }

  close(): void {
    for (const id of this.attempts.keys()) this.cancel(id);
    for (const end of this.starting.values()) end();
  }

  private async signedIn(serverName: string, key: string): Promise<number> {
    const reconnected = (await this.options.hub?.reconnectOAuth(key)) ?? 0;
    this.options.publish?.({ scope: "common", reason: "hub", serverName });
    return reconnected;
  }

  /** A loopback listener for one attempt; it answers only the redirect for that attempt. */
  private listen(attemptId: string, port: number | undefined, callbackPath: string) {
    return new Promise<{ port: number; close: () => void }>((resolve, reject) => {
      const server = Http.createServer((request, response) => {
        let target: URL;
        try {
          target = new URL(request.url ?? "/", "http://127.0.0.1");
        } catch {
          response.writeHead(400).end();
          return;
        }
        if (
          request.method !== "GET" ||
          target.pathname !== callbackPath ||
          !target.searchParams.has("state")
        ) {
          response.writeHead(404).end();
          return;
        }
        this.completeSignIn(attemptId, target.toString()).then(
          (result) => {
            response.writeHead(200, {
              "content-type": "text/html; charset=utf-8",
              connection: "close",
            });
            response.end(
              callbackPage(
                `Signed in to ${result.serverName}`,
                "You can close this tab and return to F5.",
              ),
            );
          },
          (error: unknown) => {
            response.writeHead(400, {
              "content-type": "text/html; charset=utf-8",
              connection: "close",
            });
            response.end(callbackPage("Sign-in did not finish", readMessage(error)));
          },
        );
      });
      server.once("error", (error: NodeJS.ErrnoException) =>
        reject(
          fail(
            error.code === "EADDRINUSE"
              ? `The OAuth callback port ${port} is in use. Free it or choose another port for this server.`
              : `Could not listen for the sign-in callback: ${error.message}`,
          ),
        ),
      );
      server.listen(port ?? 0, "127.0.0.1", () => {
        const address = server.address() as AddressInfo;
        resolve({
          port: address.port,
          // The attempt can end while the listener is still answering its own callback,
          // so stop accepting now and let in-flight responses finish before dropping sockets.
          close: () => {
            server.close();
            server.closeIdleConnections();
            setTimeout(() => server.closeAllConnections(), CALLBACK_DRAIN_MS).unref();
          },
        });
      });
    });
  }
}

function readMessage(error: unknown): string {
  if (error instanceof McpHubAuthError) return error.message;
  return error instanceof Error ? error.message : String(error);
}

export interface McpHubAuthShape {
  readonly status: (
    projectId?: ProjectId,
  ) => Effect.Effect<McpGetHubAuthStatusResult, McpHubAuthError>;
  readonly startSignIn: (input: {
    readonly serverName: string;
    readonly projectId?: ProjectId | undefined;
  }) => Effect.Effect<McpStartHubSignInResult, McpHubAuthError>;
  readonly completeSignIn: (input: {
    readonly attemptId: string;
    readonly redirectedUrl: string;
  }) => Effect.Effect<McpCompleteHubSignInResult, McpHubAuthError>;
  readonly signOut: (input: {
    readonly serverName: string;
    readonly projectId?: ProjectId | undefined;
  }) => Effect.Effect<{ readonly signedOut: boolean }, McpHubAuthError>;
}

export class McpHubAuth extends ServiceMap.Service<McpHubAuth, McpHubAuthShape>()(
  "t3/mcp/hub/McpHubAuth",
) {}

const toEffect = <A>(run: () => Promise<A>) =>
  Effect.tryPromise({
    try: run,
    catch: (error) => (error instanceof McpHubAuthError ? error : fail(readMessage(error))),
  });

export const McpHubAuthLive = Layer.effect(
  McpHubAuth,
  Effect.gen(function* () {
    const hub = Option.getOrUndefined(yield* Effect.serviceOption(McpHub));
    const bus = Option.getOrUndefined(yield* Effect.serviceOption(CodexMcpEventBus));
    const config = yield* ProjectMcpConfigService;
    const manager = new McpHubAuthManager({
      storage: hub?.oauthStorage,
      hub,
      readServers: (projectId) =>
        Effect.runPromise(
          projectId
            ? config
                .readEffectiveRuntimeConfig(projectId)
                .pipe(Effect.map((value) => value.servers))
            : config.readCommonConfig().pipe(Effect.map((value) => value.servers)),
        ),
      ...(bus
        ? { publish: (payload) => void Effect.runFork(bus.publishStatusUpdated(payload)) }
        : {}),
    });
    yield* Effect.addFinalizer(() => Effect.sync(() => manager.close()));
    return {
      status: (projectId) => toEffect(() => manager.status(projectId)),
      startSignIn: (input) =>
        toEffect(() => manager.startSignIn(input.serverName, input.projectId)),
      completeSignIn: (input) =>
        toEffect(() => manager.completeSignIn(input.attemptId, input.redirectedUrl)),
      signOut: (input) => toEffect(() => manager.signOut(input.serverName, input.projectId)),
    } satisfies McpHubAuthShape;
  }),
);
