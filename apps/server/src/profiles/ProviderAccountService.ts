import * as Path from "node:path";
import { randomUUID } from "node:crypto";
import { Effect, Schema } from "effect";
import {
  ClaudeSettings,
  CodexSettings,
  type ProviderInstanceId,
  type ProviderAccountEvent,
} from "@t3tools/contracts";
import type { ServerConfigShape } from "../config";
import { terminalOwnerKey, type TerminalManagerShape } from "../terminal/Services/Manager";
import type { PtyProcess } from "../terminal/Services/PTY";
import type { ServerSettingsShape } from "../serverSettings";
import { deriveProviderInstanceConfigMap } from "../provider/Layers/ProviderInstanceRegistryHydration";
import { buildAccountExecutionEnvironment } from "../providerProcessEnv";
import { resolveClaudeCliInvocation } from "../provider/claudeSdkExecutable";
import { resolveInvocation } from "../spawn/resolveCommand";
import { makeClaudeEnvironment } from "../provider/Drivers/ClaudeHome";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { acquireInstanceLock } from "./InstanceLock";
import { isProfilePortBindable } from "./ProfileRegistryStore";
import { runProcess } from "../processRunner";

import { validateManagedHome, certifyProvider } from "./providerIsolation";
export async function assertOAuthPortAvailable(port: number): Promise<void> {
  if (!(await isProfilePortBindable(port)))
    throw new Error(
      `OAuth callback port ${port} is already in use by another process. Close that login or choose another callback port. F5 has not stopped the port owner.`,
    );
}

