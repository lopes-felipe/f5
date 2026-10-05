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
const archive = process.env.F5_CLI_SMOKE_ARCHIVE,
  manifest = process.env.F5_CLI_SMOKE_MANIFEST;
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});
it.skipIf(!archive || !manifest)(
  "stages a real immutable archive and keeps its trial inactive until the correlated launcher decision",
  async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "f5-archive-integration-"));
    const state = path.join(root, "state");
    const release = parseRelease(JSON.parse(await fs.readFile(manifest!, "utf8")));
    const realFetch = globalThis.fetch;
    vi.stubGlobal("fetch", () =>
      Promise.resolve(
        new Response(Readable.toWeb(createReadStream(archive!)) as ReadableStream<Uint8Array>),
      ),
    );
    let child: ReturnType<typeof managedChild> | undefined;
    try {
      await stageRelease(root, release);
      await installLauncher(root, release.version);
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
      await child.prepared;
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
      await child.stop();
      child = undefined;
      await atomicJson(path.join(root, "current.json"), {
        schemaVersion: 1,
        version: release.version,
        target: cliTarget(),
      });
      const supervisor = spawn(
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
        { stdio: "inherit", env: process.env },
      );
      try {
        await expect
          .poll(
            async () => {
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
        const exited = new Promise<void>((resolve) => supervisor.once("exit", () => resolve()));
        supervisor.kill("SIGTERM");
        await exited;
      }
      console.log(`Real archive staging/activation smoke passed. Isolated artifacts: ${root}`);
    } finally {
      await child?.stop();
      await fs.rm(root, { recursive: true, force: true });
    }
  },
  120_000,
);
