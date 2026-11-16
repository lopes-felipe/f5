import { makeOperationGate } from "../provider/operationGate.ts";
import { resolveCodexCommand } from "../provider/codexExecutable.ts";
import { makeMcpAccountExecutionResolver } from "../mcp/accountExecution.ts";
import { ServerSettingsService } from "../serverSettings";
import { ProviderInstanceId } from "@t3tools/contracts";
import * as NodePath from "node:path";
import { acquireInstanceLock } from "../profiles/InstanceLock";
import { validateManagedHome, validateProviderCompatibility } from "../profiles/providerIsolation";
import { buildAccountExecutionEnvironment } from "../providerProcessEnv";
import {
  type CodexMcpServerEntry,
  type ProjectId,
  type ProviderStartOptions,
} from "@t3tools/contracts";
import {
  getProviderEnvironmentKey,
  readCodexEnvironmentOptions,
} from "@t3tools/shared/providerOptions";
import { CODEX_MCP_OAUTH_CLIENT_TTL_MS } from "@t3tools/shared/codexOAuthTiming";
import { Cause, Effect, Layer, Option, Schema, ServiceMap, Stream } from "effect";

import { ServerConfig } from "../config.ts";
import { CodexControlClient, type CodexControlEnvironmentConfig } from "./CodexControlClient.ts";

const ADMIN_CLIENT_TTL_MS = 30_000;
const MAX_OAUTH_CLIENTS = 4;

export interface CodexControlClientAccessInput {
  readonly projectId: ProjectId;
  readonly instanceId?: ProviderInstanceId;
  readonly cwd?: string;
  readonly executionFingerprint?: string;
  readonly processEnvironment?: NodeJS.ProcessEnv;
  readonly providerOptions?: ProviderStartOptions;
  readonly mcpEffectiveConfigVersion?: string | null;
  readonly mcpServers?: Record<string, CodexMcpServerEntry>;
  readonly mcpOAuthCallbackPort?: number;
  readonly mcpOAuthCallbackUrl?: string;
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
  releaseInstallationLock?: () => void;
  promise: Promise<CodexControlClient>;
  client: CodexControlClient | null;
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
    ...(environmentOptions.launchArgs ? { launchArgs: environmentOptions.launchArgs } : {}),
    mcpServers: input.mcpServers ?? {},
    ...(input.mcpOAuthCallbackPort ? { mcpOAuthCallbackPort: input.mcpOAuthCallbackPort } : {}),
    ...(input.mcpOAuthCallbackUrl ? { mcpOAuthCallbackUrl: input.mcpOAuthCallbackUrl } : {}),
  };
}

export function readCodexControlEnvironmentKey(input: {
  readonly providerOptions?: ProviderStartOptions;
}): string {
  return getProviderEnvironmentKey("codex", input.providerOptions);
}

export function readCodexControlPoolKey(input: CodexControlClientAccessInput): string {
  return `${input.projectId}\u0000${input.cwd ?? ""}\u0000${input.instanceId ?? "codex"}\u0000${input.executionFingerprint ?? ""}\u0000${readCodexControlEnvironmentKey(input)}\u0000${input.mcpEffectiveConfigVersion ?? ""}\u0000${input.mcpOAuthCallbackPort ?? ""}\u0000${input.mcpOAuthCallbackUrl ?? ""}`;
}

