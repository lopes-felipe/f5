import { beginAccountChange } from "./ProviderAccountGuard.ts";
import { createAntigravityAccountProcess } from "./AntigravityAccountProcess.ts";
import {
  antigravityAuthConfig,
  antigravityReadiness,
  isAntigravityAuthMethodExposed,
} from "../provider/antigravityAuthSupport.ts";
import { antigravityProfileDirectory } from "../provider/acp/AntigravityAcpSupport.ts";
import {
  isProviderSecretUnavailable,
  PROVIDER_SECRET_UNAVAILABLE,
} from "../serverSettingsSecrets.ts";
import { PROVIDER_INSTANCE_SECRET_FIELDS } from "@t3tools/shared/serverSettings";
import * as Path from "node:path";
import { randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { cursorConfigDir } from "../provider/cursor/CursorNativeSessions.ts";
import { Effect, Schema } from "effect";
import {
  AntigravitySettings,
  ClaudeSettings,
  CodexSettings,
  CursorSettings,
  type ProviderInstanceConfig,
  type ProviderInstanceId,
  type ProviderAccountEvent,
  type ServerSettings,
} from "@t3tools/contracts";
import type { ServerConfigShape } from "../config";
import { terminalOwnerKey, type TerminalManagerShape } from "../terminal/Services/Manager";
import type { PtyProcess } from "../terminal/Services/PTY";
import type { ServerSettingsShape } from "../serverSettings";
import { deriveProviderInstanceConfigMap } from "../provider/Layers/ProviderInstanceRegistryHydration";
import { buildAccountExecutionEnvironment } from "../providerProcessEnv";
import {
  claudeCliSpawnEnvironment,
  resolveClaudeCliInvocation,
} from "../provider/claudeSdkExecutable";
import { resolveCodexCommand } from "../provider/codexExecutable.ts";
import { resolveInvocation } from "../spawn/resolveCommand";
import { makeClaudeProcessEnvironment } from "../provider/Drivers/ClaudeHome";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { acquireInstanceLock } from "./InstanceLock";
import { isProfilePortBindable } from "./ProfileRegistryStore";
import { runProcess } from "../processRunner";

import { validateManagedHome, validateProviderCompatibility } from "./providerIsolation";
import { cliAccountStrategy, isCliAccountDriver } from "./providerAccountStrategy";

/** Closes admission on every instance, or on none if any is busy changing. */
function beginAccountChanges(
  stateDir: string,
  instanceIds: ReadonlyArray<ProviderInstanceId>,
): () => void {
  const releases: Array<() => void> = [];
  const releaseAll = () => {
    for (const release of releases.splice(0)) release();
  };
  try {
    for (const instanceId of instanceIds) releases.push(beginAccountChange(stateDir, instanceId));
  } catch (error) {
    releaseAll();
    throw error;
  }
  return releaseAll;
}

function strategyFor(driver: string) {
  if (!isCliAccountDriver(driver))
    throw new Error("This provider has no CLI account setup implementation.");
  return cliAccountStrategy(driver);
}

/**
 * The credential store a Cursor ACP instance's CLI signs in to: its effective
 * config dir (after profile and instance environment) plus the
 * `AGENT_CLI_CREDENTIAL_STORE` selection. SDK-harness instances never use the
 * CLI store and have none.
 */
export function cursorCredentialStoreKey(
  instance: ProviderInstanceConfig,
  environmentFor: (instance: ProviderInstanceConfig) => NodeJS.ProcessEnv,
): string | undefined {
  if (instance.driver !== "cursor") return undefined;
  const decoded = Schema.decodeUnknownOption(CursorSettings)(instance.config ?? {});
  if (decoded._tag === "None" || decoded.value.harness !== "acp") return undefined;
  const environment = environmentFor(instance);
  const configDir = cursorConfigDir(environment);
  let canonical = Path.resolve(configDir);
  try {
    canonical = realpathSync(configDir);
  } catch {
    // A config dir that does not exist yet is compared by its resolved path.
  }
  return JSON.stringify([canonical, environment.AGENT_CLI_CREDENTIAL_STORE?.trim() ?? ""]);
}
export async function assertOAuthPortAvailable(port: number): Promise<void> {
  if (!(await isProfilePortBindable(port)))
    throw new Error(
      `OAuth callback port ${port} is already in use by another process. Close that login or choose another callback port. F5 has not stopped the port owner.`,
    );
}

interface Job {
  owner: object;
  instanceId: ProviderInstanceId;
  process: PtyProcess;
  done: Promise<void>;
  timeout: ReturnType<typeof setTimeout>;
  /** The process has exited; teardown waits on `done` without killing it. */
  exited?: boolean;
}
export class ProviderAccountService {
  private readonly jobs = new Map<string, Job>();
  private readonly disconnectedOwners = new WeakSet<object>();
  constructor(
    private readonly config: ServerConfigShape,
    private readonly settings: ServerSettingsShape,
    private readonly terminals: TerminalManagerShape,
    private readonly emit: (event: typeof ProviderAccountEvent.Type, owner: object) => void,
    private readonly refresh: (instanceId: ProviderInstanceId) => Promise<void>,
    private readonly isBusy: (instanceId: ProviderInstanceId) => Promise<boolean>,
    private readonly stopIdleSessions: (
      instanceId: ProviderInstanceId,
    ) => Promise<void> = async () => {},
  ) {}
  async resolve(instanceId: ProviderInstanceId) {
    return ProviderAccountService.resolve(this.config, this.settings, instanceId);
  }
  static async resolve(
    serverConfig: ServerConfigShape,
    settingsService: ServerSettingsShape,
    instanceId: ProviderInstanceId,
  ) {
    const settings = await Effect.runPromise(settingsService.getSettings);
    const instance = deriveProviderInstanceConfigMap(settings)[instanceId];
    if (!instance || (instance.driver !== "codex" && instance.driver !== "claudeAgent"))
      throw new Error(
        "unsupported-isolation: this provider has no certified account setup implementation.",
      );
    const driver: "codex" | "claudeAgent" = instance.driver === "codex" ? "codex" : "claudeAgent";
    const config =
      driver === "codex"
        ? Schema.decodeUnknownSync(CodexSettings)(instance.config ?? {})
        : Schema.decodeUnknownSync(ClaudeSettings)(instance.config ?? {});
    await validateManagedHome(serverConfig, config.homePath);
    let environment = buildAccountExecutionEnvironment({
      purpose: "account",
      profile: serverConfig.profile,
      stateDir: serverConfig.stateDir,
      baseEnv: process.env,
      instance: instance.environment,
    });
    if (instance.driver === "claudeAgent")
      environment = await Effect.runPromise(
        makeClaudeProcessEnvironment(config, environment, instance.environment).pipe(
          Effect.provide(NodeServices.layer),
        ),
      );
    else if (config.homePath) environment.CODEX_HOME = config.homePath;
    await validateProviderCompatibility(
      serverConfig,
      instance.driver,
      config.binaryPath,
      environment,
    );
    const invocation = (args: string[]) =>
      instance.driver === "claudeAgent"
        ? resolveClaudeCliInvocation(config.binaryPath, args, environment)
        : resolveInvocation(
            resolveCodexCommand(config.binaryPath),
            [
              ...(serverConfig.profile?.isDefault === false
                ? ["-c", 'cli_auth_credentials_store="file"']
                : []),
              ...args,
            ],
            environment,
          );
    return { instance, driver, config, environment, invocation };
  }
  /** Account commands for any CLI-managed driver, including the Cursor CLI. */
  private async resolveCliAccount(instanceId: ProviderInstanceId) {
    const settings = await Effect.runPromise(this.settings.getSettings);
    const instance = deriveProviderInstanceConfigMap(settings)[instanceId];
    if (instance?.driver !== "cursor") return this.resolve(instanceId);
    const config = Schema.decodeUnknownSync(CursorSettings)(instance.config ?? {});
    if (config.harness !== "acp")
      throw new Error("Cursor SDK sign-in is not available in this build.");
    const environment = buildAccountExecutionEnvironment({
      purpose: "account",
      profile: this.config.profile,
      stateDir: this.config.stateDir,
      baseEnv: process.env,
      instance: instance.environment,
    });
    await validateProviderCompatibility(this.config, "cursor", config.binaryPath, environment);
    const invocation = (args: string[]) =>
      resolveInvocation(config.binaryPath || "agent", args, environment);
    return { instance, driver: "cursor" as const, environment, invocation };
  }
  /**
   * Instances that share this one's CLI credential store, this one first.
   * Cursor keeps one account per config dir and credential store, so every
   * Cursor ACP instance resolving the same store signs in and out together.
   */
  async accountPeers(instanceId: ProviderInstanceId): Promise<ProviderInstanceId[]> {
    const settings = await Effect.runPromise(this.settings.getSettings);
    const instances = deriveProviderInstanceConfigMap(settings);
    const instance = instances[instanceId];
    if (!instance || !isCliAccountDriver(instance.driver)) return [instanceId];
    if (!cliAccountStrategy(instance.driver).sharesCredentialStore) return [instanceId];
    const environmentFor = (candidate: ProviderInstanceConfig) =>
      buildAccountExecutionEnvironment({
        purpose: "account",
        profile: this.config.profile,
        stateDir: this.config.stateDir,
        baseEnv: process.env,
        instance: candidate.environment,
      });
    const store = cursorCredentialStoreKey(instance, environmentFor);
    if (store === undefined) return [instanceId];
    const peers = Object.entries(instances)
      .filter(([id]) => id !== instanceId)
      .filter(([, candidate]) => cursorCredentialStoreKey(candidate, environmentFor) === store)
      .map(([id]) => id as ProviderInstanceId);
    return [instanceId, ...peers];
  }
  private async anyBusy(instanceIds: ReadonlyArray<ProviderInstanceId>): Promise<boolean> {
    for (const instanceId of instanceIds) if (await this.isBusy(instanceId)) return true;
    return false;
  }
  private async anyPeerBusy(instanceId: ProviderInstanceId): Promise<boolean> {
    if (await this.isBusy(instanceId)) return true;
    return this.anyBusy(await this.accountPeers(instanceId));
  }
  private async refreshPeers(instanceId: ProviderInstanceId): Promise<void> {
    for (const peer of await this.accountPeers(instanceId)) await this.refresh(peer);
  }
  async status(instanceId: ProviderInstanceId) {
    const settings = await Effect.runPromise(this.settings.getSettings);
    const antigravityInstance = deriveProviderInstanceConfigMap(settings)[instanceId];
    if (antigravityInstance?.driver === "antigravity") {
      const config = Schema.decodeUnknownSync(AntigravitySettings)(
        antigravityInstance.config ?? {},
      );
      const readiness = await antigravityReadiness({
        profileDirectory: antigravityProfileDirectory(this.config.stateDir, instanceId),
        auth: antigravityAuthConfig(config),
        keyUnavailable: isProviderSecretUnavailable(
          PROVIDER_INSTANCE_SECRET_FIELDS.antigravity,
          config,
        ),
      });
      await this.refresh(instanceId);
      return {
        status: readiness.ready ? "authenticated" : "unauthenticated",
        detail: readiness.ready
          ? `Connected with ${readiness.authLabel} for this profile’s Antigravity instance.`
          : (readiness.message ?? "Install Antigravity and sign in using Settings."),
      };
    }
    const resolved = await this.resolveCliAccount(instanceId);
    const strategy = strategyFor(resolved.instance.driver);
    const command = await resolved.invocation([...strategy.statusArgs]);
    const result = await runProcess(command.file, command.args, {
      env: claudeCliSpawnEnvironment(command, resolved.environment),
      timeoutMs: 15000,
      allowNonZeroExit: true,
    });
    // Refresh the registry snapshot as well as the raw account details so the
    // badge and available actions describe the same current account.
    await this.refresh(instanceId);
    return strategy.parseStatus(result);
  }
  private async clearConfiguredCredentials(instanceId: ProviderInstanceId): Promise<void> {
    const settings = await Effect.runPromise(this.settings.getSettings);
    const instance = settings.providerInstances[instanceId];
    if (!instance?.environment?.length || !isCliAccountDriver(instance.driver)) return;
    const credentials = cliAccountStrategy(instance.driver).credentialVariables;
    const environment = instance.environment.filter(
      (entry) => !credentials.has(entry.name.toUpperCase()),
    );
    if (environment.length === instance.environment.length) return;
    await Effect.runPromise(
      this.settings.updateSettings({
        providerInstances: {
          ...settings.providerInstances,
          [instanceId]: { ...instance, environment },
        },
      }),
    );
  }
  /**
   * Sign-out for the key method deletes the stored key (an explicit clear), but only the key
   * this sign-out started with: a replacement saved meanwhile is kept. The read and write run
   * inside one settings transaction, under the account guard the caller still holds.
   */
  private async clearAntigravityKey(
    instanceId: ProviderInstanceId,
    signedOutKey: string,
  ): Promise<void> {
    const build = (settings: ServerSettings) => {
      const instance = settings.providerInstances[instanceId];
      if (
        instance?.driver !== "antigravity" ||
        !instance.config ||
        typeof instance.config !== "object"
      )
        return undefined;
      const config = instance.config as Record<string, unknown>;
      if (config.apiKey !== signedOutKey) return undefined;
      return {
        providerInstances: {
          ...settings.providerInstances,
          [instanceId]: { ...instance, config: { ...config, apiKey: "", apiKeyRedacted: false } },
        },
      };
    };
    if (this.settings.updateSettingsWith) {
      await Effect.runPromise(
        this.settings.updateSettingsWith(build, { heldAccountChanges: [instanceId] }),
      );
      return;
    }
    const patch = build(await Effect.runPromise(this.settings.getSettings));
    if (patch) await Effect.runPromise(this.settings.updateSettings(patch));
  }
  async start(
    instanceId: ProviderInstanceId,
    logout = false,
    owner: object = this,
    method: "browser" | "device-code" | "install" = "browser",
  ): Promise<{ handle: string }> {
    if (logout && (await this.anyPeerBusy(instanceId)))
      throw new Error(
        "Stop the active turns of every provider using this account before signing out.",
      );
    const settings = await Effect.runPromise(this.settings.getSettings);
    const instance = deriveProviderInstanceConfigMap(settings)[instanceId];
    const antigravity = instance?.driver === "antigravity";
    if (method === "install" && (!antigravity || logout))
      throw new Error("Installation is supported only for Antigravity setup.");
    const resolved = antigravity ? undefined : await this.resolveCliAccount(instanceId);
    // Sign-in and sign-out both change the account every peer uses.
    const sharedPeers =
      resolved && strategyFor(resolved.instance.driver).sharesCredentialStore
        ? await this.accountPeers(instanceId)
        : [];
    const readAntigravityAuth = (config: unknown) => {
      const decoded = Schema.decodeUnknownSync(AntigravitySettings)(config ?? {});
      const auth = antigravityAuthConfig(decoded);
      if (method !== "install" && !logout) {
        if (!isAntigravityAuthMethodExposed(auth.authMethod))
          throw new Error("This Antigravity sign-in method is not available in F5 yet.");
        if (
          auth.authMethod === "gemini-api-key" &&
          isProviderSecretUnavailable(PROVIDER_INSTANCE_SECRET_FIELDS.antigravity, decoded)
        )
          throw new Error(PROVIDER_SECRET_UNAVAILABLE);
        if (auth.authMethod === "gemini-api-key" && !auth.apiKey)
          throw new Error("Enter a Gemini API key in the Antigravity provider settings first.");
      }
      return auth;
    };
    // Validated early for a fast error, then read again once the account guard is held.
    let antigravityAuth = antigravity ? readAntigravityAuth(instance.config) : undefined;
    if (this.disconnectedOwners.has(owner)) throw new Error("Account connection closed.");
    const createProcess = this.terminals.createAccountProcess;
    if (!antigravity && !createProcess)
      throw new Error("Account terminals are unavailable in this runtime.");
    if (method === "device-code" && (logout || resolved?.instance.driver !== "codex")) {
      throw new Error("Device-code login is supported only for Codex sign-in.");
    }
    const root = this.config.profilesRoot;
    if (!root) throw new Error("Account setup requires the installation profilesRoot.");
    const lease = await acquireInstanceLock(
      method === "install"
        ? Path.join(this.config.stateDir, "providers", "antigravity", "install.lock.sqlite")
        : Path.join(root, "locks", "provider-oauth.lock.sqlite"),
    ).catch((error) => {
      throw new Error(
        method === "install"
          ? `Antigravity installation is already running, or its lock cannot be acquired. ${String(error)}`
          : `Another profile is signing in right now, or the OAuth lease cannot be acquired. ${String(error)}`,
      );
    });
    let releaseAccountChange = () => {};
    try {
      if (antigravity && method !== "install") {
        releaseAccountChange = beginAccountChange(this.config.stateDir, instanceId);
        // A settings save that changed the key or method either committed before this read or
        // now fails on the guard, so the child gets the stored credentials.
        const guarded = deriveProviderInstanceConfigMap(
          await Effect.runPromise(this.settings.getSettings),
        )[instanceId];
        if (guarded?.driver !== "antigravity")
          throw new Error("This Antigravity instance changed. Retry from Settings.");
        antigravityAuth = readAntigravityAuth(guarded.config);
        if (await this.isBusy(instanceId))
          throw new Error("Stop this instance's active turn before changing its account.");
        await this.stopIdleSessions(instanceId);
      } else if (sharedPeers.length > 0) {
        // Admission stays closed for every peer until the post-run refresh,
        // so no session starts on an account that is mid-change.
        releaseAccountChange = beginAccountChanges(this.config.stateDir, sharedPeers);
        if (await this.anyBusy(sharedPeers))
          throw new Error(
            "Stop the active turns of every provider using this account before changing it.",
          );
        for (const peer of sharedPeers) await this.stopIdleSessions(peer);
      }
      const callbackPort = resolved && strategyFor(resolved.instance.driver).oauthCallbackPort;
      if (!logout && method === "browser" && callbackPort)
        await assertOAuthPortAvailable(callbackPort);
      const child = antigravity
        ? createAntigravityAccountProcess({
            stateDir: this.config.stateDir,
            instanceId,
            action:
              method === "install"
                ? { type: "install" }
                : logout
                  ? { type: "disconnect" }
                  : antigravityAuth!.authMethod === "gemini-api-key"
                    ? { type: "key-connect" }
                    : { type: "oauth-connect" },
            auth: antigravityAuth!,
            environment: buildAccountExecutionEnvironment({
              purpose: "account",
              profile: this.config.profile,
              stateDir: this.config.stateDir,
              baseEnv: process.env,
              instance: instance.environment,
            }),
          })
        : await (async () => {
            const strategy = strategyFor(resolved!.instance.driver);
            const args = logout
              ? [...strategy.logoutArgs]
              : [...strategy.loginArgs(method === "device-code" ? "device-code" : "browser")];
            const command = await resolved!.invocation(args);
            return Effect.runPromise(
              createProcess!({
                shell: command.file,
                args: [...command.args],
                env: claudeCliSpawnEnvironment(command, resolved!.environment),
                cwd: this.config.stateDir,
                cols: 100,
                rows: 26,
              }),
            );
          })();
      const handle = `${terminalOwnerKey({ kind: "account", instanceId })}:${randomUUID()}`;
      let finish!: () => void;
      const done = new Promise<void>((resolve) => {
        finish = resolve;
      });
      const timeout = setTimeout(
        () => {
          void this.cancel(handle, owner);
        },
        method === "install" ? 45 * 60_000 : 600000,
      );
      const job: Job = { instanceId, process: child, done, timeout, owner };
      this.jobs.set(handle, job);
      // Tracked until `done`, which a key sign-out settles only after its settings write, so
      // disposal still waits for that write and the guard it holds.
      void done.then(() => {
        if (this.jobs.get(handle) === job) this.jobs.delete(handle);
      });
      const unsubscribe = child.onData((data) =>
        this.emit({ handle, instanceId, type: "output", data }, owner),
      );
      child.onExit((event) => {
        clearTimeout(timeout);
        unsubscribe();
        job.exited = true;
        lease.release();
        const signedOutKey =
          logout && antigravityAuth?.authMethod === "gemini-api-key" && event.exitCode === 0
            ? antigravityAuth.apiKey
            : undefined;
        const exited = (code: string) =>
          this.emit({ handle, instanceId, type: "exited", data: code }, owner);
        if (!signedOutKey) exited(String(event.exitCode));
        void (async () => {
          try {
            if (logout && !antigravity && event.exitCode === 0)
              await this.clearConfiguredCredentials(instanceId);
            if (signedOutKey) {
              // Success is reported only once the key is gone; a failed delete is reported so
              // the user can retry sign-out.
              try {
                await this.clearAntigravityKey(instanceId, signedOutKey);
              } catch {
                this.emit(
                  {
                    handle,
                    instanceId,
                    type: "error",
                    data: "Antigravity signed out, but F5 could not remove the stored Gemini API key. Sign out again to retry.",
                  },
                  owner,
                );
                exited("1");
                return;
              }
              exited("0");
            }
            await this.refreshPeers(instanceId);
          } finally {
            // The job is done, and work may start again, only once the key is gone and the
            // refreshed snapshots describe the new account.
            releaseAccountChange();
            finish();
          }
        })().catch(() =>
          this.emit(
            {
              handle,
              instanceId,
              type: "error",
              data: "Account setup finished, but status refresh failed. Check account status to retry.",
            },
            owner,
          ),
        );
      });
      if (this.disconnectedOwners.has(owner)) {
        await this.cancel(handle, owner);
        throw new Error("Account connection closed.");
      }
      return { handle };
    } catch (error) {
      releaseAccountChange();
      lease.release();
      throw error;
    }
  }
  input(handle: string, data: string, owner: object = this): void {
    const job = this.jobs.get(handle);
    if (!job || job.owner !== owner || job.exited)
      throw new Error("Unknown or expired account terminal.");
    job.process.write(data);
  }
  async cancel(handle: string, owner: object = this): Promise<void> {
    const job = this.jobs.get(handle);
    if (!job) return;
    if (job.owner !== owner) throw new Error("Account terminal belongs to another connection.");
    if (job.exited) {
      await job.done;
      return;
    }
    job.process.kill();
    const force = setTimeout(() => {
      // `done` also waits for the post-exit refresh, so the process may
      // already be gone.
      try {
        job.process.kill("SIGKILL");
      } catch {}
    }, 3000);
    try {
      await job.done;
    } finally {
      clearTimeout(force);
    }
  }
  async disconnect(owner: object): Promise<void> {
    this.disconnectedOwners.add(owner);
    await Promise.all(
      [...this.jobs]
        .filter(([, job]) => job.owner === owner)
        .map(([handle]) => this.cancel(handle, owner)),
    );
  }
  async dispose(): Promise<void> {
    await Promise.all([...this.jobs].map(([handle, job]) => this.cancel(handle, job.owner)));
  }
}
