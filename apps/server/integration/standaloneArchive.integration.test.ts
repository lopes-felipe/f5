import { spawn } from "node:child_process";
import { atomicJson } from "../src/distribution/files";
import { cliTarget } from "@t3tools/shared/cliRelease";
import { afterEach, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import { createReadStream } from "node:fs";
import { Readable } from "node:stream";
import * as path from "node:path";
import * as os from "node:os";
import * as net from "node:net";
import { randomUUID } from "node:crypto";
import { parseRelease } from "@t3tools/shared/cliRelease";
import { stageRelease } from "../src/distribution/installation";
import { installLauncher } from "../src/distribution/commands";
import { managedChild } from "../src/distribution/handoff";
import { stopChild, waitForChild } from "../../../scripts/lib/child-lifecycle.ts";
import { writeCiProcessDiagnostics } from "../../../scripts/lib/ci-process-diagnostics.ts";
const archive = process.env.F5_CLI_SMOKE_ARCHIVE,
  manifest = process.env.F5_CLI_SMOKE_MANIFEST;
const required = process.env.F5_REQUIRE_ARCHIVE_INTEGRATION === "1";
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});
it.skipIf(!required && (!archive || !manifest))(
  "stages a real immutable archive and keeps its trial inactive until the correlated launcher decision",
  async () => {
    if (!archive || !manifest)
      throw new Error(
        "Mandatory archive integration requires F5_CLI_SMOKE_ARCHIVE and F5_CLI_SMOKE_MANIFEST",
      );
    for (const file of [archive, manifest]) {
      await fs.access(file);
      if (!(await fs.stat(file)).isFile()) throw new Error(`Archive input is not a file: ${file}`);
    }
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "f5-archive-integration-"));
    const state = path.join(root, "state");
    const realFetch = globalThis.fetch;
    let child: ReturnType<typeof managedChild> | undefined;
    let supervisor: ReturnType<typeof spawn> | undefined;
    let failure: unknown;
    let startupError: unknown;
    let supervisorExit: { code: number | null; signal: NodeJS.Signals | null } | undefined;
    let logs = "";
    try {
      const release = parseRelease(JSON.parse(await fs.readFile(manifest, "utf8")));
      vi.stubGlobal("fetch", () =>
        Promise.resolve(
          new Response(Readable.toWeb(createReadStream(archive)) as ReadableStream<Uint8Array>),
        ),
      );
      await stageRelease(root, release);
      await installLauncher(root, release.version);
      logs += "Archive staged and launcher installed.\n";
      // Native preflight must not consume bytes from the real network during this fixture.
      vi.stubGlobal("fetch", realFetch);
      const port = await new Promise<number>((resolve, reject) => {
        const server = net.createServer();
        server.once("error", reject);
        server.listen(0, "127.0.0.1", () => {
          const address = server.address() as net.AddressInfo;
          server.close(() => resolve(address.port));
        });
      });
      const id = randomUUID();
      vi.stubEnv("F5_HOME", path.join(root, "home"));
      vi.stubEnv("NODE_ENV", "production");
      vi.stubEnv("VITEST", undefined);
      child = managedChild(
        root,
        release.version,
        state,
        ["--port", String(port), "--host", "127.0.0.1"],
        { id, version: release.version, outcome: "committed" },
        true,
      );
      void waitForChild(child.process).catch((error: unknown) => {
        startupError = error;
      });
      await child.prepared;
      if (startupError) throw startupError;
      logs += "Trial prepared without opening HTTP.\n";
      await expect(
        fetch(`http://127.0.0.1:${port}/api/bootstrap`, { signal: AbortSignal.timeout(1000) }),
      ).rejects.toThrow();
      child.process.send({ type: "activate", id: randomUUID() });
      await expect(
        fetch(`http://127.0.0.1:${port}/api/bootstrap`, { signal: AbortSignal.timeout(1000) }),
      ).rejects.toThrow();
      await child.activate();
      await child.activated;
      const bootstrap = await (await fetch(`http://127.0.0.1:${port}/api/bootstrap`)).json();
      expect(bootstrap).toMatchObject({
        update: { id, outcome: "committed", version: release.version },
      });
      logs += "Correlated activation passed.\n";
      await child.stop();
      child = undefined;
      await atomicJson(path.join(root, "current.json"), {
        schemaVersion: 1,
        version: release.version,
        target: cliTarget(),
      });
      supervisor = spawn(
        path.join(root, "launcher-v1", process.platform === "win32" ? "node.exe" : "node"),
        [
          path.join(root, "launcher-v1", "launcher.cjs"),
          root,
          state,
          "--port",
          String(port),
          "--host",
          "127.0.0.1",
        ],
        { stdio: ["ignore", "pipe", "pipe"], env: process.env },
      );
      const appendLog = (chunk: Buffer) => {
        logs = (logs + chunk.toString()).slice(-65_536);
      };
      supervisor.stdout?.on("data", appendLog);
      supervisor.stderr?.on("data", appendLog);
      // Observe before polling, including an early exit or failed spawn.
      void waitForChild(supervisor).then(
        (exit) => {
          supervisorExit = exit;
        },
        (error: unknown) => {
          startupError = error;
        },
      );
      try {
        await expect
          .poll(
            async () => {
              if (startupError) throw startupError;
              if (supervisorExit)
                throw new Error(
                  `Supervisor exited during startup: ${JSON.stringify(supervisorExit)}`,
                );
              try {
                return (
                  await fetch(`http://127.0.0.1:${port}/api/bootstrap`, {
                    signal: AbortSignal.timeout(1000),
                  })
                ).ok;
              } catch {
                return false;
              }
            },
            { timeout: 30_000 },
          )
          .toBe(true);
        // Corrupt update metadata must not take down the healthy service.
        await fs.writeFile(path.join(root, "pending.json"), "{");
        await expect
          .poll(
            async () =>
              (await fs.readdir(root)).some((file) => file.startsWith("rejected-request-")),
            { timeout: 5000 },
          )
          .toBe(true);
        expect((await fetch(`http://127.0.0.1:${port}/api/bootstrap`)).ok).toBe(true);
      } finally {
        await stopChild(supervisor);
      }
      console.log("Real archive staging/activation smoke passed.");
    } catch (error) {
      failure = error;
      throw error;
    } finally {
      try {
        await stopChild(supervisor);
        await stopChild(child?.process);
      } finally {
        try {
          writeCiProcessDiagnostics("archive-integration", logs, failure, [root]);
        } finally {
          await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
        }
      }
    }
  },
  120_000,
);
