/**
 * ClaudeDriver — `ProviderDriver` for the Claude Agent SDK runtime.
 *
 * Mirrors `CodexDriver`: a plain value whose `create()` returns one
 * `ProviderInstance` bundling `snapshot` / `adapter` / `textGeneration`
 * closures captured over the per-instance `ClaudeSettings`.
 *
 * Unlike Codex, the Claude snapshot probe may invoke a secondary probe
 * (`probeClaudeCapabilities`) to read Anthropic account + slash-command
 * metadata. That probe is per-instance and keyed by binary + resolved HOME so
 * two concurrent Claude instances don't cross-contaminate account metadata.
 *
 * @module provider/Drivers/ClaudeDriver
 */
import { ClaudeSettings, ProviderDriverKind, type ServerProvider } from "@t3tools/contracts";
import { Duration, Effect, FileSystem, Path, Schema, Stream } from "effect";
import { makeClaudeInstanceProbes } from "./ClaudeProbeCache.ts";
import {
  emptyAccountSection,
  makeAccountUsageCapability,
} from "../../usage/Layers/AccountUsageService.ts";
import { ChildProcessSpawner } from "effect/unstable/process";

import { makeClaudeTextGeneration } from "../../git/Layers/ClaudeTextGeneration.ts";
import { ServerConfig } from "../../config.ts";
import { ProviderDriverError } from "../Errors.ts";
import { makeClaudeAdapter } from "../Layers/ClaudeAdapter.ts";
import { checkClaudeProviderStatus, makePendingClaudeProvider } from "../Layers/ClaudeProvider.ts";
import { ProviderEventLoggers } from "../Layers/ProviderEventLoggers.ts";
import { makeManagedServerProvider } from "../makeManagedServerProvider.ts";
import {
  defaultProviderContinuationIdentity,
  type ProviderDriver,
  type ProviderInstance,
} from "../ProviderDriver.ts";
import type { ServerProviderDraft } from "../providerSnapshot.ts";
import { mergeProviderInstanceEnvironment } from "../ProviderInstanceEnvironment.ts";
import { makeClaudeContinuationGroupKey, makeClaudeEnvironment } from "./ClaudeHome.ts";
import { parseClaudeLaunchArgs } from "@t3tools/shared/cliArgs";

export const resolveClaudeOneOffLaunchArgs = Effect.fn("resolveClaudeOneOffLaunchArgs")(function* (
  raw: string,
  instanceId: string,
) {
  const parsed = parseClaudeLaunchArgs(raw);
  if (parsed.ok) return parsed.args;
  yield* Effect.logWarning("ignoring invalid Claude launch arguments for one-off prompts", {
    instanceId,
    detail: parsed.error,
  });
  return {};
});

const DRIVER_KIND = ProviderDriverKind.make("claudeAgent");
const SNAPSHOT_REFRESH_INTERVAL = Duration.minutes(5);

export type ClaudeDriverEnv =
  | ChildProcessSpawner.ChildProcessSpawner
  | FileSystem.FileSystem
  | Path.Path
  | ProviderEventLoggers
  | ServerConfig;

const withInstanceIdentity =
  (input: {
    readonly instanceId: ProviderInstance["instanceId"];
    readonly displayName: string | undefined;
    readonly accentColor: string | undefined;
    readonly continuationGroupKey: string;
  }) =>
  (snapshot: ServerProviderDraft): ServerProvider => ({
    ...snapshot,
    instanceId: input.instanceId,
    driver: DRIVER_KIND,
    ...(input.displayName ? { displayName: input.displayName } : {}),
    ...(input.accentColor ? { accentColor: input.accentColor } : {}),
    continuation: { groupKey: input.continuationGroupKey },
  });

