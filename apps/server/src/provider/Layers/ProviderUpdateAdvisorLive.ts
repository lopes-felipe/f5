import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as Path from "node:path";
import type {
  ProviderInstanceId,
  ProviderSession,
  ServerProvider,
  ServerProviderAdvisoryEntry,
  ServerProviderVersionAdvisory,
} from "@t3tools/contracts";
import {
  Cause,
  Deferred,
  Duration,
  Effect,
  Exit,
  Layer,
  PubSub,
  Ref,
  Schema,
  Stream,
} from "effect";
import * as Semaphore from "effect/Semaphore";
import { HttpClient } from "effect/unstable/http";
import { ServerConfig } from "../../config.ts";
import { runProcess } from "../../processRunner.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { clearCommandResolutionCache } from "../../spawn/resolveCommand.ts";
import {
  buildProviderUpdateCommand,
  canRunInApp,
  type ProviderInstallTarget,
} from "../providerInstallChannel.ts";
import type { ProviderInstance } from "../ProviderDriver.ts";
import { withProviderThreadAccess } from "../providerThreadAccess.ts";
import { ProviderInstanceRegistry } from "../Services/ProviderInstanceRegistry.ts";
import { ProviderRegistry } from "../Services/ProviderRegistry.ts";
import { ProviderService } from "../Services/ProviderService.ts";
import {
  ProviderUpdateAdvisor,
  ProviderUpdateRunError,
  type ProviderUpdateAdvisorShape,
  type ProviderUpdateRunResult,
} from "../Services/ProviderUpdateAdvisor.ts";
import {
  compareProviderVersions,
  extractProviderVersion,
  lookupLatestVersion,
  makeUnknownProviderVersionAdvisory,
  type LatestVersionLookupFailure,
  type ProviderUpdateProcessRunner,
} from "../providerUpdateLookup.ts";

const SUCCESS_REFRESH_INTERVAL_MS = 6 * 60 * 60 * 1000;
const EXPLICIT_SUCCESS_TTL_MS = 60_000;

interface SourceCacheEntry {
  readonly lastSuccess?: { readonly latestVersion: string; readonly checkedAt: number };
  readonly lastFailure?: {
    readonly at: number;
    readonly message: string;
    readonly retryAt?: number;
  };
  readonly nextEligibleAt: number;
  readonly consecutiveFailures: number;
}
interface Flight {
  readonly target: ProviderInstallTarget;
  readonly previousVersion: string;
  readonly installKey: string;
  readonly affectedIds: readonly ProviderInstanceId[];
  readonly startedAt: string;
  readonly targetVersion: string;
  readonly deferred: Deferred.Deferred<ProviderUpdateRunResult, ProviderUpdateRunError>;
}

export function failureRetryDelayMs(
  failure: LatestVersionLookupFailure,
  consecutiveFailuresBefore: number,
): number {
  switch (failure._tag) {
    case "rate_limited":
      return Math.max(
        Math.min(24 * 60 * 60 * 1000, 30 * 60 * 1000 * 2 ** Math.min(consecutiveFailuresBefore, 8)),
        failure.retryAfterMs ?? 0,
      );
    case "network":
      return 30 * 60 * 1000;
    case "not_found":
      return 24 * 60 * 60 * 1000;
    case "parse":
      return 6 * 60 * 60 * 1000;
  }
}

export function hasAdvisoryStateChanged(
  previous: ServerProviderVersionAdvisory | undefined,
  next: ServerProviderVersionAdvisory,
): boolean {
  return JSON.stringify(previous) !== JSON.stringify(next);
}

export function nextProviderUpdateCheckDelay(
  entries: Iterable<SourceCacheEntry>,
  now = Date.now(),
): number {
  const times = [...entries].map((entry) => entry.nextEligibleAt);
  return Math.max(1000, times.length ? Math.min(...times) - now : SUCCESS_REFRESH_INTERVAL_MS);
}

