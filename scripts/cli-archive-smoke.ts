#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off
// @effect-diagnostics globalTimers:off
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import * as net from "node:net";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { cliTarget, parseRelease, sha256File } from "@t3tools/shared/cliRelease";
const exec = promisify(execFile);
const [archive, manifestFile] = process.argv.slice(2);
if (!archive || !manifestFile) throw new Error("Usage: cli-archive-smoke.ts ARCHIVE MANIFEST");
const release = parseRelease(JSON.parse(await fs.readFile(manifestFile, "utf8")));
const artifact = release.artifacts.find((item) => item.target === cliTarget());
if (
  !artifact ||
  artifact.sha256 !== (await sha256File(archive)) ||
  artifact.size !== (await fs.stat(archive)).size
)
  throw new Error("Smoke archive integrity/architecture mismatch.");
const directory = await fs.mkdtemp(path.join(os.tmpdir(), "f5-cli-smoke-"));
let child: ReturnType<typeof spawn> | undefined;
try {
  await exec("tar", ["-xzf", path.resolve(archive), "-C", directory]);
  const runtime = path.join(directory, `f5-${release.version}-${artifact.target}`);
  const executable = path.join(runtime, process.platform === "win32" ? "f5.exe" : "f5");
  const emptyPath = path.join(directory, "empty-path");
  await fs.mkdir(emptyPath);
  const home = path.join(directory, "home");
  await fs.mkdir(home);
  const env = {
    ...process.env,
    PATH: emptyPath,
    SHELL: path.join(emptyPath, "no-login-shell"),
    HOME: home,
    USERPROFILE: home,
    F5_HOME: path.join(home, ".f5"),
    F5_STATE_DIR: path.join(directory, "state"),
    ELECTRON_RUN_AS_NODE: undefined,
  };
  const preflight = await exec(executable, ["runtime-preflight"], {
    env,
    timeout: 30_000,
    maxBuffer: 1024 * 1024,
  });
  if (!preflight.stdout.includes('"launcherProtocol":1'))
    throw new Error("Native PTY/search preflight failed.");
  const port = await new Promise<number>((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("No smoke port."));
        return;
      }
      server.close(() => resolve(address.port));
    });
  });
  const log = await fs.open(path.join(directory, "server.log"), "w");
  child = spawn(
    executable,
    [
      "--port",
      String(port),
      "--host",
      "127.0.0.1",
      "--state-dir",
      env.F5_STATE_DIR,
      "--no-browser",
    ],
    { env, cwd: directory, stdio: ["ignore", log.fd, log.fd] },
  );
  child.once("error", (error) => {
    console.error(error.message);
  });
  await log.close();
  let ready = false;
  for (let attempt = 0; attempt < 120; attempt++) {
    if (child.exitCode !== null || child.signalCode !== null)
      throw new Error(
        "Standalone server exited: " +
          (await fs.readFile(path.join(directory, "server.log"), "utf8")),
      );
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/bootstrap`, {
        signal: AbortSignal.timeout(1000),
      });
      if (response.ok) {
        const body: unknown = await response.json();
        if (body && typeof body === "object" && "protocolVersion" in body) {
          ready = true;
          break;
        }
      }
    } catch {
      /* Wait for migrations/acquisitions. */
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  if (!ready)
    throw new Error(
      "Standalone server did not become ready: " +
        (await fs.readFile(path.join(directory, "server.log"), "utf8")),
    );
  const web = await fetch(`http://127.0.0.1:${port}/`);
  if (!web.ok || !(await web.text()).includes("<html"))
    throw new Error("Standalone web assets are unavailable.");
  console.log(
    `Standalone clean-PATH smoke passed for ${artifact.target}: server, migrations, web assets, native PTY and native search. Artifacts: ${directory}`,
  );
} finally {
  if (child && child.exitCode === null && child.signalCode === null) {
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => child!.kill("SIGKILL"), 5000);
      child!.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
      child!.kill("SIGTERM");
    });
  }
}
