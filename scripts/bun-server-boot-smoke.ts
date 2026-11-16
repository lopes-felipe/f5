/**
 * Boots `apps/server` the way `bun run dev` does (`bun run src/index.ts`) and
 * exits once it answers readiness. Catches Node-only built-ins such as
 * `node:sqlite` being imported eagerly from modules Bun loads.
 *
 * State, home and port are isolated so the check never reads or migrates a
 * developer's real F5 or legacy T3 state.
 */
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import * as Path from "node:path";

const READY_TIMEOUT_MS = 90_000;
const repoRoot = Path.resolve(import.meta.dirname, "..");

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() =>
        typeof address === "object" && address
          ? resolve(address.port)
          : reject(new Error("no port")),
      );
    });
  });
}

const root = mkdtempSync(Path.join(tmpdir(), "f5-bun-boot-"));
const port = await freePort();
const output: string[] = [];
const child = spawn("bun", ["run", "src/index.ts"], {
  cwd: Path.join(repoRoot, "apps/server"),
  env: {
    PATH: process.env.PATH ?? "",
    ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
    HOME: root,
    USERPROFILE: root,
    F5_HOME: Path.join(root, "f5"),
    F5_STATE_DIR: Path.join(root, "state"),
    T3CODE_PORT: String(port),
    T3CODE_NO_BROWSER: "1",
  },
  stdio: ["ignore", "pipe", "pipe"],
});
child.stdout.on("data", (chunk: Buffer) => output.push(chunk.toString()));
child.stderr.on("data", (chunk: Buffer) => output.push(chunk.toString()));
const exited = new Promise<number | null>((resolve) => child.once("exit", (code) => resolve(code)));

let ready = false;
let lastStatus: number | null = null;
const deadline = Date.now() + READY_TIMEOUT_MS;
try {
  while (!ready && Date.now() < deadline && child.exitCode === null) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/bootstrap`, {
        signal: AbortSignal.timeout(1_000),
      });
      await response.body?.cancel();
      ready = response.status === 200;
      if (!ready) lastStatus = response.status;
    } catch {
      // Not listening yet.
    }
    if (!ready) await new Promise((resolve) => setTimeout(resolve, 250));
  }
  if (ready) {
    const backup = await fetch(`http://127.0.0.1:${port}/api/storage/backup`, {
      signal: AbortSignal.timeout(30_000),
    });
    if (!backup.ok || backup.headers.get("content-type") !== "application/x-f5-backup")
      throw new Error(`Bun maintenance export failed: ${await backup.text()}`);
    const bytes = await backup.arrayBuffer();
    if (bytes.byteLength === 0 || bytes.byteLength !== Number(backup.headers.get("content-length")))
      throw new Error("Bun maintenance export was incomplete.");
  }
} finally {
  child.kill("SIGTERM");
  const forceKill = setTimeout(() => child.kill("SIGKILL"), 5_000);
  await exited;
  clearTimeout(forceKill);
  rmSync(root, { recursive: true, force: true });
}

if (!ready) {
  console.error(output.join("").slice(-8_000));
  console.error(
    `Server did not become ready under Bun${lastStatus === null ? "" : ` (last /api/bootstrap status ${lastStatus})`}.`,
  );
  process.exit(1);
}
console.log(`Server became ready and exported a backup under Bun on port ${port}.`);
