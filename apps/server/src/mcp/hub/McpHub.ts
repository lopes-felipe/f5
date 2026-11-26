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
  /** How long the first request may wait for the server to start. */
  readonly startupTimeoutMs: number;
}

export interface McpHubOmission {
  readonly serverName: string;
  readonly reason: string;
}

/**
 * The `config.warning` payload for project servers an agent did not get, so a
 * missing tool is never silent. Undefined when nothing was left out.
 */
export function describeMcpHubOmissions(
  agentLabel: string,
  omitted: ReadonlyArray<McpHubOmission>,
): { readonly summary: string; readonly details: string } | undefined {
  if (omitted.length === 0) return undefined;
  return {
    summary:
      omitted.length === 1
        ? `F5 did not pass MCP server ${omitted[0]!.serverName} to ${agentLabel}.`
        : `F5 did not pass ${omitted.length} MCP servers to ${agentLabel}.`,
    details: omitted.map((entry) => `${entry.serverName} ${entry.reason}.`).join("\n"),
  };
}

export interface McpHubAttachment {
  readonly endpoints: ReadonlyArray<McpHubEndpoint>;
  readonly omitted: ReadonlyArray<McpHubOmission>;
  /** Credentials to scrub from logs and diagnostics. */
  readonly credentials: ReadonlyArray<string>;
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

export function defaultConnectionScope(definition: McpServerDefinition): McpConnectionScope {
  return definition.connectionScope ?? (definition.type === "stdio" ? "session" : "shared");
}

interface UpstreamEntry {
  readonly upstream: McpHubUpstream;
  readonly key: string;
  /** Opaque status id; the key itself names the account and must not leave the server. */
  readonly id: string;
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
    const definitionHash = createHash("sha256")
      .update(stableMcpServersJson({ entry: definition }))
      .digest("hex")
      .slice(0, 24);
    // Session connections are never reused. Shared ones are per account, definition and
    // workspace root: the root is what the server sees in `roots/list`, so a session in
    // another project or worktree never gets the first session's checkout.
    const key =
      scope === "session"
        ? `session\0${randomBytes(12).toString("hex")}`
        : `shared\0${input.accountKey}\0${input.cwd}\0${serverName}\0${definitionHash}`;
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
    const entry: UpstreamEntry = {
      upstream,
      key,
      id: createHash("sha256").update(key).digest("base64url").slice(0, 16),
      users: new Map(),
    };
    upstreams.set(key, entry);
    return entry;
  };

  const attach = (input: McpHubAttachInput): McpHubAttachment => {
    const endpoints: McpHubEndpoint[] = [];
    const omitted: McpHubOmission[] = [];
    const attached: Array<{ slot: McpHubSlot; entry: UpstreamEntry }> = [];
    if (!available || closed) {
      for (const name of Object.keys(input.servers ?? {}))
        omitted.push({
          serverName: name,
          reason: "was skipped because F5's MCP hub is unavailable in this runtime",
        });
      return { endpoints, omitted, credentials: [], dispose: async () => {} };
    }
    const interpolated = interpolateMcpServers(input.servers, input.environment);
    for (const skip of interpolated.skipped)
      if (!input.reservedNames?.has(skip.name))
        omitted.push({ serverName: skip.name, reason: describeMcpInterpolationSkip(skip) });
    for (const [serverName, definition] of Object.entries(interpolated.servers)) {
      if (definition.enabled === false) continue;
      if (input.reservedNames?.has(serverName)) {
        omitted.push({ serverName, reason: "uses a name the provider already has" });
        continue;
      }
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
      entry.users.set(id, { projectId: input.projectId, provider: input.provider });
      entry.upstream.retain();
      attached.push({ slot, entry });
      endpoints.push({
        serverName,
        url: `${listener!.baseUrl}${MCP_HUB_PATH_PREFIX}${id}`,
        token,
        transport: definition.type,
        toolTimeoutMs: entry.upstream.toolTimeoutMs(),
        startupTimeoutMs: entry.upstream.startupTimeoutMs(),
      });
    }
    let disposed = false;
    return {
      endpoints,
      omitted,
      credentials: endpoints.map((endpoint) => endpoint.token),
      dispose: async () => {
        if (disposed) return;
        disposed = true;
        await Promise.allSettled(
          attached.map(async ({ slot, entry }) => {
            slots.delete(slot.id);
            entry.users.delete(slot.id);
            await slot.close();
            entry.upstream.release();
            if (entry.users.size === 0 && entry.upstream.scope === "session")
              upstreams.delete(entry.key);
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
        // A project's view counts and names only its own sessions.
        const users = [...entry.users.values()].filter(
          (user) => projectId === undefined || user.projectId === projectId,
        );
        return {
          id: entry.id,
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
          attachedSessions: users.length,
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
