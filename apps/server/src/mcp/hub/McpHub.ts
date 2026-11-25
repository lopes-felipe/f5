/**
 * F5's MCP hub: F5 is the MCP client for the servers configured in MCP
 * settings. Provider sessions get one loopback endpoint per server instead of
 * the server definition, so every provider that can speak HTTP MCP (or reach
 * it through `t3 mcp-session-stdio`) can use them.
 */
import { createHash, randomBytes } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type {
  McpConnectionScope,
  McpHubServerStatus,
  McpProjectServersConfig,
  McpServerDefinition,
  McpStatusUpdatedPayload,
  ProjectId,
  ProviderKind,
  ThreadId,
} from "@t3tools/contracts";
import { stableMcpServersJson } from "@t3tools/shared/mcpConfig";
import { filterEnabledMcpServers } from "@t3tools/shared/mcpTranslation";
import {
  describeMcpInterpolationSkip,
  interpolateMcpServers,
} from "@t3tools/shared/mcpInterpolation";
import { Effect, Layer, Option, ServiceMap } from "effect";

import { CodexMcpEventBus } from "../../codex/CodexMcpEventBus.ts";
import { ServerSecretStore } from "../../auth/Services/ServerSecretStore.ts";
import { readBearerToken } from "../jsonRpcHttp.ts";
import { PreviewMcpHttpServer, type PreviewMcpHttpServerShape } from "../PreviewMcpHttpServer.ts";
import { McpHubSlot } from "./McpHubEndpoint.ts";
import { McpHubUpstream } from "./McpHubUpstream.ts";
import {
  McpOAuthProvider,
  mcpOAuthServerUrl,
  secretStoreOAuthStorage,
  type McpOAuthStorage,
} from "./McpOAuth.ts";

export const MCP_HUB_PATH_PREFIX = "/mcp/user/";
const STATUS_DEBOUNCE_MS = 250;

/** One hub endpoint a provider session connects to. */
export interface McpHubEndpoint {
  /** The configured server name, so tools stay `mcp__<server>__<tool>`. */
  readonly serverName: string;
  readonly url: string;
  /** Per-endpoint credential; send it as `Authorization: Bearer <token>`. */
  readonly token: string;
  readonly transport: McpServerDefinition["type"];
  /** How long one tool call may run, so clients with their own timeout can match it. */
  readonly toolTimeoutMs: number;
}

export interface McpHubOmission {
  readonly serverName: string;
  readonly reason: string;
}

export interface McpHubAttachmentUpdate {
  /** Servers that now point at a new connection on their existing endpoint. */
  readonly changed: ReadonlyArray<string>;
  /** Servers whose endpoint now lists nothing; the provider keeps the endpoint. */
  readonly removed: ReadonlyArray<string>;
  /**
   * Servers with no endpoint in this session. Without `addEndpoints` the provider
   * must restart to get them; with it, `addedEndpoints` holds their new endpoints.
   */
  readonly added: ReadonlyArray<string>;
  /** Endpoints created for `added` servers when `addEndpoints` was requested. */
  readonly addedEndpoints: ReadonlyArray<McpHubEndpoint>;
  /** The endpoints that route to a saved server after this update. */
  readonly endpoints: ReadonlyArray<McpHubEndpoint>;
  readonly omitted: ReadonlyArray<McpHubOmission>;
}

export interface McpHubAttachment {
  /** Every endpoint of this attachment, including ones added by `update`. */
  readonly endpoints: ReadonlyArray<McpHubEndpoint>;
  readonly omitted: ReadonlyArray<McpHubOmission>;
  /** Credentials to scrub from logs and diagnostics. */
  readonly credentials: ReadonlyArray<string>;
  /**
   * Applies saved servers to this session's endpoints without restarting the
   * provider: changed servers move to a new connection, removed ones list nothing.
   * `addEndpoints` also creates endpoints for new servers, for providers that can
   * take new servers mid-session (Claude's `setMcpServers`).
   */
  readonly update: (
    servers: McpProjectServersConfig | null | undefined,
    options?: { readonly addEndpoints?: boolean },
  ) => McpHubAttachmentUpdate;
  /** Revokes the endpoints and releases their upstream connections. */
  readonly dispose: () => Promise<void>;
}

