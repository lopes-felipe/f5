/**
 * OAuth for remote MCP servers the hub connects to. Tokens and client
 * registrations are shared by every project and provider in the profile,
 * keyed by server URL and client ID, and live in the secret store, which
 * encrypts `mcp-oauth-*` values at rest.
 *
 * @module mcp/hub/McpOAuth
 */
import { createHash, randomBytes } from "node:crypto";

import {
  type OAuthClientProvider,
  UnauthorizedError,
} from "@modelcontextprotocol/sdk/client/auth.js";
import type {
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import type { FetchLike } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { McpServerDefinition } from "@t3tools/contracts";
import { mcpRemoteHeaders } from "@t3tools/shared/mcpTranslation";
import { Effect } from "effect";

import type { ServerSecretStoreShape } from "../../auth/Services/ServerSecretStore.ts";

/** Redirect used for refreshes when no sign-in has recorded one; never visited. */
const PLACEHOLDER_REDIRECT = "http://127.0.0.1/callback";

export interface McpOAuthRecord {
  readonly serverUrl: string;
  readonly clientId?: string;
  /** Stored exactly as the SDK saved it. */
  readonly clientInformation?: OAuthClientInformationMixed;
  readonly tokens?: OAuthTokens;
  readonly tokensSavedAt?: number;
  /** The redirect the registration and last sign-in used. */
  readonly redirectUrl?: string;
}

export interface McpOAuthStorage {
  readonly read: (key: string) => Promise<McpOAuthRecord | undefined>;
  readonly write: (key: string, record: McpOAuthRecord) => Promise<void>;
  readonly remove: (key: string) => Promise<void>;
}

/**
 * Writes to one OAuth record run one at a time, so concurrent refreshes and
 * sign-in steps never lose each other's changes.
 */
const recordLocks = new Map<string, Promise<unknown>>();
function withRecordLock<A>(key: string, run: () => Promise<A>): Promise<A> {
  const previous = recordLocks.get(key) ?? Promise.resolve();
  const next = previous.then(run, run);
  const settled = next.then(
    () => undefined,
    () => undefined,
  );
  recordLocks.set(key, settled);
  void settled.then(() => {
    if (recordLocks.get(key) === settled) recordLocks.delete(key);
  });
  return next;
}

/** Changes a stored record under its lock; a missing record stays missing. */
export function updateMcpOAuthRecord(
  storage: McpOAuthStorage,
  key: string,
  change: (record: McpOAuthRecord) => McpOAuthRecord,
): Promise<void> {
  return withRecordLock(key, async () => {
    const record = await storage.read(key);
    if (record) await storage.write(key, change(record));
  });
}

/**
 * Sign-out bumps a record's epoch; token writes that started before it are
 * rejected, so an in-flight exchange or refresh cannot sign the user back in.
 */
const recordEpochs = new Map<string, number>();
export function bumpMcpOAuthEpoch(key: string): void {
  recordEpochs.set(key, (recordEpochs.get(key) ?? 0) + 1);
}
function recordEpoch(key: string): number {
  return recordEpochs.get(key) ?? 0;
}

interface SharedResponse {
  readonly status: number;
  readonly statusText: string;
  readonly headers: Array<[string, string]>;
  readonly body: string;
}
/** Successful refresh responses stay shareable this long after they arrive. */
const REFRESH_SHARE_MS = 30_000;
const sharedRefreshes = new Map<string, Promise<SharedResponse>>();

function readRefreshToken(body: unknown): string | undefined {
  const params =
    body instanceof URLSearchParams
      ? body
      : typeof body === "string"
        ? new URLSearchParams(body)
        : undefined;
  return params?.get("grant_type") === "refresh_token"
    ? (params.get("refresh_token") ?? undefined)
    : undefined;
}

/**
 * The fetch for one remote server's connection and its OAuth calls.
 *
 * - The server's own headers (API keys, cookies) go only to the server's origin,
 *   never to a metadata, registration or token endpoint on another host.
 * - Connections that refresh the same token at once share one token request:
 *   servers rotate refresh tokens, so a second request with the old token would
 *   fail and could revoke the whole grant.
 */
export function mcpOAuthFetch(
  serverUrl: string,
  resourceHeaderNames: ReadonlyArray<string>,
  base: FetchLike = fetch,
): FetchLike {
  const origin = new URL(serverUrl).origin;
  const names = resourceHeaderNames.map((name) => name.toLowerCase());
  return async (url, init) => {
    const target = new URL(url.toString());
    let request = init;
    if (target.origin !== origin && names.length > 0 && init?.headers) {
      const headers = new Headers(init.headers);
      for (const name of names) headers.delete(name);
      request = { ...init, headers };
    }
    const refreshToken = readRefreshToken(request?.body);
    if (refreshToken === undefined) return base(url, request);
    const shareKey = `${target.href}\u0000${refreshToken}`;
    let shared = sharedRefreshes.get(shareKey);
    if (!shared) {
      const pending = (async (): Promise<SharedResponse> => {
        const response = await base(url, request);
        return {
          status: response.status,
          statusText: response.statusText,
          headers: [...response.headers.entries()],
          body: await response.text(),
        };
      })();
      shared = pending;
      sharedRefreshes.set(shareKey, pending);
      const forget = () => {
        if (sharedRefreshes.get(shareKey) === pending) sharedRefreshes.delete(shareKey);
      };
      // Only a success is worth sharing after it arrives; a failure may be retried at once.
      pending.then((result) => {
        if (result.status >= 200 && result.status < 300)
          setTimeout(forget, REFRESH_SHARE_MS).unref?.();
        else forget();
      }, forget);
    }
    const result = await shared;
    return new Response(result.body, {
      status: result.status,
      statusText: result.statusText,
      headers: result.headers,
    });
  };
}

export function mcpOAuthKey(serverUrl: string, clientId: string | undefined): string {
  const digest = createHash("sha256")
    .update(`${serverUrl}\u0000${clientId ?? ""}`)
    .digest("hex");
  return `mcp-oauth-${digest.slice(0, 40)}`;
}

/**
 * Whether a remote server authenticates with its own `Authorization` (a literal
 * header or a bearer variable that resolves). Such servers never use F5 sign-in.
 */
export function mcpUsesStaticAuthorization(
  definition: McpServerDefinition,
  environment: NodeJS.ProcessEnv,
): boolean {
  if (definition.type === "stdio") return false;
  const headers = mcpRemoteHeaders(definition, environment);
  return Object.keys(headers ?? {}).some((name) => name.toLowerCase() === "authorization");
}

/** The URL OAuth is keyed and discovered by; only remote servers sign in. */
export function mcpOAuthServerUrl(definition: McpServerDefinition): string | undefined {
  return definition.type === "stdio" ? undefined : definition.url;
}

export function mcpOAuthExpiresAt(record: McpOAuthRecord | undefined): number | undefined {
  const expiresIn = record?.tokens?.expires_in;
  return record?.tokensSavedAt !== undefined && typeof expiresIn === "number"
    ? record.tokensSavedAt + expiresIn * 1000
    : undefined;
}

/** Secret-store backed storage with a read cache, so tokens are not decrypted per request. */
export function secretStoreOAuthStorage(store: ServerSecretStoreShape): McpOAuthStorage {
  const cache = new Map<string, McpOAuthRecord | null>();
  return {
    read: async (key) => {
      if (cache.has(key)) return cache.get(key) ?? undefined;
      // A read that fails (for example a value that cannot be decrypted) is not cached,
      // so a later read can succeed and a sign-in does not assume the record is empty.
      const bytes = await Effect.runPromise(
        store.get(key).pipe(Effect.orElseSucceed(() => undefined)),
      );
      if (bytes === undefined) return undefined;
      let record: McpOAuthRecord | null = null;
      if (bytes) {
        try {
          record = JSON.parse(new TextDecoder().decode(bytes)) as McpOAuthRecord;
        } catch {
          return undefined;
        }
      }
      cache.set(key, record);
      return record ?? undefined;
    },
    write: async (key, record) => {
      await Effect.runPromise(store.set(key, new TextEncoder().encode(JSON.stringify(record))));
      cache.set(key, record);
    },
    remove: async (key) => {
      await Effect.runPromise(store.remove(key));
      cache.set(key, null);
    },
  };
}

export function memoryOAuthStorage(): McpOAuthStorage & {
  readonly records: Map<string, McpOAuthRecord>;
} {
  const records = new Map<string, McpOAuthRecord>();
  return {
    records,
    read: async (key) => records.get(key),
    write: async (key, record) => {
      records.set(key, record);
    },
    remove: async (key) => {
      records.delete(key);
    },
  };
}

export interface McpOAuthProviderOptions {
  readonly storage: McpOAuthStorage;
  readonly serverUrl: string;
  readonly definition: McpServerDefinition;
  /**
   * Interactive providers belong to one sign-in attempt: they may register a client,
   * and they report the authorization URL instead of opening a browser.
   */
  readonly interactive?: {
    readonly redirectUrl: string;
    readonly state: string;
    readonly onAuthorizationUrl: (url: URL) => void;
  };
}

/**
 * The SDK's OAuth client for one server. The hub's connections use the
 * non-interactive form, which can refresh tokens but never registers a client
 * or starts a sign-in; a server without usable tokens then reports Needs sign-in.
 */
export class McpOAuthProvider implements OAuthClientProvider {
  readonly key: string;
  private verifier: string | undefined;
  /** The refresh token this provider last read, and the epoch it read it in. */
  private readRefreshToken: string | undefined;
  private readEpoch: number;
  readonly saveClientInformation?: (information: OAuthClientInformationMixed) => Promise<void>;
  /** Present only with a configured `oauthResource`; otherwise the SDK's own check applies. */
  readonly validateResourceURL?: () => Promise<URL | undefined>;

  constructor(private readonly options: McpOAuthProviderOptions) {
    this.key = mcpOAuthKey(options.serverUrl, options.definition.oauthClientId);
    this.readEpoch = recordEpoch(this.key);
    const resource = options.definition.oauthResource;
    if (resource) this.validateResourceURL = async () => new URL(resource);
    // Without this method the SDK refuses dynamic registration, which keeps background
    // connections from registering clients with a redirect nobody listens on.
    if (options.interactive)
      this.saveClientInformation = async (information) => {
        await this.update((record) => ({
          ...record,
          clientInformation: information,
          redirectUrl: options.interactive!.redirectUrl,
        }));
      };
  }

  private async record(): Promise<McpOAuthRecord> {
    return (
      (await this.options.storage.read(this.key)) ?? {
        serverUrl: this.options.serverUrl,
        ...(this.options.definition.oauthClientId
          ? { clientId: this.options.definition.oauthClientId }
          : {}),
      }
    );
  }

  private update(change: (record: McpOAuthRecord) => McpOAuthRecord): Promise<void> {
    return withRecordLock(this.key, async () => {
      await this.options.storage.write(this.key, change(await this.record()));
    });
  }

  /**
   * Whether a failed connection may still recover without the user: the last
   * read had a refresh token that has not been invalidated since.
   */
  get mayRefresh(): boolean {
    return this.readRefreshToken !== undefined && this.readEpoch === recordEpoch(this.key);
  }

  get redirectUrl(): string {
    return this.options.interactive?.redirectUrl ?? this.cachedRedirect ?? PLACEHOLDER_REDIRECT;
  }

  /** Loaded before a background connection so refreshes reuse the registered redirect. */
  private cachedRedirect: string | undefined;
  async prime(): Promise<void> {
    this.cachedRedirect = (await this.options.storage.read(this.key))?.redirectUrl;
  }

  get clientMetadata(): OAuthClientMetadata {
    const scopes = this.options.definition.scopes;
    return {
      client_name: "F5",
      redirect_uris: [this.redirectUrl],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
      ...(scopes?.length ? { scope: scopes.join(" ") } : {}),
    };
  }

  state(): string {
    return this.options.interactive?.state ?? randomBytes(16).toString("base64url");
  }

  async clientInformation(): Promise<OAuthClientInformationMixed | undefined> {
    const configured = this.options.definition.oauthClientId;
    if (configured) return { client_id: configured };
    const information = (await this.record()).clientInformation;
    // A background connection to a server nobody signed in to stops here, before the
    // SDK would try (and refuse) dynamic registration with an unrelated error.
    if (!information && !this.options.interactive)
      throw new UnauthorizedError("Sign in to this server from MCP settings.");
    return information;
  }

  async tokens(): Promise<OAuthTokens | undefined> {
    // Each auth run starts here; token writes from this run must not outlive a sign-out.
    if (!this.options.interactive) this.readEpoch = recordEpoch(this.key);
    const tokens = (await this.options.storage.read(this.key))?.tokens;
    this.readRefreshToken = tokens?.refresh_token;
    return tokens;
  }

  async saveTokens(tokens: OAuthTokens): Promise<void> {
    const epoch = this.readEpoch;
    await withRecordLock(this.key, async () => {
      if (epoch !== recordEpoch(this.key))
        throw new UnauthorizedError("Signed out of this server while sign-in was finishing.");
      const record = await this.record();
      await this.options.storage.write(this.key, { ...record, tokens, tokensSavedAt: Date.now() });
    });
    this.readRefreshToken = tokens.refresh_token;
  }

  redirectToAuthorization(authorizationUrl: URL): void {
    // F5 never opens a browser on its own; the sign-in attempt hands the URL to the user.
    this.options.interactive?.onAuthorizationUrl(authorizationUrl);
  }

  saveCodeVerifier(codeVerifier: string): void {
    this.verifier = codeVerifier;
  }

  codeVerifier(): string {
    if (!this.verifier) throw new Error("No sign-in is in progress for this server.");
    return this.verifier;
  }

  async invalidateCredentials(scope: "all" | "client" | "tokens" | "verifier" | "discovery") {
    if (scope === "verifier") {
      this.verifier = undefined;
      return;
    }
    if (scope === "discovery") return;
    const failedRefreshToken = this.readRefreshToken;
    this.readRefreshToken = undefined;
    await this.update((record) => {
      // Another connection may have rotated the tokens since this one read them;
      // its fresh tokens must survive this connection's rejected refresh.
      if (scope === "tokens" && record.tokens?.refresh_token !== failedRefreshToken) return record;
      const { tokens: _tokens, tokensSavedAt: _savedAt, ...rest } = record;
      if (scope === "tokens") return rest;
      const { clientInformation: _client, ...withoutClient } = rest;
      return withoutClient;
    });
  }
}
