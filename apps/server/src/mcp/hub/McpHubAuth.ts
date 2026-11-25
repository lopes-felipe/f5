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

import { auth, type OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
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
  McpOAuthProvider,
  mcpOAuthExpiresAt,
  mcpOAuthKey,
  mcpOAuthServerUrl,
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
  readonly close: () => void;
  completing?: Promise<McpCompleteHubSignInResult>;
}

export interface McpHubAuthManagerOptions {
  readonly storage: McpOAuthStorage | undefined;
  readonly hub: Pick<McpHubShape, "reconnectOAuth"> | undefined;
  /** The effective servers for a project, or the common servers without one. */
  readonly readServers: (projectId?: ProjectId) => Promise<McpProjectServersConfig>;
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

export class McpHubAuthManager {
  private readonly attempts = new Map<string, Attempt>();
  private readonly now: () => number;

  constructor(private readonly options: McpHubAuthManagerOptions) {
    this.now = options.now ?? Date.now;
  }

  private storage(): McpOAuthStorage {
    if (!this.options.storage) throw fail("Sign-in is unavailable: F5 has no secret store here.");
    return this.options.storage;
  }

  private async resolveServer(
    serverName: string,
    projectId?: ProjectId,
  ): Promise<{ definition: McpServerDefinition; serverUrl: string }> {
    const servers = await this.options.readServers(projectId);
    const configured = servers[serverName];
    if (!configured) throw fail(`MCP server ${serverName} is not configured here.`);
    const resolved = interpolateMcpServers(
      { [serverName]: configured },
      this.options.environment ?? process.env,
    );
    const skip = resolved.skipped[0];
    if (skip) throw fail(`MCP server ${serverName} ${describeMcpInterpolationSkip(skip)}.`);
    const definition = resolved.servers[serverName] ?? configured;
    const serverUrl = mcpOAuthServerUrl(definition);
    if (!serverUrl) throw fail(`MCP server ${serverName} runs locally and has no sign-in.`);
    return { definition, serverUrl };
  }

  async status(projectId?: ProjectId): Promise<McpGetHubAuthStatusResult> {
    const servers = await this.options.readServers(projectId);
    const resolved = interpolateMcpServers(servers, this.options.environment ?? process.env);
    const result: Array<McpGetHubAuthStatusResult["servers"][number]> = [];
    for (const [name, definition] of Object.entries(resolved.servers)) {
      const serverUrl = mcpOAuthServerUrl(definition);
      if (!serverUrl || definition.enabled === false) continue;
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
    const listener = await this.listen(id, definition.oauthCallbackPort);
    const redirectUrl = definition.oauthCallbackUrl ?? `http://127.0.0.1:${listener.port}/callback`;
    let authorizationUrl: URL | undefined;
    const provider = new McpOAuthProvider({
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
    let outcome: Awaited<ReturnType<typeof auth>>;
    try {
      outcome = await auth(provider, {
        serverUrl,
        ...(definition.scopes?.length ? { scope: definition.scopes.join(" ") } : {}),
        ...(this.options.fetchFn ? { fetchFn: this.options.fetchFn } : {}),
      });
    } catch (error) {
      listener.close();
      throw fail(`Could not start sign-in for ${serverName}: ${readMessage(error)}`);
    }
    if (outcome === "AUTHORIZED" || !authorizationUrl) {
      listener.close();
      await this.signedIn(serverName, key);
      return { status: "signed-in" };
    }
    const timer = setTimeout(() => this.cancel(id), SIGN_IN_ATTEMPT_TTL_MS);
    timer.unref?.();
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
      close: () => {
        clearTimeout(timer);
        listener.close();
      },
    });
    return { status: "pending", attempt: info };
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
          ...(this.options.fetchFn ? { fetchFn: this.options.fetchFn } : {}),
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
    const record = await storage.read(key);
    if (!record?.tokens) return { signedOut: false };
    // The client registration is kept, so signing in again skips registration.
    const { tokens: _tokens, tokensSavedAt: _savedAt, ...rest } = record;
    await storage.write(key, rest);
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
  }

  private async signedIn(serverName: string, key: string): Promise<number> {
    const reconnected = (await this.options.hub?.reconnectOAuth(key)) ?? 0;
    this.options.publish?.({ scope: "common", reason: "hub", serverName });
    return reconnected;
  }

  /** A loopback listener for one attempt; it answers only the redirect for that attempt. */
  private listen(attemptId: string, port: number | undefined) {
    return new Promise<{ port: number; close: () => void }>((resolve, reject) => {
      const server = Http.createServer((request, response) => {
        const target = new URL(request.url ?? "/", "http://127.0.0.1");
        if (request.method !== "GET" || !target.searchParams.has("state")) {
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
