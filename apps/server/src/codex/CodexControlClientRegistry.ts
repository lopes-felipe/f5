import {
  type CodexMcpServerEntry,
  type ProjectId,
  type ProviderStartOptions,
} from "@t3tools/contracts";
import {
  getProviderEnvironmentKey,
  readCodexEnvironmentOptions,
} from "@t3tools/shared/providerOptions";
import { Effect, Layer, Schema, ServiceMap } from "effect";

import { ServerConfig } from "../config.ts";
import { CodexControlClient, type CodexControlEnvironmentConfig } from "./CodexControlClient.ts";

const ADMIN_CLIENT_TTL_MS = 30_000;
const OAUTH_CLIENT_TTL_MS = 5 * 60_000;
const MAX_OAUTH_CLIENTS = 4;

export interface CodexControlClientAccessInput {
  readonly projectId: ProjectId;
  readonly providerOptions?: ProviderStartOptions;
  readonly mcpEffectiveConfigVersion?: string | null;
  readonly mcpServers?: Record<string, CodexMcpServerEntry>;
}

export interface CodexOauthClientAccessInput extends CodexControlClientAccessInput {
  readonly serverName: string;
}

interface CachedAdminClient {
  promise: Promise<CodexControlClient>;
  client: CodexControlClient | null;
  timer: ReturnType<typeof setTimeout> | null;
}

interface OauthLease {
  client: CodexControlClient;
  timer: ReturnType<typeof setTimeout> | null;
}

function clearTimer(timer: ReturnType<typeof setTimeout> | null) {
  if (timer !== null) {
    clearTimeout(timer);
  }
}

export class CodexControlClientRegistryError extends Schema.TaggedErrorClass<CodexControlClientRegistryError>()(
  "CodexControlClientRegistryError",
  {
    message: Schema.String,
  },
) {}

export function readCodexControlEnvironmentConfig(
  input: CodexControlClientAccessInput,
  cwd: string,
): CodexControlEnvironmentConfig {
  const environmentOptions = readCodexEnvironmentOptions(input.providerOptions);
  return {
    cwd,
    ...(environmentOptions.binaryPath ? { binaryPath: environmentOptions.binaryPath } : {}),
    ...(environmentOptions.homePath ? { homePath: environmentOptions.homePath } : {}),
    mcpServers: input.mcpServers ?? {},
  };
}

export function readCodexControlEnvironmentKey(input: {
  readonly providerOptions?: ProviderStartOptions;
}): string {
  return getProviderEnvironmentKey("codex", input.providerOptions);
}

export function readCodexControlPoolKey(input: CodexControlClientAccessInput): string {
  return `${input.projectId}\u0000${readCodexControlEnvironmentKey(input)}\u0000${input.mcpEffectiveConfigVersion ?? ""}`;
}

function readOauthLeaseKey(input: CodexOauthClientAccessInput): string {
  return `${input.projectId}\u0000${readCodexControlEnvironmentKey(input)}\u0000${input.serverName}`;
}

export interface CodexControlClientRegistryShape {
  readonly getAdminClient: (
    input: CodexControlClientAccessInput,
  ) => Effect.Effect<CodexControlClient, CodexControlClientRegistryError>;
  readonly hasOauthLease: (input: CodexOauthClientAccessInput) => Effect.Effect<boolean>;
  readonly acquireOauthClient: (input: CodexOauthClientAccessInput) => Effect.Effect<
    {
      readonly client: CodexControlClient;
      readonly release: Effect.Effect<void>;
    },
    CodexControlClientRegistryError
  >;
}

export class CodexControlClientRegistry extends ServiceMap.Service<
  CodexControlClientRegistry,
  CodexControlClientRegistryShape
>()("t3/codex/CodexControlClientRegistry") {}

