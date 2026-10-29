import * as FS from "node:fs/promises";
import * as Net from "node:net";
import * as Path from "node:path";
import type { DesktopComputerHost } from "../computer/DesktopComputerHost";
import { browserOpenSocketPath, prepareBrowserOpenLauncher } from "./BrowserOpenLauncher";

export type BrowserOpenStatus = import("@t3tools/contracts").OpenExternalUrlStatus | "unavailable";

/** One bounded JSON line per connection, on a socket private to the OS user. */
export async function startBrowserOpenListener(
  stateDir: string,
  host: Pick<DesktopComputerHost, "openExternalUrl">,
): Promise<() => Promise<void>> {
  const socketPath = browserOpenSocketPath(stateDir);
  const directory = Path.join(stateDir, "browser-open");
  await FS.mkdir(directory, { recursive: true, mode: 0o700 });
  await FS.chmod(directory, 0o700);
  try {
    const previous = await FS.lstat(socketPath);
    if (!previous.isSocket()) throw new Error("Browser open socket path is not a socket.");
    const active = await new Promise<boolean>((resolve, reject) => {
      const probe = Net.createConnection(socketPath);
      probe.once("connect", () => {
        probe.destroy();
        resolve(true);
      });
      probe.once("error", (error: NodeJS.ErrnoException) => {
        if (error.code === "ECONNREFUSED" || error.code === "ENOENT") resolve(false);
        else reject(error);
      });
      probe.setTimeout(1000, () => {
        probe.destroy();
        reject(new Error("Browser open socket did not answer the startup probe."));
      });
    });
    if (active) throw new Error("Browser open listener is already running for this profile.");
    await FS.unlink(socketPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const sockets = new Set<Net.Socket>();
  const server = Net.createServer((socket) => {
    socket.on("error", () => socket.destroy());
    if (sockets.size >= 64) {
      socket.end('{"status":"busy"}\n');
      return;
    }
    sockets.add(socket);
    let input = Buffer.alloc(0);
    let requested = false;
    const reply = (status: BrowserOpenStatus) => {
      if (!socket.destroyed) socket.end(JSON.stringify({ status }) + "\n");
    };
    socket.setTimeout(5000, () => {
      reply(requested ? "unavailable" : "invalid");
      socket.destroySoon();
    });
    socket.on("close", () => sockets.delete(socket));
    socket.on("data", (chunk: Buffer) => {
      if (requested) return;
      input = Buffer.concat([input, chunk]);
      if (input.length > 8192) {
        requested = true;
        reply("invalid");
        return;
      }
      const newline = input.indexOf(10);
      if (newline < 0) return;
      requested = true;
      socket.setTimeout(6 * 60 * 1000);
      let url: unknown;
      try {
        const request: unknown = JSON.parse(input.subarray(0, newline).toString("utf8"));
        if (!request || typeof request !== "object" || input.length !== newline + 1)
          throw new Error("Expected one request.");
        url = (request as { url?: unknown }).url;
        if (typeof url !== "string") throw new Error("Expected a URL.");
        const parsed = new URL(url);
        if (!["http:", "https:"].includes(parsed.protocol)) throw new Error("Expected HTTP.");
      } catch {
        reply("invalid");
        return;
      }
      void host.openExternalUrl(url as string).then(reply, () => reply("unavailable"));
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => {
      server.off("error", reject);
      resolve();
    });
  });
  const close = async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    await FS.rm(socketPath, { force: true });
  };
  try {
    await FS.chmod(socketPath, 0o600);
    await prepareBrowserOpenLauncher(stateDir, socketPath);
    return close;
  } catch (error) {
    await close();
    throw error;
  }
}
