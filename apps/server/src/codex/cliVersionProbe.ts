import { createHash } from "node:crypto";
import { resolveCodexCommand } from "../provider/codexExecutable.ts";
import { stat } from "node:fs/promises";
import { resolveInvocation } from "../spawn/resolveCommand.ts";
import { runProcess } from "../processRunner.ts";
import { buildProviderChildProcessEnv } from "../providerProcessEnv.ts";
import { resolveCodexHome } from "../os-jank.ts";
import { prependCodexCliTelemetryDisabledConfig } from "../provider/codexCliConfig.ts";
import {
  parseCodexCliVersion,
  isCodexCliVersionSupported,
  formatCodexCliUpgradeMessage,
} from "../provider/codexCliVersion.ts";

export interface CodexVersionProbeInput {
  readonly processEnvironment: NodeJS.ProcessEnv;
  readonly binaryPath: string;
  readonly cwd: string;
  readonly homePath?: string;
  readonly signal?: AbortSignal;
}
const probes = new Map<
  string,
  { promise: Promise<string | null>; controller: AbortController; users: number }
>();

export const getCodexVersionProbeResources = () => ({
  probes: probes.size,
  waiters: [...probes.values()].reduce((sum, probe) => sum + probe.users, 0),
});

/** Shares only concurrent probes of the same executable identity and environment. */
export async function probeCodexCliVersion(input: CodexVersionProbeInput): Promise<string | null> {
  input.signal?.throwIfAborted();
  const home = resolveCodexHome(input);
  const env = buildProviderChildProcessEnv(
    input.processEnvironment,
    home ? { CODEX_HOME: home } : undefined,
  );
  const invocation = resolveInvocation(
    resolveCodexCommand(input.binaryPath),
    prependCodexCliTelemetryDisabledConfig(["--version"], {
      managedCredentials: env.F5_PROFILE_ISOLATED === "1",
    }),
    env,
    { cwd: input.cwd, useCache: false },
  );
  const identities = await Promise.all(
    [invocation.file, ...invocation.args.filter((arg) => /\.[cm]?js$/.test(arg))].map(
      async (file) => {
        const info = await stat(file).catch(() => null);
        return [file, info?.dev, info?.ino, info?.size, info?.mtimeMs];
      },
    ),
  );
  input.signal?.throwIfAborted();
  const key = createHash("sha256")
    .update(
      JSON.stringify([
        identities,
        invocation.args,
        input.cwd,
        Object.entries(env).sort(([a], [b]) => a.localeCompare(b)),
      ]),
    )
    .digest("hex");
  let probe = probes.get(key);
  if (!probe) {
    const controller = new AbortController();
    const promise = runProcess(invocation.file, invocation.args, {
      cwd: input.cwd,
      env,
      timeoutMs: 4000,
      maxBufferBytes: 1024 * 1024,
      signal: controller.signal,
      allowNonZeroExit: true,
    })
      .then((result) => {
        if (result.aborted)
          throw controller.signal.reason ?? new Error("Codex CLI version check cancelled.");
        if (result.timedOut) throw new Error("Codex CLI version check timed out after 4000 ms.");
        if (result.code !== 0)
          throw new Error(
            `Codex CLI version check failed. ${result.stderr.trim() || result.stdout.trim() || `Command exited with code ${result.code}.`}`,
          );
        const version = parseCodexCliVersion(`${result.stdout}\n${result.stderr}`);
        if (version && !isCodexCliVersionSupported(version))
          throw new Error(formatCodexCliUpgradeMessage(version));
        return version;
      })
      .catch((error: unknown) => {
        if (error instanceof Error && /enoent|command not found|not found/i.test(error.message))
          throw new Error(`Codex CLI (${input.binaryPath}) is not installed or not executable.`, {
            cause: error,
          });
        throw error;
      });
    probe = { controller, promise, users: 0 };
    probes.set(key, probe);
    const current = probe;
    void promise
      .finally(() => {
        if (probes.get(key) === current) probes.delete(key);
      })
      .catch(() => {});
  }
  probe.users++;
  const current = probe;
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (action: () => void) => {
      if (settled) return;
      settled = true;
      input.signal?.removeEventListener("abort", abort);
      if (--current.users === 0 && probes.get(key) === current) {
        probes.delete(key);
        current.controller.abort();
      }
      action();
    };
    const abort = () => finish(() => reject(input.signal!.reason));
    input.signal?.addEventListener("abort", abort, { once: true });
    current.promise.then(
      (version) => finish(() => resolve(version)),
      (error: unknown) => finish(() => reject(error)),
    );
    if (input.signal?.aborted) abort();
  });
}
