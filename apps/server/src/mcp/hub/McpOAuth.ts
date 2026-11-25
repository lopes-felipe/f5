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
import type { McpServerDefinition } from "@t3tools/contracts";
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

export function mcpOAuthKey(serverUrl: string, clientId: string | undefined): string {
  const digest = createHash("sha256")
    .update(`${serverUrl}\u0000${clientId ?? ""}`)
    .digest("hex");
  return `mcp-oauth-${digest.slice(0, 40)}`;
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
      const bytes = await Effect.runPromise(store.get(key).pipe(Effect.orElseSucceed(() => null)));
      let record: McpOAuthRecord | null = null;
      if (bytes) {
        try {
          record = JSON.parse(new TextDecoder().decode(bytes)) as McpOAuthRecord;
        } catch {
          record = null;
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
  readonly saveClientInformation?: (information: OAuthClientInformationMixed) => Promise<void>;
  /** Present only with a configured `oauthResource`; otherwise the SDK's own check applies. */
  readonly validateResourceURL?: () => Promise<URL | undefined>;

  constructor(private readonly options: McpOAuthProviderOptions) {
    this.key = mcpOAuthKey(options.serverUrl, options.definition.oauthClientId);
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

  private async update(change: (record: McpOAuthRecord) => McpOAuthRecord): Promise<void> {
    await this.options.storage.write(this.key, change(await this.record()));
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
    return (await this.options.storage.read(this.key))?.tokens;
  }

  async saveTokens(tokens: OAuthTokens): Promise<void> {
    await this.update((record) => ({ ...record, tokens, tokensSavedAt: Date.now() }));
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
    await this.update((record) => {
      const { tokens: _tokens, tokensSavedAt: _savedAt, ...rest } = record;
      if (scope === "tokens") return rest;
      const { clientInformation: _client, ...withoutClient } = rest;
      return withoutClient;
    });
  }
}