export interface McpHubAttachInput {
  readonly threadId: ThreadId;
  readonly projectId?: ProjectId | undefined;
  readonly provider: ProviderKind;
  /** Distinguishes provider accounts; shared connections are never shared across accounts. */
  readonly accountKey: string;
  /** Secret-resolved effective servers (ProviderStartOptions.mcpServers). */
  readonly servers: McpProjectServersConfig | null | undefined;
  /** The provider process environment: stdio children and `bearerTokenEnvVar` read it. */
  readonly environment: NodeJS.ProcessEnv;
  /** The conversation's working directory, used as the root and default stdio cwd. */
  readonly cwd: string;
  /** Names already taken by the provider or F5's own catalogs; those servers are skipped. */
  readonly reservedNames?: ReadonlySet<string> | undefined;
}

export interface McpHubShape {
  /** False when the loopback listener cannot mount hub endpoints (tests, some runtimes). */
  readonly available: boolean;
  /** Synchronous: endpoints are issued at once and upstreams connect on first use. */
  readonly attach: (input: McpHubAttachInput) => McpHubAttachment;
  readonly status: (projectId?: ProjectId) => ReadonlyArray<McpHubServerStatus>;
  readonly reconnect: (serverName: string, projectId?: ProjectId) => Promise<number>;
  readonly readStderrTail: (serverName: string, projectId?: ProjectId) => string | undefined;
  /** Where remote servers' OAuth tokens live; shared with sign-in so both see one cache. */
  readonly oauthStorage?: McpOAuthStorage | undefined;
  /** Reconnects every connection that signs in with this OAuth record (see `mcpOAuthKey`). */
  readonly reconnectOAuth: (oauthKey: string) => Promise<number>;
  readonly close: () => Promise<void>;
}

export class McpHub extends ServiceMap.Service<McpHub, McpHubShape>()("t3/mcp/hub/McpHub") {}

/** Adapter option fragment: `{ mcpHub }` when the server provides a hub, otherwise `{}`. */
export const mcpHubAdapterOption = Effect.serviceOption(McpHub).pipe(
  Effect.map((hub): { readonly mcpHub?: McpHubShape } =>
    Option.isSome(hub) ? { mcpHub: hub.value } : {},
  ),
);

function hashDefinition(definition: McpServerDefinition): string {
  return createHash("sha256")
    .update(stableMcpServersJson({ entry: definition }))
    .digest("hex")
    .slice(0, 24);
}

export function defaultConnectionScope(definition: McpServerDefinition): McpConnectionScope {
  return definition.connectionScope ?? (definition.type === "stdio" ? "session" : "shared");
}

interface UpstreamEntry {
  readonly upstream: McpHubUpstream;
  readonly key: string;
  /** Live attachments: slot id → who uses it. */
  readonly users: Map<string, { projectId?: ProjectId | undefined; provider: ProviderKind }>;
}

export interface McpHubOptions {
  readonly listener?: Pick<PreviewMcpHttpServerShape, "mount" | "baseUrl"> | undefined;
  readonly publish?: (payload: McpStatusUpdatedPayload) => void;
  /** Test seam for upstream construction. */
  readonly makeUpstream?: (
    options: ConstructorParameters<typeof McpHubUpstream>[0],
  ) => McpHubUpstream;
  /** OAuth token storage for remote servers; without it they only use static credentials. */
  readonly oauthStorage?: McpOAuthStorage;
}