export const ClaudeDriver: ProviderDriver<ClaudeSettings, ClaudeDriverEnv> = {
  driverKind: DRIVER_KIND,
  metadata: {
    displayName: "Claude",
    supportsMultipleInstances: true,
  },
  configSchema: ClaudeSettings,
  defaultConfig: (): ClaudeSettings => Schema.decodeSync(ClaudeSettings)({}),
  create: ({ instanceId, displayName, accentColor, environment, enabled, config }) =>
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const path = yield* Path.Path;
      const serverCwd = (yield* ServerConfig).cwd;
      const eventLoggers = yield* ProviderEventLoggers;
      const processEnv = mergeProviderInstanceEnvironment(environment);
      const fallbackContinuationIdentity = defaultProviderContinuationIdentity({
        driverKind: DRIVER_KIND,
        instanceId,
      });
      const effectiveConfig = { ...config, enabled } satisfies ClaudeSettings;
      const continuationGroupKey = yield* makeClaudeContinuationGroupKey(effectiveConfig);
      const stampIdentity = withInstanceIdentity({
        instanceId,
        displayName,
        accentColor,
        continuationGroupKey,
      });

      const launchArgs = yield* resolveClaudeOneOffLaunchArgs(
        effectiveConfig.launchArgs,
        instanceId,
      );
      const adapter = yield* makeClaudeAdapter({
        ...(eventLoggers.native ? { nativeEventLogger: eventLoggers.native } : {}),
        oneOffProviderOptions: {
          binaryPath: effectiveConfig.binaryPath,
          launchArgs,
        },
        processEnvironment: yield* makeClaudeEnvironment(effectiveConfig, processEnv),
      });
      const textGeneration = yield* makeClaudeTextGeneration(effectiveConfig, processEnv);

      // Per-instance capabilities cache: keyed on binary + resolved HOME so
      // account-specific probes never share auth metadata across instances.
      const probes = yield* makeClaudeInstanceProbes(effectiveConfig, processEnv, {
        cwd: serverCwd,
      });
      const accountUsage = yield* makeAccountUsageCapability(
        {
          key: `claude:${instanceId}`,
          provider: "claudeAgent",
          providerInstanceId: instanceId,
          displayName: displayName ?? "Claude",
          enabled,
          refreshState: "idle",
          sections: [emptyAccountSection("claude-usage")],
        },
        probes.usage.pipe(
          Effect.map((data) => {
            const fetchedAt = new Date().toISOString();
            return [
              {
                kind: "claude-usage" as const,
                outcome: "available" as const,
                lastAttemptAt: fetchedAt,
                errorCode: null,
                snapshot: { fetchedAt, data },
              },
            ];
          }),
        ),
        { readerOwnsTimeout: true },
      );

      const checkProvider = checkClaudeProviderStatus(
        effectiveConfig,
        () => probes.capabilities,
        processEnv,
      ).pipe(
        Effect.map(stampIdentity),
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        Effect.provideService(Path.Path, path),
      );

      const snapshot = yield* makeManagedServerProvider<ClaudeSettings>({
        getSettings: Effect.succeed(effectiveConfig),
        streamSettings: Stream.never,
        haveSettingsChanged: () => false,
        initialSnapshot: (settings) => stampIdentity(makePendingClaudeProvider(settings)),
        checkProvider,
        refreshInterval: SNAPSHOT_REFRESH_INTERVAL,
      }).pipe(
        Effect.mapError(
          (cause) =>
            new ProviderDriverError({
              driver: DRIVER_KIND,
              instanceId,
              detail: `Failed to build Claude snapshot: ${cause.message ?? String(cause)}`,
              cause,
            }),
        ),
      );

      return {
        instanceId,
        driverKind: DRIVER_KIND,
        continuationIdentity: {
          ...fallbackContinuationIdentity,
          continuationKey: continuationGroupKey,
        },
        displayName,
        accentColor,
        enabled,
        snapshot,
        adapter,
        textGeneration,
        accountUsage,
      } satisfies ProviderInstance;
    }),
};