function readOauthLeaseKey(input: CodexOauthClientAccessInput): string {
  return `${readCodexControlPoolKey(input)}\u0000${input.serverName}`;
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
  const settingsService = yield* Effect.serviceOption(ServerSettingsService);
  const resolveExecution = yield* makeMcpAccountExecutionResolver;
  const identities = new Map<string, { key: string; input: CodexControlClientAccessInput }>();
  const resolvedInputs = new Map<string, CodexControlClientAccessInput>();
  const withControlIdentity = makeOperationGate<string>();
  const controlIdentityKey = (input: CodexControlClientAccessInput) =>
    `${input.projectId}\u0000${input.instanceId ?? "codex"}`;
  const adminClients = new Map<string, CachedAdminClient>();
  const oauthClients = new Map<string, OauthLease>();

  const disposeAdminEntry = (poolKey: string, entry: CachedAdminClient) => {
    if (adminClients.get(poolKey) !== entry) {
      return;
    }
    adminClients.delete(poolKey);
    clearTimer(entry.timer);
    entry.client?.close();
    forgetInput(poolKey);
  };

  const refreshAdminClientTtl = (poolKey: string, entry: CachedAdminClient) => {
    clearTimer(entry.timer);
    entry.timer = setTimeout(() => {
      disposeAdminEntry(poolKey, entry);
    }, ADMIN_CLIENT_TTL_MS);
  };

  const releaseOauthLease = async (leaseKey: string): Promise<void> => {
    const lease = oauthClients.get(leaseKey);
    if (!lease) return;
    oauthClients.delete(leaseKey);
    clearTimer(lease.timer);
    try {
      const client = lease.client ?? (await lease.promise);
      await client.closeAndWait();
    } finally {
      lease.releaseInstallationLock?.();
      forgetInput(leaseKey.slice(0, leaseKey.lastIndexOf("\u0000")));
    }
  };
  yield* Effect.addFinalizer(() =>
    Effect.promise(async () => {
      for (const [poolKey, entry] of adminClients.entries()) disposeAdminEntry(poolKey, entry);
      await Promise.all([...oauthClients.keys()].map(releaseOauthLease));
    }),
  );

  const createClient = async (input: CodexControlClientAccessInput) => {
    const config = readCodexControlEnvironmentConfig(input, input.cwd ?? serverConfig.cwd);
    const environment =
      input.processEnvironment ??
      buildAccountExecutionEnvironment({
        purpose: "account",
        profile: serverConfig.profile,
        stateDir: serverConfig.stateDir,
        baseEnv: process.env,
      });
    const homePath = config.homePath ?? environment.CODEX_HOME;
    if (homePath) await validateManagedHome(serverConfig, homePath);
    await validateProviderCompatibility(
      serverConfig,
      "codex",
      resolveCodexCommand(config.binaryPath),
      environment,
    );
    return CodexControlClient.create({
      ...config,
      ...(homePath ? { homePath } : {}),
      processEnvironment: environment,
    });
  };

  const retireIdentity = (input: CodexControlClientAccessInput) =>
    Effect.gen(function* () {
      const instanceId = input.instanceId ?? ProviderInstanceId.make("codex");
      for (const [poolKey, old] of resolvedInputs) {
        if (old.projectId !== input.projectId || old.instanceId !== instanceId) continue;
        const admin = adminClients.get(poolKey);
        if (admin) disposeAdminEntry(poolKey, admin);
        for (const [leaseKey, lease] of oauthClients) {
          if (leaseKey.startsWith(`${poolKey}\u0000`)) {
            lease.client?.close();
            yield* Effect.promise(() => releaseOauthLease(leaseKey));
          }
        }
        resolvedInputs.delete(poolKey);
      }
      identities.delete(`${input.projectId}\u0000${instanceId}`);
    });
  const trackInput = (input: CodexControlClientAccessInput) => {
    identities.set(`${input.projectId}\u0000${input.instanceId ?? "codex"}`, {
      key: JSON.stringify([
        input.cwd,
        input.instanceId ?? "codex",
        input.executionFingerprint ?? "",
      ]),
      input,
    });
    resolvedInputs.set(readCodexControlPoolKey(input), input);
  };
  const forgetInput = (poolKey: string) => {
    if (
      adminClients.has(poolKey) ||
      [...oauthClients.keys()].some((key) => key.startsWith(`${poolKey}\u0000`))
    )
      return;
    const input = resolvedInputs.get(poolKey);
    resolvedInputs.delete(poolKey);
    if (
      input &&
      ![...resolvedInputs.values()].some(
        (entry) => entry.projectId === input.projectId && entry.instanceId === input.instanceId,
      )
    )
      identities.delete(`${input.projectId}\u0000${input.instanceId ?? "codex"}`);
  };
  const resolveInput = (input: CodexControlClientAccessInput) =>
    Effect.gen(function* () {
      const execution = yield* resolveExecution({ ...input, provider: "codex" });
      const instanceId = execution.instanceId;
      const resolved: CodexControlClientAccessInput = {
        ...input,
        instanceId,
        cwd: execution.cwd,
        processEnvironment: execution.environment,
        ...(execution.providerOptions ? { providerOptions: execution.providerOptions } : {}),
        executionFingerprint: execution.fingerprint,
      };
      const identityKey = `${input.projectId}\u0000${instanceId}`;
      const previous = identities.get(identityKey);
      if (previous && previous.key !== execution.identity) yield* retireIdentity(input);
      return resolved;
    }).pipe(
      Effect.mapError(
        (cause) =>
          new CodexControlClientRegistryError({
            message: cause instanceof Error ? cause.message : String(cause),
          }),
      ),
    );

  const getOrCreateAdminEntry = (input: CodexControlClientAccessInput) => {
    const poolKey = readCodexControlPoolKey(input);
    trackInput(input);
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
          forgetInput(poolKey);
        }
      },
    );

    return { poolKey, entry } as const;
  };

  const ensureCurrentIdentity = (input: CodexControlClientAccessInput) =>
    resolveExecution.readIdentity({ ...input, provider: "codex" }).pipe(
      Effect.flatMap((current) =>
        current.identity ===
        JSON.stringify([input.cwd, input.instanceId ?? "codex", input.executionFingerprint ?? ""])
          ? Effect.void
          : retireIdentity(input).pipe(
              Effect.andThen(
                Effect.fail(
                  new CodexControlClientRegistryError({
                    message: "The MCP control identity was superseded.",
                  }),
                ),
              ),
            ),
      ),
      Effect.mapError((cause) => new CodexControlClientRegistryError({ message: cause.message })),
    );
  const refreshIdentities = () =>
    Effect.suspend(() =>
      Effect.forEach(
        [...identities.values()],
        (entry) =>
          withControlIdentity(
            controlIdentityKey(entry.input),
            Effect.suspend(() => {
              if (identities.get(controlIdentityKey(entry.input)) !== entry) return Effect.void;
              return ensureCurrentIdentity(entry.input).pipe(
                Effect.catch(() => retireIdentity(entry.input)),
              );
            }),
          ).pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning(
                "Failed to retire stale MCP control identity; monitoring continues.",
                {
                  projectId: entry.input.projectId,
                  instanceId: entry.input.instanceId,
                  cause: Cause.pretty(cause),
                },
              ),
            ),
          ),
        { concurrency: 1 },
      ).pipe(Effect.asVoid),
    );
  if (Option.isSome(settingsService)) {
    yield* Stream.runForEach(settingsService.value.streamChanges, refreshIdentities).pipe(
      Effect.forkScoped,
    );
  }
  // Projects have no settings stream. Check only active identities, without constructing clients.
  yield* Effect.gen(function* () {
    while (true) {
      yield* Effect.sleep("1 second");
      yield* refreshIdentities();
    }
  }).pipe(Effect.forkScoped);

  const service = {
    getAdminClient: (rawInput) =>
      resolveInput(rawInput).pipe(
        Effect.flatMap((input) =>
          Effect.tryPromise({
            try: async () => {
              const { poolKey, entry } = getOrCreateAdminEntry(input);
              const client = await entry.promise;
              if (adminClients.get(poolKey) !== entry)
                throw new Error("The MCP control identity was superseded.");
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
          }).pipe(Effect.tap(() => ensureCurrentIdentity(input))),
        ),
      ),
    hasOauthLease: (rawInput) =>
      resolveInput(rawInput).pipe(
        Effect.map((input) =>
          oauthClients.has(readOauthLeaseKey({ ...input, serverName: rawInput.serverName })),
        ),
        Effect.catch(() => Effect.succeed(false)),
      ),
    acquireOauthClient: (rawInput) =>
      resolveInput(rawInput).pipe(
        Effect.flatMap((resolved) => {
          const input = { ...resolved, serverName: rawInput.serverName };
          return Effect.tryPromise({
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

              const installationLock = await acquireInstanceLock(
                NodePath.join(
                  serverConfig.profilesRoot ?? `${serverConfig.stateDir}-profiles`,
                  "locks",
                  "provider-oauth.lock.sqlite",
                ),
              );
              const lease: OauthLease = {
                releaseInstallationLock: installationLock.release,
                promise: createClient(input),
                client: null,
                timer: null,
              };
              trackInput(input);
              oauthClients.set(leaseKey, lease);

              let client: CodexControlClient;
              try {
                client = await lease.promise;
              } catch (error) {
                if (oauthClients.get(leaseKey) === lease) {
                  oauthClients.delete(leaseKey);
                }
                installationLock.release();
                throw error;
              }
              if (oauthClients.get(leaseKey) !== lease) {
                client.close();
                throw new CodexControlClientRegistryError({
                  message: `OAuth login for MCP server '${input.serverName}' was cancelled.`,
                });
              }
              lease.client = client;
              lease.timer = setTimeout(() => {
                void releaseOauthLease(leaseKey);
              }, CODEX_MCP_OAUTH_CLIENT_TTL_MS);

              return {
                client,
                release: Effect.promise(() => releaseOauthLease(leaseKey)),
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
          }).pipe(Effect.tap(() => ensureCurrentIdentity(input)));
        }),
      ),
  } satisfies CodexControlClientRegistryShape;
  return {
    getAdminClient: (input) =>
      withControlIdentity(controlIdentityKey(input), service.getAdminClient(input)),
    hasOauthLease: (input) =>
      withControlIdentity(controlIdentityKey(input), service.hasOauthLease(input)),
    acquireOauthClient: (input) =>
      withControlIdentity(controlIdentityKey(input), service.acquireOauthClient(input)),
  } satisfies CodexControlClientRegistryShape;
});

export const CodexControlClientRegistryLive = Layer.effect(
  CodexControlClientRegistry,
  makeCodexControlClientRegistry,
);