export function makeMcpHub(options: McpHubOptions): McpHubShape {
  const listener = options.listener;
  const available = Boolean(listener?.mount && listener.baseUrl);
  const slots = new Map<string, McpHubSlot>();
  const upstreams = new Map<string, UpstreamEntry>();
  const changed = new Set<string>();
  let flushTimer: ReturnType<typeof setTimeout> | undefined;
  let closed = false;

  const flush = () => {
    flushTimer = undefined;
    const names = [...changed];
    changed.clear();
    for (const serverName of names)
      options.publish?.({ scope: "common", reason: "hub", serverName });
  };
  const markChanged = (serverName: string) => {
    if (closed) return;
    changed.add(serverName);
    flushTimer ??= setTimeout(flush, STATUS_DEBOUNCE_MS);
    if (typeof flushTimer === "object" && "unref" in flushTimer) flushTimer.unref();
  };

  const unmount = available
    ? listener!.mount!(MCP_HUB_PATH_PREFIX, async (request, response) => route(request, response))
    : undefined;

  async function route(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const path = (request.url ?? "").split("?")[0] ?? "";
    const slotId = path.slice(MCP_HUB_PATH_PREFIX.length);
    const slot = slots.get(slotId);
    const token = readBearerToken(request);
    if (!slot || !slot.authorizes(token)) {
      response.setHeader("www-authenticate", "Bearer");
      response.writeHead(401, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "invalid_mcp_credential" }));
      return;
    }
    await slot.handle(request, response);
  }

  const upstreamFor = (
    input: McpHubAttachInput,
    serverName: string,
    definition: McpServerDefinition,
  ): UpstreamEntry => {
    const scope = defaultConnectionScope(definition);
    const definitionHash = hashDefinition(definition);
    // Session connections are never reused; shared ones are per account and definition.
    const key =
      scope === "session"
        ? `session\0${randomBytes(12).toString("hex")}`
        : `shared\0${input.accountKey}\0${serverName}\0${definitionHash}`;
    const existing = upstreams.get(key);
    if (existing) return existing;
    const make = options.makeUpstream ?? ((value) => new McpHubUpstream(value));
    const oauthUrl = mcpOAuthServerUrl(definition);
    const authProvider =
      options.oauthStorage && oauthUrl
        ? new McpOAuthProvider({ storage: options.oauthStorage, serverUrl: oauthUrl, definition })
        : undefined;
    const upstream = make({
      name: serverName,
      definition,
      scope,
      environment: input.environment,
      cwd: input.cwd,
      ...(authProvider ? { authProvider } : {}),
      onChange: () => {
        markChanged(serverName);
        // A stopped upstream with no users is forgotten so it never leaks.
        const entry = upstreams.get(key);
        if (entry && entry.users.size === 0 && upstream.snapshot().state === "stopped")
          upstreams.delete(key);
      },
    });
    const entry: UpstreamEntry = { upstream, key, users: new Map() };
    upstreams.set(key, entry);
    return entry;
  };

  /** Which servers a session should get, after provider switches and interpolation. */
  const resolveServers = (
    input: McpHubAttachInput,
    servers: McpProjectServersConfig | null | undefined,
  ) => {
    const omitted: McpHubOmission[] = [];
    const wanted = new Map<string, McpServerDefinition>();
    // Servers turned off for this provider are left out silently, like disabled ones.
    const interpolated = interpolateMcpServers(
      filterEnabledMcpServers(servers, input.provider),
      input.environment,
    );
    for (const skip of interpolated.skipped)
      if (!input.reservedNames?.has(skip.name))
        omitted.push({ serverName: skip.name, reason: describeMcpInterpolationSkip(skip) });
    for (const [serverName, definition] of Object.entries(interpolated.servers)) {
      if (definition.enabled === false) continue;
      if (input.reservedNames?.has(serverName)) {
        omitted.push({ serverName, reason: "uses a name the provider already has" });
        continue;
      }
      wanted.set(serverName, definition);
    }
    return { wanted, omitted };
  };

  /** One endpoint of an attachment and the connection it currently routes to. */
  interface AttachedSlot {
    readonly slot: McpHubSlot;
    entry: UpstreamEntry | undefined;
    hash: string | undefined;
  }

  const bindEntry = (input: McpHubAttachInput, record: AttachedSlot, entry: UpstreamEntry) => {
    entry.users.set(record.slot.id, { projectId: input.projectId, provider: input.provider });
    entry.upstream.retain();
    record.entry = entry;
  };

  const unbindEntry = (record: AttachedSlot) => {
    const entry = record.entry;
    if (!entry) return;
    record.entry = undefined;
    record.hash = undefined;
    entry.users.delete(record.slot.id);
    entry.upstream.release();
    if (entry.users.size === 0 && entry.upstream.scope === "session") upstreams.delete(entry.key);
  };

  const attach = (input: McpHubAttachInput): McpHubAttachment => {
    const endpoints: McpHubEndpoint[] = [];
    if (!available || closed) {
      const omitted = Object.keys(input.servers ?? {}).map((name) => ({
        serverName: name,
        reason: "F5's MCP hub is unavailable in this runtime",
      }));
      return {
        endpoints,
        omitted,
        credentials: [],
        update: (servers) => ({
          changed: [],
          removed: [],
          added: [],
          addedEndpoints: [],
          endpoints: [],
          omitted: Object.keys(servers ?? {}).map((name) => ({
            serverName: name,
            reason: "F5's MCP hub is unavailable in this runtime",
          })),
        }),
        dispose: async () => {},
      };
    }
    const { wanted, omitted } = resolveServers(input, input.servers);
    const records = new Map<string, AttachedSlot>();
    const addSlot = (serverName: string, definition: McpServerDefinition): McpHubEndpoint => {
      const entry = upstreamFor(input, serverName, definition);
      const id = randomBytes(18).toString("base64url");
      const token = randomBytes(32).toString("base64url");
      const slot = new McpHubSlot({
        id,
        token,
        serverName,
        threadId: input.threadId,
        upstream: entry.upstream,
      });
      slots.set(id, slot);
      const record: AttachedSlot = { slot, entry: undefined, hash: hashDefinition(definition) };
      bindEntry(input, record, entry);
      records.set(serverName, record);
      const endpoint: McpHubEndpoint = {
        serverName,
        url: `${listener!.baseUrl}${MCP_HUB_PATH_PREFIX}${id}`,
        token,
        transport: definition.type,
        toolTimeoutMs: entry.upstream.toolTimeoutMs(),
      };
      endpoints.push(endpoint);
      return endpoint;
    };
    for (const [serverName, definition] of wanted) addSlot(serverName, definition);
    let disposed = false;
    const update = (
      servers: McpProjectServersConfig | null | undefined,
      updateOptions?: { readonly addEndpoints?: boolean },
    ): McpHubAttachmentUpdate => {
      if (disposed || closed)
        return {
          changed: [],
          removed: [],
          added: [],
          addedEndpoints: [],
          endpoints: [],
          omitted: [],
        };
      const next = resolveServers(input, servers);
      const changed: string[] = [];
      const removed: string[] = [];
      const added: string[] = [];
      for (const [serverName, record] of records) {
        const definition = next.wanted.get(serverName);
        if (!definition) {
          if (record.entry) {
            unbindEntry(record);
            record.slot.rebind(undefined);
            removed.push(serverName);
          }
          continue;
        }
        const hash = hashDefinition(definition);
        if (record.entry && record.hash === hash) continue;
        // Bind the new connection before releasing the old, so a shared one is reused.
        const previous = record.entry;
        const entry = upstreamFor(input, serverName, definition);
        record.entry = undefined;
        bindEntry(input, record, entry);
        record.hash = hash;
        record.slot.rebind(entry.upstream);
        if (previous) {
          previous.users.delete(record.slot.id);
          previous.upstream.release();
          if (previous.users.size === 0 && previous.upstream.scope === "session")
            upstreams.delete(previous.key);
        }
        changed.push(serverName);
      }
      const addedEndpoints: McpHubEndpoint[] = [];
      for (const [serverName, definition] of next.wanted) {
        if (records.has(serverName)) continue;
        added.push(serverName);
        if (updateOptions?.addEndpoints) addedEndpoints.push(addSlot(serverName, definition));
      }
      return {
        changed,
        removed,
        added,
        addedEndpoints,
        endpoints: endpoints.filter((endpoint) => records.get(endpoint.serverName)?.entry),
        omitted: next.omitted,
      };
    };
    return {
      endpoints,
      omitted,
      get credentials() {
        return endpoints.map((endpoint) => endpoint.token);
      },
      update,
      dispose: async () => {
        if (disposed) return;
        disposed = true;
        await Promise.allSettled(
          [...records.values()].map(async (record) => {
            slots.delete(record.slot.id);
            const entry = record.entry;
            if (entry) entry.users.delete(record.slot.id);
            await record.slot.close();
            if (entry) {
              record.entry = undefined;
              entry.upstream.release();
              if (entry.users.size === 0 && entry.upstream.scope === "session")
                upstreams.delete(entry.key);
            }
          }),
        );
      },
    };
  };

  const matching = (serverName?: string, projectId?: ProjectId) =>
    [...upstreams.values()].filter(
      (entry) =>
        (serverName === undefined || entry.upstream.name === serverName) &&
        (projectId === undefined ||
          [...entry.users.values()].some((user) => user.projectId === projectId)),
    );

  const status = (projectId?: ProjectId): McpHubServerStatus[] =>
    matching(undefined, projectId)
      .filter((entry) => entry.users.size > 0 || entry.upstream.snapshot().state !== "stopped")
      .map((entry) => {
        const snapshot = entry.upstream.snapshot();
        const users = [...entry.users.values()];
        return {
          name: entry.upstream.name,
          connectionScope: entry.upstream.scope,
          transport: entry.upstream.definition.type,
          state: snapshot.state,
          ...(snapshot.error ? { error: snapshot.error } : {}),
          ...(snapshot.serverInfo ? { serverInfo: snapshot.serverInfo } : {}),
          ...(snapshot.protocolVersion ? { protocolVersion: snapshot.protocolVersion } : {}),
          ...(snapshot.toolCount !== undefined ? { toolCount: snapshot.toolCount } : {}),
          ...(snapshot.resourceCount !== undefined
            ? { resourceCount: snapshot.resourceCount }
            : {}),
          ...(snapshot.promptCount !== undefined ? { promptCount: snapshot.promptCount } : {}),
          ...(snapshot.latencyMs !== undefined
            ? { latencyMs: Math.max(0, Math.round(snapshot.latencyMs)) }
            : {}),
          ...(snapshot.lastConnectedAt ? { lastConnectedAt: snapshot.lastConnectedAt } : {}),
          attempts: snapshot.attempts,
          attachedSessions: entry.users.size,
          projectIds: [
            ...new Set(users.flatMap((user) => (user.projectId ? [user.projectId] : []))),
          ],
          providers: [...new Set(users.map((user) => user.provider))],
        } satisfies McpHubServerStatus;
      })
      .toSorted((left, right) => left.name.localeCompare(right.name));

  const reconnect = async (serverName: string, projectId?: ProjectId): Promise<number> => {
    const entries = matching(serverName, projectId).filter((entry) => entry.users.size > 0);
    await Promise.allSettled(entries.map((entry) => entry.upstream.reconnect()));
    return entries.length;
  };

  const readStderrTail = (serverName: string, projectId?: ProjectId) => {
    const tails = matching(serverName, projectId)
      .map((entry) => entry.upstream.readStderrTail())
      .filter(Boolean);
    return tails.length > 0 ? tails.join("\n") : undefined;
  };

  const close = async () => {
    if (closed) return;
    closed = true;
    unmount?.();
    if (flushTimer) clearTimeout(flushTimer);
    const allSlots = [...slots.values()];
    slots.clear();
    const allUpstreams = [...upstreams.values()];
    upstreams.clear();
    await Promise.allSettled(allSlots.map((slot) => slot.close()));
    await Promise.allSettled(allUpstreams.map((entry) => entry.upstream.stop()));
  };

  const reconnectOAuth = async (oauthKey: string): Promise<number> => {
    const entries = [...upstreams.values()].filter(
      (entry) => entry.users.size > 0 && entry.upstream.oauthKey === oauthKey,
    );
    await Promise.allSettled(entries.map((entry) => entry.upstream.reconnect()));
    return entries.length;
  };

  return {
    available,
    attach,
    status,
    reconnect,
    readStderrTail,
    oauthStorage: options.oauthStorage,
    reconnectOAuth,
    close,
  };
}

export const McpHubLive = Layer.effect(
  McpHub,
  Effect.gen(function* () {
    const listener = Option.getOrUndefined(yield* Effect.serviceOption(PreviewMcpHttpServer));
    const bus = Option.getOrUndefined(yield* Effect.serviceOption(CodexMcpEventBus));
    const secrets = Option.getOrUndefined(yield* Effect.serviceOption(ServerSecretStore));
    const hub = makeMcpHub({
      listener,
      ...(secrets ? { oauthStorage: secretStoreOAuthStorage(secrets) } : {}),
      ...(bus
        ? { publish: (payload) => void Effect.runFork(bus.publishStatusUpdated(payload)) }
        : {}),
    });
    yield* Effect.addFinalizer(() => Effect.promise(() => hub.close()));
    return hub;
  }),
);
