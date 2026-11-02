import {
  ProviderInstanceId,
  type ProjectId,
  type ProviderKind,
  type ProviderStartOptions,
} from "@t3tools/contracts";
import { parseLaunchArgv } from "@t3tools/shared/cliArgs";
import { Effect, Option, Schema } from "effect";
import { ServerConfig } from "../config.ts";
import { ProjectionProjectRepository } from "../persistence/Services/ProjectionProjects.ts";
import { ProviderAccountService } from "../profiles/ProviderAccountService.ts";
import { executionProviderFingerprintFor } from "../provider/providerConfigurationFingerprint.ts";
import { buildAccountExecutionEnvironment } from "../providerProcessEnv.ts";
import { deriveProviderInstanceConfigMap } from "../provider/Layers/ProviderInstanceRegistryHydration.ts";
import { ServerSettingsService } from "../serverSettings.ts";

export class McpAccountExecutionError extends Schema.TaggedErrorClass<McpAccountExecutionError>()(
  "McpAccountExecutionError",
  { message: Schema.String },
) {}

/** The same account resolver serves CLI login and control processes; homes never select accounts. */
export const makeMcpAccountExecutionResolver = Effect.gen(function* () {
  const config = yield* Effect.serviceOption(ServerConfig);
  const settings = yield* Effect.serviceOption(ServerSettingsService);
  const projects = yield* Effect.serviceOption(ProjectionProjectRepository);
  const readIdentity = (input: {
    readonly provider: ProviderKind;
    readonly instanceId?: ProviderInstanceId | undefined;
    readonly projectId?: ProjectId | undefined;
    readonly providerOptions?: ProviderStartOptions | undefined;
  }) =>
    Effect.gen(function* () {
      const instanceId = input.instanceId ?? ProviderInstanceId.make(input.provider);
      const project =
        input.projectId && Option.isSome(projects)
          ? yield* projects.value.getById({ projectId: input.projectId })
          : Option.none();
      if (
        input.projectId &&
        Option.isSome(projects) &&
        (Option.isNone(project) || project.value.deletedAt)
      )
        return yield* new McpAccountExecutionError({ message: "MCP project does not exist." });
      const configured = Option.isSome(settings)
        ? deriveProviderInstanceConfigMap(yield* settings.value.getSettings)[instanceId]
        : undefined;
      if (
        Option.isSome(settings) &&
        (!configured || configured.driver !== input.provider || configured.enabled === false)
      )
        return yield* new McpAccountExecutionError({
          message: "The selected MCP provider instance is unavailable or has a different driver.",
        });
      const cwd = Option.isSome(project)
        ? project.value.workspaceRoot
        : Option.isSome(config)
          ? config.value.cwd
          : process.cwd();
      const fingerprint = configured ? yield* executionProviderFingerprintFor(configured) : "";
      return {
        instanceId,
        cwd,
        fingerprint,
        identity: JSON.stringify([cwd, instanceId, fingerprint]),
      };
    }).pipe(
      Effect.mapError(
        (cause) =>
          new McpAccountExecutionError({
            message: cause instanceof Error ? cause.message : String(cause),
          }),
      ),
    );
  const resolve = (input: Parameters<typeof readIdentity>[0]) =>
    Effect.gen(function* () {
      const identity = yield* readIdentity(input);
      const { instanceId } = identity;
      const account =
        Option.isSome(config) && Option.isSome(settings)
          ? yield* Effect.tryPromise({
              try: () => ProviderAccountService.resolve(config.value, settings.value, instanceId),
              catch: (cause) =>
                new McpAccountExecutionError({
                  message: cause instanceof Error ? cause.message : String(cause),
                }),
            })
          : undefined;
      if (
        account &&
        (account.instance.driver !== input.provider || account.instance.enabled === false)
      )
        return yield* new McpAccountExecutionError({
          message: "The selected MCP provider instance is unavailable or has a different driver.",
        });
      if (
        account &&
        (yield* executionProviderFingerprintFor(account.instance)) !== identity.fingerprint
      )
        return yield* new McpAccountExecutionError({
          message:
            "Provider execution settings changed while resolving the MCP account. Retry the operation.",
        });
      let providerOptions = input.providerOptions;
      if (account) {
        const launchArgs = parseLaunchArgv(
          "launchArgs" in account.config ? account.config.launchArgs : "",
        );
        if (!launchArgs.ok)
          return yield* new McpAccountExecutionError({
            message: `Invalid launch arguments: ${launchArgs.error}`,
          });
        const options = {
          binaryPath: account.config.binaryPath,
          homePath: account.config.homePath,
          ...(launchArgs.argv.length ? { launchArgs: [...launchArgs.argv] } : {}),
        };
        providerOptions =
          input.provider === "codex"
            ? { codex: options }
            : {
                claudeAgent: { binaryPath: account.config.binaryPath },
              };
      }
      const environment =
        account?.environment ??
        (Option.isSome(config)
          ? buildAccountExecutionEnvironment({
              purpose: "account",
              profile: config.value.profile,
              stateDir: config.value.stateDir,
              baseEnv: process.env,
            })
          : { ...process.env });
      return {
        ...identity,
        environment,
        providerOptions,
        instanceEnvironment: account?.instance.environment,
      };
    }).pipe(
      Effect.mapError(
        (cause) =>
          new McpAccountExecutionError({
            message: cause instanceof Error ? cause.message : String(cause),
          }),
      ),
    );
  return Object.assign(resolve, { readIdentity });
});
