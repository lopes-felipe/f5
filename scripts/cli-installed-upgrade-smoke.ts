// @effect-diagnostics nodeBuiltinImport:off
// @effect-diagnostics globalTimers:off
import { createServer } from "node:https";
import { createReadStream } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { Effect } from "effect";
import { NetService } from "@t3tools/shared/Net";
import { waitForCliBootstrap } from "./cli-smoke-readiness.ts";
import { stageCliSmokeArchiveTools } from "./cli-smoke-tools.ts";
import {
  parseRelease,
  cliTarget,
  compareCliReleaseVersions,
  RELEASE_MANIFEST_URL,
  type CliRelease,
} from "@t3tools/shared/cliRelease";
const exec = promisify(execFile);
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Real install and supervised update, with private homes and a locally trusted HTTPS feed. */
export async function installedCliSmoke(
  executable: string,
  archive: string,
  release: CliRelease,
  directory: string,
): Promise<void> {
  await mkdir(directory, { recursive: true });
  const key = join(directory, "key.pem"),
    cert = join(directory, "cert.pem");
  await exec(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      key,
      "-out",
      cert,
      "-days",
      "1",
      "-subj",
      "/CN=localhost",
      "-addext",
      "subjectAltName=DNS:localhost,IP:127.0.0.1",
    ],
    { timeout: 30_000, env: { ...process.env, MSYS_NO_PATHCONV: "1" } },
  );
  const target = cliTarget();
  const artifact = release.artifacts.find((a) => a.target === target)!;
  const home = join(directory, "home"),
    isolatedPath = join(directory, "isolated-path");
  await mkdir(home);
  await mkdir(isolatedPath);
  await stageCliSmokeArchiveTools(isolatedPath);
  let manifest = release;
  const server = createServer(
    { key: await readFile(key), cert: await readFile(cert) },
    (request, response) => {
      if (request.url === "/manifest.json") {
        response.setHeader("Content-Type", "application/json");
        response.end(JSON.stringify(manifest));
      } else if (request.url === "/archive.tar.gz") {
        createReadStream(resolve(archive)).pipe(response);
      } else {
        response.statusCode = 404;
        response.end();
      }
    },
  );
  await new Promise<void>((ok, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", ok);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No HTTPS smoke address");
  const url = "https://127.0.0.1:" + address.port;
  manifest = { ...release, artifacts: [{ ...artifact, url: url + "/archive.tar.gz" }] };
  const env = {
    ...Object.fromEntries(Object.entries(process.env).filter(([k]) => k.toUpperCase() !== "PATH")),
    PATH: isolatedPath,
    HOME: home,
    USERPROFILE: home,
    F5_HOME: join(home, ".f5"),
    NODE_EXTRA_CA_CERTS: cert,
    F5_STATE_DIR: join(directory, "state"),
  };
  const invoke = (program: string, args: string[]) =>
    exec(program, args, { env, timeout: 180_000, maxBuffer: 4 * 1024 * 1024 });
  let child: ReturnType<typeof spawn> | undefined;
  try {
    const fresh = join(directory, "fresh");
    await invoke(executable, [
      "install",
      "--install-dir",
      fresh,
      "--manifest",
      url + "/manifest.json",
    ]);
    const current = JSON.parse(await readFile(join(fresh, "current.json"), "utf8"));
    if (current.version !== release.version || current.target !== target)
      throw new Error("Fresh installation did not select candidate");
    const preflight = await invoke(
      join(fresh, "versions", release.version, process.platform === "win32" ? "f5.exe" : "f5"),
      ["runtime-preflight"],
    );
    if (!preflight.stdout.includes('"launcherProtocol":1'))
      throw new Error("Installed candidate preflight failed");
    const baselineUrl = process.env.CLI_BASELINE
      ? RELEASE_MANIFEST_URL.replace(
          "/latest/download/",
          "/download/v" + process.env.CLI_BASELINE + "/",
        )
      : RELEASE_MANIFEST_URL;
    const response = await fetch(baselineUrl, { signal: AbortSignal.timeout(30_000) });
    if (!response.ok) throw new Error("Published CLI baseline unavailable");
    const baseline = parseRelease(await response.json());
    if (process.env.CLI_BASELINE && baseline.version !== process.env.CLI_BASELINE)
      throw new Error("Pinned CLI baseline identity mismatch");
    if (compareCliReleaseVersions(release.version, baseline.version) <= 0)
      throw new Error("CLI upgrade baseline supersedes candidate");
    if (!baseline.artifacts.some((a) => a.target === target))
      throw new Error("Published CLI baseline target missing");
    manifest = baseline;
    const root = join(directory, "upgrade");
    await invoke(executable, [
      "install",
      "--install-dir",
      root,
      "--manifest",
      url + "/manifest.json",
    ]);
    const previous = join(
      root,
      "versions",
      baseline.version,
      process.platform === "win32" ? "f5.exe" : "f5",
    );
    const port = await Effect.runPromise(
      Effect.gen(function* () {
        return yield* (yield* NetService).reserveLoopbackPort();
      }).pipe(Effect.provide(NetService.layer)),
    );
    child = spawn(
      previous,
      [
        "serve",
        "--install-dir",
        root,
        "--state-dir",
        env.F5_STATE_DIR,
        "--port",
        String(port),
        "--host",
        "127.0.0.1",
        "--no-browser",
      ],
      { env, stdio: ["ignore", "pipe", "pipe"] },
    );
    let logs = "";
    child.stdout?.on("data", (b) => {
      logs += String(b);
    });
    child.stderr?.on("data", (b) => {
      logs += String(b);
    });
    const owned = child;
    const stopped = () => owned.exitCode !== null || owned.signalCode !== null;
    await waitForCliBootstrap("http://127.0.0.1:" + port, stopped, () => logs);
    await readFile(join(root, "launcher.json"));
    manifest = { ...release, artifacts: [{ ...artifact, url: url + "/archive.tar.gz" }] };
    const update = await invoke(previous, [
      "update",
      "--install-dir",
      root,
      "--manifest",
      url + "/manifest.json",
    ]);
    if (!update.stdout.includes("staged"))
      throw new Error("Published CLI failed to stage candidate: " + update.stdout);
    for (let i = 0; ; i++) {
      if (i > 360) throw new Error("CLI update did not complete: " + logs);
      try {
        const outcome = JSON.parse(await readFile(join(root, "outcome.json"), "utf8"));
        if (outcome.outcome !== "committed" || outcome.version !== release.version)
          throw new Error("CLI upgrade rolled back: " + logs);
        const installed = JSON.parse(await readFile(join(root, "current.json"), "utf8"));
        if (installed.version !== release.version)
          throw new Error("CLI current version disagrees with outcome");
        const bootstrap = (await waitForCliBootstrap(
          "http://127.0.0.1:" + port,
          stopped,
          () => logs,
        )) as { update?: { version: string; outcome: string } };
        if (
          bootstrap.update?.version !== release.version ||
          bootstrap.update.outcome !== "committed"
        )
          throw new Error("Updated CLI server is not healthy at the correlated version");
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      await wait(250);
    }
    console.log(
      "Isolated CLI install and published " +
        baseline.version +
        " -> " +
        release.version +
        " upgrade passed for " +
        target,
    );
    await writeFile(
      "cli-upgrade-baseline.json",
      JSON.stringify({ version: baseline.version, target, candidate: release.version }) + "\n",
    );
  } finally {
    try {
      if (child && child.exitCode === null && child.signalCode === null) {
        const owned = child;
        const exited = new Promise<void>((ok) => {
          const timer = setTimeout(() => owned.kill("SIGKILL"), 10_000);
          owned.once("exit", () => {
            clearTimeout(timer);
            ok();
          });
        });
        if (process.platform === "win32" && owned.pid) {
          await exec(
            join(process.env.SystemRoot ?? "C:\\Windows", "System32", "taskkill.exe"),
            ["/PID", String(owned.pid), "/T", "/F"],
            { timeout: 15_000 },
          ).catch(() => owned.kill("SIGKILL"));
        } else owned.kill("SIGTERM");
        await exited;
      }
    } finally {
      server.closeAllConnections();
      await new Promise<void>((ok) => server.close(() => ok()));
    }
  }
}