function installerEnvironment(
  executable: string,
  environment: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  const env = { ...environment };
  const pathKey = Object.keys(env).find((key) => key.toUpperCase() === "PATH") ?? "PATH";
  env[pathKey] = Path.dirname(executable) + Path.delimiter + (env[pathKey] ?? "");
  for (const key of Object.keys(env))
    if (key.toUpperCase() === "F5_PROFILE_ISOLATED") delete env[key];
  return env;
}

function hasActiveWork(session: ProviderSession): boolean {
  return session.status === "running" || session.status === "connecting" || !!session.activeTurnId;
}
function updateRunError(cause: Cause.Cause<unknown>, fallback: string): ProviderUpdateRunError {
  const error = Cause.squash(cause);
  return Schema.is(ProviderUpdateRunError)(error)
    ? error
    : new ProviderUpdateRunError({
        message: Cause.hasInterrupts(cause)
          ? "Provider update cancelled by server shutdown."
          : fallback,
      });
}

export const makeProviderUpdateAdvisor = (
  options: {
    readonly runProcess?: ProviderUpdateProcessRunner;
    readonly platform?: NodeJS.Platform;
  } = {},
) =>
  Effect.gen(function* () {
    const providerRegistry = yield* ProviderRegistry;
    const instanceRegistry = yield* ProviderInstanceRegistry;
    const providerService = yield* ProviderService;
    const serverConfig = yield* ServerConfig;
    const settings = yield* ServerSettingsService;
    const httpClient = yield* HttpClient.HttpClient;
    const scope = yield* Effect.scope;
    const runner = options.runProcess ?? runProcess;
    const platform = options.platform ?? process.platform;
    const workDir = yield* Effect.acquireRelease(
      Effect.promise(() => mkdtemp(Path.join(tmpdir(), "f5-provider-update-"))),
      (dir) => Effect.promise(() => rm(dir, { recursive: true, force: true })),
    );
    const targetsRef = yield* Ref.make(new Map<ProviderInstanceId, ProviderInstallTarget | null>());
    const cacheRef = yield* Ref.make(new Map<string, SourceCacheEntry>());
    const inFlightRef = yield* Ref.make<Flight | null>(null);
    const lastPublishedRef = yield* Ref.make(
      new Map<ProviderInstanceId, ServerProviderVersionAdvisory>(),
    );
    const targetSemaphore = yield* Semaphore.make(1);
    const sourceSemaphores = new Map<string, Semaphore.Semaphore>();
    const registryCache = new Map<string, { publicRegistry: boolean; at: number }>();
    const lastInstancesRef = yield* Ref.make<readonly ProviderInstance[]>([]);
    const reconciliationRunning = yield* Ref.make(false);
    const changes = yield* Effect.acquireRelease(
      PubSub.unbounded<readonly ServerProviderAdvisoryEntry[]>(),
      PubSub.shutdown,
    );
    const schedulerWake = yield* Effect.acquireRelease(PubSub.unbounded<void>(), PubSub.shutdown);
    const wakeSubscription = yield* PubSub.subscribe(schedulerWake);
    let automaticChecks = false;

    // Target I/O is separate from release lookups and never runs on the status push path.
    const resolveTargets = (freshRegistry = false) =>
      Effect.gen(function* () {
        const instances = yield* instanceRegistry.listInstances;
        const next = new Map<ProviderInstanceId, ProviderInstallTarget | null>();
        const passRegistries = new Map<string, boolean>();
        for (const instance of instances) {
          const detected = yield* Effect.try({
            try: () => instance.resolveInstallTarget?.() ?? null,
            catch: () => null,
          }).pipe(Effect.orElseSucceed(() => null));
          let target = detected;
          if (target?.channel === "npm" && target.npm) {
            const { prefix, npmPath, pkg } = target.npm;
            const key = createHash("sha256")
              .update(
                JSON.stringify([
                  npmPath,
                  prefix,
                  pkg,
                  target.realPath,
                  Object.entries(target.updateEnvironment).sort(([a], [b]) => a.localeCompare(b)),
                ]),
              )
              .digest("hex");
            let publicRegistry = passRegistries.get(key);
            const cached = registryCache.get(key);
            if (
              publicRegistry === undefined &&
              !freshRegistry &&
              cached &&
              Date.now() - cached.at < 300_000
            )
              publicRegistry = cached.publicRegistry;
            if (publicRegistry === undefined) {
              const env = installerEnvironment(npmPath, {
                ...target.updateEnvironment,
                NPM_CONFIG_PREFIX: prefix,
              });
              const readRegistry = (name: string) =>
                Effect.tryPromise(() =>
                  runner(npmPath, ["config", "get", name], {
                    env,
                    cwd: workDir,
                    timeoutMs: 5000,
                    stdin: "",
                    allowNonZeroExit: true,
                    maxBufferBytes: 16 * 1024,
                  }),
                ).pipe(
                  Effect.map((result) =>
                    result.code === 0 && !result.timedOut ? result.stdout.trim() : null,
                  ),
                  Effect.orElseSucceed(() => null),
                );
              // npm resolves scoped packages through <scope>:registry before the global registry.
              const packageScope = pkg.startsWith("@") ? pkg.split("/")[0] : undefined;
              let registry = packageScope
                ? yield* readRegistry(`${packageScope}:registry`)
                : "undefined";
              if (registry === "undefined" || registry === "null" || registry === "")
                registry = yield* readRegistry("registry");
              publicRegistry = registry?.replace(/\/+$/, "") === "https://registry.npmjs.org";
              registryCache.set(key, { publicRegistry, at: Date.now() });
            }
            passRegistries.set(key, publicRegistry);
            if (!publicRegistry)
              target = {
                ...target,
                channel: "unmanaged",
                blockedReason: "custom_registry",
                guidance:
                  "F5 only automates the public npm registry. Update this installation using its configured registry, then refresh and verify.",
              };
          }
          next.set(instance.instanceId, target);
        }
        yield* Ref.set(targetsRef, next);
        yield* Ref.set(lastInstancesRef, instances);
        return next;
      });

    const getAdvisoryFor: ProviderUpdateAdvisorShape["getAdvisoryFor"] = (input) =>
      Effect.gen(function* () {
        const targets = yield* Ref.get(targetsRef);
        const flight = yield* Ref.get(inFlightRef);
        const active = flight?.affectedIds.includes(input.instanceId) ? flight : null;
        const target = active?.target ?? targets.get(input.instanceId);
        const currentVersion =
          extractProviderVersion(input.driver, input.currentVersion) ??
          active?.previousVersion ??
          null;
        if (!target) return makeUnknownProviderVersionAdvisory({ currentVersion });
        const entry = target.sourceKey
          ? (yield* Ref.get(cacheRef)).get(target.sourceKey)
          : undefined;
        const latestVersion = entry?.lastSuccess?.latestVersion ?? null;
        const behind =
          currentVersion && latestVersion
            ? compareProviderVersions(latestVersion, currentVersion) > 0
            : false;
        const command = latestVersion
          ? buildProviderUpdateCommand(target, platform, latestVersion)
          : null;
        const blockedReason =
          target.blockedReason ??
          (platform === "win32"
            ? "windows"
            : serverConfig.profile && !serverConfig.profile.isDefault
              ? "isolated_profile"
              : undefined);
        const common = {
          currentVersion,
          latestVersion,
          checkedAt: entry?.lastSuccess
            ? new Date(entry.lastSuccess.checkedAt).toISOString()
            : null,
          updateCommand: behind ? command : null,
          installChannel: target.channel,
          executablePath: target.executablePath,
          installKey: createHash("sha256").update(target.installKey).digest("hex"),
          updateAvailable: !!behind,
          canRunUpdate:
            !!behind &&
            !entry?.lastFailure &&
            !!command &&
            canRunInApp(target, platform, serverConfig.profile),
          ...(blockedReason ? { blockedReason } : {}),
          sharedWith: [...targets]
            .filter(
              ([id, other]) => id !== input.instanceId && other?.installKey === target.installKey,
            )
            .map(([id]) => id),
          activeUpdate: flight?.affectedIds.includes(input.instanceId)
            ? { startedAt: flight.startedAt, targetVersion: flight.targetVersion }
            : null,
        } satisfies Partial<ServerProviderVersionAdvisory>;
        if (target.channel === "bundled" && currentVersion)
          return {
            ...common,
            status: "bundled",
            updateCommand: null,
            canRunUpdate: false,
            message: behind
              ? `Bundled with F5. Claude Code v${latestVersion} ships with a future F5 release.`
              : "Bundled with F5.",
          };
        if (entry?.lastFailure)
          return {
            ...common,
            status: "check_failed",
            message: entry.lastFailure.message,
            failedAt: new Date(entry.lastFailure.at).toISOString(),
            ...(entry.lastFailure.retryAt
              ? { retryAt: new Date(entry.lastFailure.retryAt).toISOString() }
              : {}),
          };
        if (behind && !command) return { ...common, status: "manual", message: target.guidance };
        if (!currentVersion || !latestVersion)
          return {
            ...common,
            status: "unknown",
            message: target.latestSource ? null : target.guidance,
          };
        return {
          ...common,
          status: behind ? "behind_latest" : "current",
          updateCommand: behind ? command : null,
          message: behind ? `Installed v${currentVersion} · latest v${latestVersion}` : null,
        };
      });

    const publish = Effect.gen(function* () {
      const providers = yield* providerRegistry.getProviders;
      const entries = yield* Effect.forEach(providers, (provider) =>
        getAdvisoryFor({
          instanceId: provider.instanceId,
          driver: provider.driver,
          currentVersion: provider.version,
        }).pipe(
          Effect.map((versionAdvisory) => ({
            instanceId: provider.instanceId,
            driver: provider.driver,
            versionAdvisory,
          })),
        ),
      );
      const visible = entries.filter((entry) => entry.versionAdvisory.status !== "unknown");
      const previous = yield* Ref.get(lastPublishedRef);
      const next = new Map(visible.map((entry) => [entry.instanceId, entry.versionAdvisory]));
      if (
        previous.size !== next.size ||
        visible.some((entry) =>
          hasAdvisoryStateChanged(previous.get(entry.instanceId), entry.versionAdvisory),
        )
      ) {
        yield* Ref.set(lastPublishedRef, next);
        yield* PubSub.publish(changes, visible);
      }
    });

    const refreshSource = (
      target: ProviderInstallTarget,
      explicit: boolean,
      cacheAtRequest: ReadonlyMap<string, SourceCacheEntry>,
    ) =>
      Effect.gen(function* () {
        if (!target.sourceKey || !target.latestSource) return;
        const now = Date.now();
        const previous = (yield* Ref.get(cacheRef)).get(target.sourceKey);
        // A queued caller shares any attempt completed since it requested this pass, including failures.
        if (previous !== cacheAtRequest.get(target.sourceKey)) return;
        if (previous) {
          if (explicit) {
            if ((previous.lastFailure?.retryAt ?? 0) > now) return;
            if (
              previous.lastSuccess &&
              now - previous.lastSuccess.checkedAt < EXPLICIT_SUCCESS_TTL_MS
            )
              return;
          } else if (previous.nextEligibleAt > now) return;
        }
        const result = yield* lookupLatestVersion(target.latestSource, {
          runProcess: runner,
          environment: target.updateEnvironment,
          cwd: workDir,
        }).pipe(Effect.provideService(HttpClient.HttpClient, httpClient));
        const checkedAt = Date.now();
        let entry: SourceCacheEntry;
        if (result._tag === "success")
          entry = {
            lastSuccess: { latestVersion: result.latestVersion, checkedAt },
            consecutiveFailures: 0,
            nextEligibleAt: checkedAt + SUCCESS_REFRESH_INTERVAL_MS,
          };
        else {
          const retryDelayMs = failureRetryDelayMs(
            result.failure,
            previous?.consecutiveFailures ?? 0,
          );
          entry = {
            ...(previous?.lastSuccess ? { lastSuccess: previous.lastSuccess } : {}),
            lastFailure: {
              at: checkedAt,
              message:
                result.failure._tag === "rate_limited"
                  ? "Update check rate limited. Try again after the retry time."
                  : `Could not check for provider updates (${result.failure._tag}).`,
              ...(result.failure._tag === "rate_limited" &&
              result.failure.retryAfterMs !== undefined
                ? { retryAt: checkedAt + result.failure.retryAfterMs }
                : {}),
            },
            consecutiveFailures: (previous?.consecutiveFailures ?? 0) + 1,
            nextEligibleAt: checkedAt + retryDelayMs,
          };
          yield* Effect.logWarning("provider latest-version lookup failed", {
            source: target.latestSource.kind,
            failure: result.failure._tag,
            retryDelayMs,
          });
        }
        yield* Ref.update(cacheRef, (cache) => new Map(cache).set(target.sourceKey!, entry));
      });

    const refreshAdvisories: ProviderUpdateAdvisorShape["refreshAdvisories"] = (opts) =>
      Effect.gen(function* () {
        const cacheAtRequest = yield* Ref.get(cacheRef);
        const explicit = opts?.mode === "explicit" || opts?.force === true;
        const targets = yield* targetSemaphore.withPermits(1)(resolveTargets(explicit));
        if (explicit || automaticChecks) {
          const sources = new Map<string, ProviderInstallTarget>();
          for (const [id, target] of targets)
            if (target?.sourceKey && (!opts?.instanceId || id === opts.instanceId))
              sources.set(target.sourceKey, target);
          yield* Effect.forEach(
            sources,
            ([key, target]) => {
              const semaphore = sourceSemaphores.get(key) ?? Semaphore.makeUnsafe(1);
              sourceSemaphores.set(key, semaphore);
              return semaphore.withPermits(1)(refreshSource(target, explicit, cacheAtRequest));
            },
            { concurrency: "unbounded", discard: true },
          );
        }
        yield* publish;
        if (explicit) yield* PubSub.publish(schedulerWake, undefined);
      });

    const sameInstances = (
      previous: readonly ProviderInstance[],
      next: readonly ProviderInstance[],
    ) =>
      previous.length === next.length &&
      previous.every((instance, index) => instance === next[index]);
    const noteRegistryChanged: ProviderUpdateAdvisorShape["noteRegistryChanged"] = Effect.gen(
      function* () {
        yield* publish;
        const instances = yield* instanceRegistry.listInstances;
        if (sameInstances(yield* Ref.get(lastInstancesRef), instances)) return;
        if (yield* Ref.getAndSet(reconciliationRunning, true)) return;
        yield* targetSemaphore
          .withPermits(1)(
            Effect.gen(function* () {
              if (
                sameInstances(
                  yield* Ref.get(lastInstancesRef),
                  yield* instanceRegistry.listInstances,
                )
              )
                return;
              yield* resolveTargets();
              yield* publish;
              yield* PubSub.publish(schedulerWake, undefined);
            }),
          )
          .pipe(
            Effect.ensuring(Ref.set(reconciliationRunning, false)),
            Effect.andThen(Effect.suspend(() => noteRegistryChanged)),
            Effect.catchCause(() =>
              Effect.logWarning("provider update target reconciliation failed"),
            ),
            Effect.forkIn(scope),
          );
      },
    );

    const refreshAffected = (ids: readonly ProviderInstanceId[]) =>
      Effect.gen(function* () {
        clearCommandResolutionCache();
        for (const id of ids)
          if (yield* instanceRegistry.getInstance(id)) yield* providerRegistry.refreshInstance(id);
      });

    const affectedSessions = (ids: readonly ProviderInstanceId[]) =>
      providerService
        .listSessions()
        .pipe(
          Effect.map((sessions) =>
            sessions.filter((session) =>
              ids.some((id) => id === (session.providerInstanceId ?? session.provider)),
            ),
          ),
        );
    const stopIdleSessions = (flight: Flight, providerName: string) =>
      Effect.gen(function* () {
        const busy = () =>
          new ProviderUpdateRunError({
            message: `${providerName} has active work. Finish or stop it before updating.`,
          });
        const sessions = yield* affectedSessions(flight.affectedIds);
        if (sessions.some(hasActiveWork)) return yield* busy();
        for (const session of sessions)
          yield* withProviderThreadAccess(
            session.threadId,
            Effect.gen(function* () {
              // The thread lock is shared with turn submission and is reentrant for stopSession.
              const current = (yield* affectedSessions(flight.affectedIds)).find(
                (candidate) => candidate.threadId === session.threadId,
              );
              if (!current) return;
              if (hasActiveWork(current)) return yield* busy();
              yield* providerService.stopSession({ threadId: current.threadId }).pipe(
                Effect.mapError(
                  () =>
                    new ProviderUpdateRunError({
                      message: `Could not stop an idle ${providerName} session. The update was cancelled; retry after checking the provider status.`,
                    }),
                ),
              );
            }),
          );
        if ((yield* affectedSessions(flight.affectedIds)).some(hasActiveWork)) return yield* busy();
      });

    const worker = (
      flight: Flight,
      instanceId: ProviderInstanceId,
      target: ProviderInstallTarget,
      previousVersion: string,
      providerName: string,
    ) =>
      Effect.gen(function* () {
        yield* Effect.logInfo("provider update started", { instanceId, channel: target.channel });
        const command = buildProviderUpdateCommand(target, platform, flight.targetVersion)!;
        let verificationStartedAt = "";
        let beforeVerification: ServerProvider | undefined;
        const verifyAfterAttempt = Effect.gen(function* () {
          verificationStartedAt = new Date().toISOString();
          beforeVerification = (yield* providerRegistry.getProviders).find(
            (provider) => provider.instanceId === instanceId,
          );
          yield* refreshAffected(flight.affectedIds);
        });
        const result = yield* Effect.gen(function* () {
          yield* stopIdleSessions(flight, providerName);
          const controller = new AbortController();
          const environment: NodeJS.ProcessEnv = {
            ...target.updateEnvironment,
            ...command.env,
            NONINTERACTIVE: "1",
            HOMEBREW_NO_ENV_HINTS: "1",
            HOMEBREW_NO_INSTALL_CLEANUP: "1",
            HOMEBREW_NO_INSTALLED_DEPENDENTS_CHECK: "1",
            npm_config_update_notifier: "false",
          };
          // Capture settlement before making the wait interruptible. Shutdown waits for process-tree termination.
          const settled = Promise.resolve().then(() =>
            runner(command.executable, command.args, {
              env: installerEnvironment(command.executable, environment),
              cwd: workDir,
              stdin: "",
              timeoutMs: 600_000,
              allowNonZeroExit: true,
              outputMode: "tail",
              maxStdoutBytes: 256 * 1024,
              maxStderrBytes: 256 * 1024,
              signal: controller.signal,
            }),
          );
          return yield* Effect.tryPromise(() => settled).pipe(
            Effect.onInterrupt(() =>
              Effect.gen(function* () {
                controller.abort();
                yield* Effect.promise(() =>
                  settled.then(
                    () => undefined,
                    () => undefined,
                  ),
                );
                yield* Effect.logWarning("provider update cancelled by server shutdown", {
                  instanceId,
                  channel: target.channel,
                });
              }),
            ),
          );
        }).pipe(Effect.result, Effect.ensuring(verifyAfterAttempt));
        if (result._tag === "Failure" && Schema.is(ProviderUpdateRunError)(result.failure))
          return yield* new ProviderUpdateRunError({ message: result.failure.message });
        const snapshot = (yield* providerRegistry.getProviders).find(
          (provider) => provider.instanceId === instanceId,
        );
        const currentVersion = snapshot
          ? extractProviderVersion(snapshot.driver, snapshot.version)
          : null;
        const verified =
          snapshot &&
          snapshot !== beforeVerification &&
          Date.parse(snapshot.checkedAt) >= Date.parse(verificationStartedAt) &&
          snapshot.probeOutcome === "success" &&
          currentVersion;
        const processResult = result._tag === "Success" ? result.success : null;
        let outcome: ProviderUpdateRunResult["outcome"] = "failed";
        if (processResult?.code === 0 && !processResult.timedOut && !processResult.aborted) {
          outcome = !verified
            ? "unverified"
            : compareProviderVersions(currentVersion!, previousVersion) > 0
              ? target.channel === "npm" && currentVersion !== flight.targetVersion
                ? "unexpected_version"
                : "updated"
              : "unchanged";
        }
        const response: ProviderUpdateRunResult = {
          instanceId,
          outcome,
          previousVersion,
          currentVersion,
          exitCode: processResult?.code ?? null,
          timedOut: processResult?.timedOut ?? false,
          output: processResult
            ? `${processResult.stdout}\n${processResult.stderr}`
            : "The provider update could not start. Check that the installer is available and idle sessions can stop.",
          outputTruncated: !!(processResult?.stdoutTruncated || processResult?.stderrTruncated),
        };
        yield* Effect.logInfo("provider update finished", {
          instanceId,
          outcome,
          exitCode: response.exitCode,
          channel: target.channel,
        });
        return response;
      }).pipe(
        Effect.onExit((exit) => {
          const completed = Exit.isSuccess(exit)
            ? Exit.succeed(exit.value)
            : Exit.fail(
                updateRunError(
                  exit.cause,
                  "Provider update failed unexpectedly. Check the provider status before retrying.",
                ),
              );
          return Ref.update(inFlightRef, (active) => (active === flight ? null : active)).pipe(
            Effect.andThen(targetSemaphore.withPermits(1)(resolveTargets())),
            Effect.andThen(publish),
            Effect.andThen(refreshAdvisories().pipe(Effect.forkIn(scope))),
            // onExit finalizers cannot be interrupted, including this completion on shutdown.
            Effect.ensuring(Deferred.done(flight.deferred, completed)),
          );
        }),
        Effect.asVoid,
      );

    const runUpdate: ProviderUpdateAdvisorShape["runUpdate"] = (instanceId) =>
      Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          let instance = yield* instanceRegistry.getInstance(instanceId);
          if (!instance)
            return yield* new ProviderUpdateRunError({ message: "Provider instance not found." });
          const active = yield* Ref.get(inFlightRef);
          const cachedTarget = (yield* Ref.get(targetsRef)).get(instanceId);
          if (
            active &&
            (active.affectedIds.includes(instanceId) ||
              cachedTarget?.installKey === active.installKey)
          )
            return yield* restore(Deferred.await(active.deferred));
          if (active)
            return yield* new ProviderUpdateRunError({
              message: "Another provider update is already running.",
            });
          // Rebuild the physical target and refresh stale metadata before accepting an installation request.
          yield* restore(refreshAdvisories({ mode: "explicit", instanceId }));
          instance = yield* instanceRegistry.getInstance(instanceId);
          if (!instance)
            return yield* new ProviderUpdateRunError({ message: "Provider instance not found." });
          const targets = yield* Ref.get(targetsRef);
          const target = targets.get(instanceId);
          const existing = yield* Ref.get(inFlightRef);
          if (existing) {
            if (target?.installKey === existing.installKey)
              return yield* restore(Deferred.await(existing.deferred));
            return yield* new ProviderUpdateRunError({
              message: "Another provider update is already running.",
            });
          }
          if (serverConfig.profile && !serverConfig.profile.isDefault)
            return yield* new ProviderUpdateRunError({
              message: "Run provider updates from the Default profile.",
            });
          if (!target || !canRunInApp(target, platform, serverConfig.profile))
            return yield* new ProviderUpdateRunError({
              message: "F5 can't update this installation automatically.",
            });
          const snapshot = (yield* providerRegistry.getProviders).find(
            (provider) => provider.instanceId === instanceId,
          );
          if (!instance.enabled || !snapshot?.enabled || !snapshot.installed)
            return yield* new ProviderUpdateRunError({
              message: "Enable and install this provider before updating.",
            });
          const currentVersion = extractProviderVersion(instance.driverKind, snapshot.version);
          const entry = target.sourceKey
            ? (yield* Ref.get(cacheRef)).get(target.sourceKey)
            : undefined;
          const latestVersion = entry?.lastSuccess?.latestVersion;
          if (!currentVersion || !latestVersion || entry?.lastFailure)
            return yield* new ProviderUpdateRunError({
              message: "Could not verify an available update. Check for updates and try again.",
            });
          if (compareProviderVersions(latestVersion, currentVersion) <= 0)
            return yield* new ProviderUpdateRunError({ message: "Already up to date." });
          const deferred = yield* Deferred.make<ProviderUpdateRunResult, ProviderUpdateRunError>();
          const affectedIds = [...targets]
            .filter(([, candidate]) => candidate?.installKey === target.installKey)
            .map(([id]) => id);
          if (!affectedIds.includes(instanceId)) affectedIds.push(instanceId);
          const flight: Flight = {
            target,
            previousVersion: currentVersion,
            installKey: target.installKey,
            affectedIds,
            deferred,
            startedAt: new Date().toISOString(),
            targetVersion: latestVersion,
          };
          const claimed = yield* Ref.modify(
            inFlightRef,
            (active): readonly [Flight | null, Flight | null] =>
              active ? [active, active] : [null, flight],
          );
          if (claimed) {
            if (claimed.installKey === target.installKey)
              return yield* restore(Deferred.await(claimed.deferred));
            return yield* new ProviderUpdateRunError({
              message: "Another provider update is already running.",
            });
          }
          let workerStarted = false;
          yield* Effect.gen(function* () {
            if ((yield* affectedSessions(affectedIds)).some(hasActiveWork))
              return yield* new ProviderUpdateRunError({
                message: `${instance.displayName ?? instance.driverKind} has active work. Finish or stop it before updating.`,
              });
            yield* publish;
            yield* worker(
              flight,
              instanceId,
              target,
              currentVersion,
              instance.displayName ?? instance.driverKind,
            ).pipe(Effect.interruptible, Effect.forkIn(scope));
            workerStarted = true;
          }).pipe(
            Effect.onExit((exit) => {
              if (workerStarted) return Effect.void;
              const error = Exit.isFailure(exit)
                ? updateRunError(exit.cause, "Provider update admission failed. Please try again.")
                : new ProviderUpdateRunError({ message: "Provider update did not start." });
              return Ref.update(inFlightRef, (active) => (active === flight ? null : active)).pipe(
                Effect.andThen(Deferred.fail(deferred, error)),
              );
            }),
          );
          return yield* restore(Deferred.await(deferred));
        }),
      );

    const initial = yield* settings.getSettings.pipe(
      Effect.catch(() => Effect.succeed({ enableProviderUpdateChecks: true })),
    );
    automaticChecks = initial.enableProviderUpdateChecks;
    yield* targetSemaphore.withPermits(1)(resolveTargets());
    yield* Stream.runForEach(settings.streamChanges, (next) =>
      Effect.gen(function* () {
        automaticChecks = next.enableProviderUpdateChecks;
        yield* PubSub.publish(schedulerWake, undefined);
      }),
    ).pipe(Effect.forkIn(scope));
    yield* Effect.gen(function* () {
      yield* Effect.raceFirst(Effect.sleep(Duration.seconds(5)), PubSub.take(wakeSubscription));
      while (true) {
        yield* PubSub.takeUpTo(wakeSubscription, Number.POSITIVE_INFINITY);
        if (automaticChecks) yield* refreshAdvisories();
        const cache = yield* Ref.get(cacheRef);
        const targets = yield* Ref.get(targetsRef);
        const keys = new Set(
          [...targets.values()].flatMap((target) => (target?.sourceKey ? [target.sourceKey] : [])),
        );
        const delay = automaticChecks
          ? nextProviderUpdateCheckDelay(
              [...cache].filter(([key]) => keys.has(key)).map(([, entry]) => entry),
            )
          : SUCCESS_REFRESH_INTERVAL_MS;
        yield* Effect.raceFirst(
          Effect.sleep(Duration.millis(delay)),
          PubSub.take(wakeSubscription),
        );
      }
    }).pipe(Effect.forkIn(scope));

    return {
      getAdvisoryFor,
      streamChanges: Stream.fromPubSub(changes),
      noteRegistryChanged,
      refreshAdvisories,
      runUpdate,
    } satisfies ProviderUpdateAdvisorShape;
  });

export const ProviderUpdateAdvisorLive = Layer.effect(
  ProviderUpdateAdvisor,
  makeProviderUpdateAdvisor(),
);
