import { spawn, execFile, type ExecFileOptions } from "node:child_process";
import { promisify } from "node:util";
import { join } from "node:path";
import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { Schema } from "effect";
import { ComputerAutomationBackendStatus } from "@t3tools/contracts";
import { prepareRehearsalClaude } from "@t3tools/shared/computerRehearsalClaude";
import { cleanEnvironment } from "./process";
import { helperPath, signature, type Target } from "./identity";
import { record } from "./model";
import type { Launches, ProviderLaunch } from "./commands";

export async function codexAuthenticationReady(
  launch: ProviderLaunch,
  executeFile: (
    binary: string,
    args: readonly string[],
    options: ExecFileOptions,
  ) => Promise<{ stdout: string | Buffer; stderr: string | Buffer }> = promisify(execFile),
) {
  try {
    await access(join(launch.home, "auth.json"));
    const result = await executeFile(launch.binary, ["login", "status"], {
      env: cleanEnvironment({ CODEX_HOME: launch.home }),
      timeout: 15000,
      maxBuffer: 8192,
    });
    return /logged in/i.test(result.stdout.toString() + result.stderr.toString());
  } catch {
    return false;
  }
}

/** Never sends grants, permit, resume, capture or input. Starts and exits suspended. */
export async function suspendedProbe(path: string, spawnProbe: typeof spawn = spawn) {
  return new Promise<ComputerAutomationBackendStatus>((done) => {
    const child = spawnProbe(path, [], {
      stdio: ["pipe", "pipe", "pipe"],
      env: cleanEnvironment(),
      windowsHide: true,
    });
    let buffer = "";
    let result: ComputerAutomationBackendStatus = { available: false, reason: "helper-missing" };
    let replied = false;
    let helloReceived = false;
    let requestedStop = false;
    let startingStatus: ComputerAutomationBackendStatus | undefined;
    const stop = (value: ComputerAutomationBackendStatus) => {
      // An exiting helper can close stdin immediately after sending other-instance.
      // A late EPIPE must not replace that already validated terminal status.
      if (replied) return;
      result = value;
      replied = true;
      requestedStop = child.kill();
    };
    const observeStatus = (status: ComputerAutomationBackendStatus) => {
      // Monitors start fail-closed and publish readiness after their first live
      // challenge. Wait within the existing deadline, without granting authority.
      if (!status.available && status.reason === "monitor-unhealthy") {
        startingStatus = status;
        return;
      }
      stop(status);
    };
    const timeout = setTimeout(
      () => stop(startingStatus ?? { available: false, reason: "helper-crashed" }),
      5000,
    );
    const force = setTimeout(() => child.kill("SIGKILL"), 6000);
    child.stderr.resume();
    child.stdin.on("error", () => stop({ available: false, reason: "helper-crashed" }));
    child.on("error", () => {});
    child.stdout.on("data", (chunk: Buffer) => {
      if (replied) return;
      buffer += chunk.toString();
      if (Buffer.byteLength(buffer) > 1024 * 1024) {
        stop({ available: false, reason: "helper-crashed" });
        return;
      }
      let end;
      while ((end = buffer.indexOf("\n")) >= 0) {
        if (replied) return;
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 1);
        try {
          const message: unknown = JSON.parse(line);
          if (!record(message)) throw new Error("Invalid helper packet");
          if (message.type === "hello") {
            if (
              helloReceived ||
              message.protocolVersion !== 1 ||
              typeof message.helperVersion !== "string"
            )
              throw new Error("Protocol mismatch");
            helloReceived = true;
            child.stdin.write(
              JSON.stringify({
                type: "request",
                request: { op: "status", requestId: "suite-preflight" },
              }) + "\n",
            );
          } else if (!helloReceived) throw new Error("Missing helper handshake");
          else if (message.type === "response" && message.requestId === "suite-preflight") {
            observeStatus(
              Schema.decodeUnknownSync(ComputerAutomationBackendStatus)(message.result),
            );
          } else if (message.type === "status") {
            const status = Schema.decodeUnknownSync(ComputerAutomationBackendStatus)(
              message.status,
            );
            observeStatus(status);
          }
        } catch {
          stop({ available: false, reason: "helper-crashed" });
        }
      }
    });
    child.once("close", (code, signal) => {
      clearTimeout(timeout);
      clearTimeout(force);
      done(
        replied && (code === 0 || (code === null && signal === "SIGTERM" && requestedStop))
          ? result
          : { available: false, reason: "helper-crashed" },
      );
    });
  });
}

export async function preflight(target: Target, launches: Launches) {
  const hostMatches = process.platform === target.platform;
  const status = hostMatches
    ? await suspendedProbe(helperPath(target))
    : { available: false as const, reason: "unsupported-platform" as const };
  const checks: Record<string, boolean> = {
    platform: hostMatches,
    "helper-permissions": status.available,
    "app-signature": target.app ? await signature(target.app, target.platform) : false,
    "helper-signature": target.app ? await signature(helperPath(target), target.platform) : false,
  };
  const versions: Record<string, string> = {};
  const exec = promisify(execFile);
  for (const provider of ["codex", "claude"] as const) {
    const launch = launches[provider];
    checks[provider + "-ready"] = false;
    if (!launch || !hostMatches) continue;
    try {
      const version = await exec(launch.binary, ["--version"], {
        env: cleanEnvironment(),
        timeout: 10000,
        maxBuffer: 8192,
      });
      const found = (version.stdout + version.stderr).match(/\b\d+\.\d+\.\d+\b/);
      if (!found) continue;
      versions[provider] = found[0];
      if (provider === "codex") {
        checks["codex-ready"] = await codexAuthenticationReady(launch);
      } else {
        const root = await mkdtemp(join(tmpdir(), "f5-suite-claude-preflight-"));
        try {
          const prepared = await prepareRehearsalClaude({
            binary: launch.binary,
            sourceHome: launch.home,
            isolatedHome: join(root, "home"),
            root,
          });
          checks["claude-ready"] = prepared.authentication.status === "authenticated";
        } finally {
          await rm(root, { recursive: true, force: true });
        }
      }
    } catch {
      /* Safe readiness false; account output is never persisted. */
    }
  }
  return {
    checks,
    helperStatus: status,
    providerVersions: versions,
    displays: status.available ? (status.displays ?? []) : [],
  };
}