interface Job {
  instanceId: ProviderInstanceId;
  process: PtyProcess;
  done: Promise<void>;
  timeout: ReturnType<typeof setTimeout>;
}
export class ProviderAccountService {
  private readonly jobs = new Map<string, Job>();
  constructor(
    private readonly config: ServerConfigShape,
    private readonly settings: ServerSettingsShape,
    private readonly terminals: TerminalManagerShape,
    private readonly emit: (event: typeof ProviderAccountEvent.Type) => void,
    private readonly refresh: (instanceId: ProviderInstanceId) => Promise<void>,
    private readonly isBusy: (instanceId: ProviderInstanceId) => Promise<boolean>,
  ) {}
  async resolve(instanceId: ProviderInstanceId) {
    const settings = await Effect.runPromise(this.settings.getSettings);
    const instance = deriveProviderInstanceConfigMap(settings)[instanceId];
    if (!instance || (instance.driver !== "codex" && instance.driver !== "claudeAgent"))
      throw new Error(
        "unsupported-isolation: this provider has no certified account setup implementation.",
      );
    const config =
      instance.driver === "codex"
        ? Schema.decodeUnknownSync(CodexSettings)(instance.config ?? {})
        : Schema.decodeUnknownSync(ClaudeSettings)(instance.config ?? {});
    await validateManagedHome(this.config, config.homePath);
    let environment = buildAccountExecutionEnvironment({
      purpose: "account",
      profile: this.config.profile,
      stateDir: this.config.stateDir,
      baseEnv: process.env,
      instance: instance.environment,
    });
    if (instance.driver === "claudeAgent")
      environment = await Effect.runPromise(
        makeClaudeEnvironment(config, environment).pipe(Effect.provide(NodeServices.layer)),
      );
    else if (config.homePath) environment.CODEX_HOME = config.homePath;
    await certifyProvider(this.config, instance.driver, config.binaryPath, environment);
    const invocation = (args: string[]) =>
      instance.driver === "claudeAgent"
        ? resolveClaudeCliInvocation(config.binaryPath, args, environment)
        : resolveInvocation(
            config.binaryPath,
            [
              ...(this.config.profile?.isDefault === false
                ? ["-c", 'cli_auth_credentials_store="file"']
                : []),
              ...args,
            ],
            environment,
          );
    return { instance, config, environment, invocation };
  }
  async status(instanceId: ProviderInstanceId) {
    const resolved = await this.resolve(instanceId);
    const command = resolved.invocation(
      resolved.instance.driver === "codex" ? ["login", "status"] : ["auth", "status"],
    );
    const result = await runProcess(command.file, command.args, {
      env: resolved.environment,
      timeoutMs: 15000,
      allowNonZeroExit: true,
    });
    return {
      status: result.code === 0 ? "authenticated" : "unauthenticated",
      detail: result.stdout || result.stderr,
    };
  }
  private async clearConfiguredCredentials(instanceId: ProviderInstanceId): Promise<void> {
    const settings = await Effect.runPromise(this.settings.getSettings);
    const instance = settings.providerInstances[instanceId];
    if (!instance?.environment?.length) return;
    const credentials =
      instance.driver === "codex"
        ? new Set(["OPENAI_API_KEY"])
        : new Set(["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN"]);
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
  async start(instanceId: ProviderInstanceId, logout = false): Promise<{ handle: string }> {
    if (logout && (await this.isBusy(instanceId)))
      throw new Error("Stop this instance's active turn before signing out.");
    const resolved = await this.resolve(instanceId);
    const createProcess = this.terminals.createAccountProcess;
    if (!createProcess) throw new Error("Account terminals are unavailable in this runtime.");
    const root = this.config.profilesRoot ?? `${this.config.stateDir}-profiles`;
    const lease = await acquireInstanceLock(
      Path.join(root, "locks", "provider-oauth.lock.sqlite"),
    ).catch((error) => {
      throw new Error(
        `Another profile is signing in right now, or the OAuth lease cannot be acquired. ${String(error)}`,
      );
    });
    try {
      if (!logout && resolved.instance.driver === "codex") await assertOAuthPortAvailable(1455);
      const args =
        resolved.instance.driver === "codex"
          ? [logout ? "logout" : "login"]
          : ["auth", logout ? "logout" : "login"];
      const command = resolved.invocation(args);
      const child = await Effect.runPromise(
        createProcess({
          shell: command.file,
          args: [...command.args],
          env: resolved.environment,
          cwd: this.config.stateDir,
          cols: 100,
          rows: 26,
        }),
      );
      const handle = `${terminalOwnerKey({ kind: "account", instanceId })}:${randomUUID()}`;
      let finish!: () => void;
      const done = new Promise<void>((resolve) => {
        finish = resolve;
      });
      const timeout = setTimeout(() => {
        void this.cancel(handle);
      }, 600000);
      this.jobs.set(handle, { instanceId, process: child, done, timeout });
      const unsubscribe = child.onData((data) =>
        this.emit({ handle, instanceId, type: "output", data }),
      );
      child.onExit((event) => {
        clearTimeout(timeout);
        unsubscribe();
        this.jobs.delete(handle);
        lease.release();
        finish();
        this.emit({ handle, instanceId, type: "exited", data: String(event.exitCode) });
        void (async () => {
          if (logout && event.exitCode === 0) await this.clearConfiguredCredentials(instanceId);
          await this.refresh(instanceId);
        })().catch(() =>
          this.emit({
            handle,
            instanceId,
            type: "error",
            data: "Account setup finished, but status refresh failed. Check account status to retry.",
          }),
        );
      });
      return { handle };
    } catch (error) {
      lease.release();
      throw error;
    }
  }
  input(handle: string, data: string): void {
    const job = this.jobs.get(handle);
    if (!job) throw new Error("Unknown or expired account terminal.");
    job.process.write(data);
  }
  async cancel(handle: string): Promise<void> {
    const job = this.jobs.get(handle);
    if (!job) return;
    job.process.kill();
    const force = setTimeout(() => job.process.kill("SIGKILL"), 3000);
    try {
      await job.done;
    } finally {
      clearTimeout(force);
    }
  }
  async dispose(): Promise<void> {
    await Promise.all([...this.jobs.keys()].map((handle) => this.cancel(handle)));
  }
}
