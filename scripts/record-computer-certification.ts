import { spawn, execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { release } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);
const args = process.argv.slice(2);
const argument = (key: string) => {
  const index = args.indexOf(key);
  return index >= 0 ? args[index + 1] : undefined;
};
const appPath = argument("--app");
const helperPath =
  argument("--helper") ??
  (appPath
    ? process.platform === "darwin"
      ? join(appPath, "Contents", "Resources", "native", "f5-computer-helper")
      : join(appPath, "resources", "native", "f5-computer-helper.exe")
    : undefined);
const output = argument("--output");
if (!helperPath || !output || (appPath && argument("--helper"))) {
  process.stderr.write(
    "Usage: bun scripts/record-computer-certification.ts (--app <installed app> | --helper <dev helper>) --output <report.json>\n",
  );
  process.exit(1);
}

async function verifySignature(
  path: string,
): Promise<{ verified: boolean; teamId?: string; detail?: string }> {
  try {
    if (process.platform === "darwin") {
      await exec("/usr/bin/codesign", ["--verify", "--deep", "--strict", path], { timeout: 10000 });
      const result = await exec("/usr/bin/codesign", ["-dv", "--verbose=4", path], {
        timeout: 10000,
      });
      const teamId = result.stderr.match(/^TeamIdentifier=(.+)$/m)?.[1];
      return teamId && teamId !== "not set"
        ? { verified: true, teamId }
        : { verified: false, detail: "Ad-hoc or missing team signature." };
    }
    if (process.platform === "win32") {
      await exec("signtool", ["verify", "/pa", path], { timeout: 10000, windowsHide: true });
      return { verified: true };
    }
    return { verified: false, detail: "Unsupported platform." };
  } catch {
    return {
      verified: false,
      detail: "Signature verification failed or the signing tool is unavailable.",
    };
  }
}

/** Starts suspended; sends only a permission observation. No grant, permit,
 * resume, capture, input, or provider request is sent by this recorder. */
async function probePermissions(path: string): Promise<unknown> {
  return new Promise((resolveProbe) => {
    const child = spawn(path, [], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    let buffer = "";
    let settled = false;
    const finish = (result: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill();
      resolveProbe(result);
    };
    const timer = setTimeout(() => finish({ available: false, reason: "probe-timeout" }), 5000);
    child.on("error", () => finish({ available: false, reason: "helper-missing" }));
    child.on("exit", () => finish({ available: false, reason: "helper-exited" }));
    child.stderr.resume();
    child.stdin.on("error", () => finish({ available: false, reason: "helper-disconnected" }));
    child.stdout.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      if (Buffer.byteLength(buffer) > 1024 * 1024) {
        finish({ available: false, reason: "invalid-protocol" });
        return;
      }
      for (;;) {
        const newline = buffer.indexOf("\n");
        if (newline < 0) break;
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        let message: {
          type?: string;
          protocolVersion?: number;
          status?: unknown;
          requestId?: string;
          result?: unknown;
        };
        try {
          message = JSON.parse(line);
        } catch {
          finish({ available: false, reason: "invalid-protocol" });
          return;
        }
        if (message.type === "hello") {
          if (message.protocolVersion !== 1) {
            finish({ available: false, reason: "protocol-mismatch" });
            return;
          }
          child.stdin.write(
            JSON.stringify({
              type: "request",
              request: { op: "status", requestId: "preflight-status" },
            }) + "\n",
          );
        } else if (message.type === "response" && message.requestId === "preflight-status") {
          finish(message.result ?? { available: false, reason: "invalid-protocol" });
        } else if (
          message.type === "status" &&
          (message.status as { available?: boolean })?.available === false
        ) {
          finish(message.status);
        }
      }
    });
  });
}

const helper = resolve(helperPath);
const hash = await readFile(helper).then(
  (bytes) => createHash("sha256").update(bytes).digest("hex"),
  () => null,
);
const [helperSignature, appSignature, permissions, providerReadiness] = await Promise.all([
  verifySignature(helper),
  appPath
    ? verifySignature(resolve(appPath))
    : Promise.resolve({
        verified: false,
        detail: "Development helper; no installed app supplied.",
      }),
  probePermissions(helper),
  exec("bun", [resolve(import.meta.dirname, "../apps/server/scripts/probe-computer-builtins.ts")], {
    timeout: 10000,
  }).then(
    (result) => JSON.parse(result.stdout) as unknown,
    () => ({ state: "probe-failed" }),
  ),
]);
const repositoryCommit = await exec("git", ["rev-parse", "HEAD"]).then(
  (result) => result.stdout.trim(),
  () => "unknown",
);
const workingTreeDirty = await exec("git", ["status", "--porcelain"]).then(
  (result) => !!result.stdout.trim(),
  () => true,
);
const checks = [
  "TCC attribution and permission revocation",
  "Both providers: native and multi-app workflows",
  "Command-app typing restrictions and secure fields",
  "Kill chord under 100ms, including hung renderer and stopped backend",
  "Physical input pause and fresh geometry on resume",
  "Focus/dialog changes and drag across protected windows",
  "Include-only capture and secure masking while windows move",
  "Inspect/zoom/semantic actions require grants",
  "Two-profile lease and multiple-build device lock",
  "Mixed-DPI displays, fullscreen overlays excluded from capture",
  "Control with all macOS F5 windows closed",
  "Signed packaging and installed helper path confinement",
  "Chrome consent, drift, pause, policy-off, and exact restore",
  "Built-in launch, consent, veto, F5 isolation, and profile isolation",
];
await writeFile(
  resolve(output),
  JSON.stringify(
    {
      reportVersion: 1,
      recordedAt: new Date().toISOString(),
      buildCommit: argument("--build-commit") ?? null,
      repositoryCommit,
      workingTreeDirty,
      platform: process.platform,
      osVersion: release(),
      arch: process.arch,
      packaged: !!appPath,
      helperSha256: hash,
      helperSignature,
      appSignature,
      permissionProbe: permissions,
      providerReadiness,
      certified: false,
      checks: checks.map((name) => ({ name, state: "pending", evidence: null })),
      note: "Read-only preflight. Signature/permission observations do not certify attribution, capture isolation, consent, or interruption latency. Release gates must be reviewed and changed separately after recorded machine tests.",
    },
    null,
    2,
  ) + "\n",
  { flag: "wx" },
);
process.stdout.write(
  `Certification preflight written to ${resolve(output)}; all manual checks remain pending.\n`,
);