const makeCodexControlClientRegistry = Effect.gen(function* () {
  const serverConfig = yield* ServerConfig;
  const adminClients = new Map<string, CachedAdminClient>();
  const oauthClients = new Map<string, OauthLease>();

  const disposeAdminEntry = (poolKey: string, entry: CachedAdminClient) => {
    if (adminClients.get(poolKey) !== entry) {
      return;
    }
    adminClients.delete(poolKey);
    clearTimer(entry.timer);
    entry.client?.close();
  };

  const refreshAdminClientTtl = (poolKey: string, entry: CachedAdminClient) => {
    clearTimer(entry.timer);
    entry.timer = setTimeout(() => {
      disposeAdminEntry(poolKey, entry);
    }, ADMIN_CLIENT_TTL_MS);
  };

  const releaseOauthLease = (leaseKey: string) => {
    const lease = oauthClients.get(leaseKey);
    if (!lease) {
      return;
    }
    oauthClients.delete(leaseKey);
    clearTimer(lease.timer);
    lease.client.close();
  };

  yield* Effect.addFinalizer(() =>
    Effect.sync(() => {
      for (const [poolKey, entry] of adminClients.entries()) {
        disposeAdminEntry(poolKey, entry);
      }
      for (const leaseKey of oauthClients.keys()) {
        releaseOauthLease(leaseKey);
      }
    }),
  );

  const createClient = (input: CodexControlClientAccessInput) =>
    CodexControlClient.create(readCodexControlEnvironmentConfig(input, serverConfig.cwd));

  const getOrCreateAdminEntry = (input: CodexControlClientAccessInput) => {
    const poolKey = readCodexControlPoolKey(input);
    const existing = adminClients.get(poolKey);
    if (existing) {
      return { poolKey, entry: existing } as const;
    }

    const entry: CachedAdminClient = {
      promise: createClient(input),
      client: null,
      timer: null,
    };
    adminClients.set(poolKey, entry);

    void entry.promise.then(
      (client) => {
        if (adminClients.get(poolKey) !== entry) {
          client.close();
          return;
        }
        entry.client = client;
        refreshAdminClientTtl(poolKey, entry);
      },
      () => {
        if (adminClients.get(poolKey) === entry) {
          adminClients.delete(poolKey);
        }
      },
    );

    return { poolKey, entry } as const;
  };

  return {
    getAdminClient: (input) =>
      Effect.tryPromise({
        try: async () => {
          const { poolKey, entry } = getOrCreateAdminEntry(input);
          const client = await entry.promise;
          refreshAdminClientTtl(poolKey, entry);
          return client;
        },
        catch: (cause) =>
          new CodexControlClientRegistryError({
            message:
              cause instanceof Error
                ? cause.message
                : `Failed to create Codex control client for project '${input.projectId}'.`,
          }),
      }),
    hasOauthLease: (input) => Effect.succeed(oauthClients.has(readOauthLeaseKey(input))),
    acquireOauthClient: (input) =>
      Effect.tryPromise({
        try: async () => {
          const leaseKey = readOauthLeaseKey(input);
          if (oauthClients.has(leaseKey)) {
            throw new CodexControlClientRegistryError({
              message: `OAuth login is already pending for MCP server '${input.serverName}'.`,
            });
          }
          if (oauthClients.size >= MAX_OAUTH_CLIENTS) {
            throw new CodexControlClientRegistryError({
              message: "Too many concurrent Codex MCP OAuth logins are already running.",
            });
          }

          const client = await createClient(input);
          const lease: OauthLease = {
            client,
            timer: setTimeout(() => {
              releaseOauthLease(leaseKey);
            }, OAUTH_CLIENT_TTL_MS),
          };
          oauthClients.set(leaseKey, lease);

          return {
            client,
            release: Effect.sync(() => {
              releaseOauthLease(leaseKey);
            }),
          };
        },
        catch: (cause) =>
          Schema.is(CodexControlClientRegistryError)(cause)
            ? cause
            : new CodexControlClientRegistryError({
                message:
                  cause instanceof Error
                    ? cause.message
                    : `Failed to create OAuth Codex control client for project '${input.projectId}'.`,
              }),
      }),
  } satisfies CodexControlClientRegistryShape;
});

export const CodexControlClientRegistryLive = Layer.effect(
  CodexControlClientRegistry,
  makeCodexControlClientRegistry,
);
