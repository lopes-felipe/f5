import { createHash, randomUUID } from "node:crypto";
import { createConnection, createServer } from "node:net";
import { chmod, lstat, mkdir, realpath, stat, unlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export function desktopAppControlAddress(stateDir: string): {
  address: string;
  directory: string | null;
} {
  const hash = createHash("sha256").update(path.resolve(stateDir)).digest("hex").slice(0, 24);
  const directory = path.join(os.tmpdir(), `f5-app-${process.getuid?.() ?? hash}`);
  return process.platform === "win32"
    ? { address: `\\\\.\\pipe\\f5-app-${hash}`, directory: null }
    : { address: path.join(directory, `${hash}.sock`), directory };
}

export type DesktopAppRequest = import("@t3tools/contracts").DesktopAppActivationRequest;
const MAX_BYTES = 16 * 1024;

/** One request, one response, bounded framing, and no server startup as a side effect. */
export async function openInDesktopApp(
  stateDir: string,
  workspacePath: string,
  env = process.env,
): Promise<void> {
  if (env.SSH_CONNECTION || env.SSH_CLIENT || env.SSH_TTY)
    throw new Error("f5 app cannot control a desktop app over SSH.");
  const expanded =
    workspacePath === "~"
      ? os.homedir()
      : workspacePath.startsWith("~/")
        ? path.join(os.homedir(), workspacePath.slice(2))
        : workspacePath;
  const resolved = await realpath(expanded);
  if (!(await stat(resolved)).isDirectory())
    throw new Error("The project path must be a directory.");
  const id = randomUUID();
  return new Promise((resolve, reject) => {
    const socket = createConnection(desktopAppControlAddress(stateDir).address);
    let buffer = "";
    const timer = setTimeout(
      () => finish(new Error("The desktop app did not respond in time.")),
      17_000,
    );
    const finish = (error?: Error) => {
      clearTimeout(timer);
      socket.destroy();
      if (error) reject(error);
      else resolve();
    };
    socket.setEncoding("utf8");
    socket.once("connect", () => socket.write(JSON.stringify({ id, path: resolved }) + "\n"));
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      if (Buffer.byteLength(buffer) > MAX_BYTES)
        return finish(new Error("Invalid desktop response."));
      if (!buffer.includes("\n")) return;
      try {
        const response = JSON.parse(buffer.slice(0, buffer.indexOf("\n")));
        if (response.id !== id || typeof response.ok !== "boolean") throw new Error();
        finish(
          response.ok
            ? undefined
            : new Error(response.error || "The desktop app could not open the project."),
        );
      } catch {
        finish(new Error("Invalid desktop response."));
      }
    });
    socket.once("error", () =>
      finish(
        new Error(
          "No F5 desktop app is running for this state directory. Start it, then run f5 app again.",
        ),
      ),
    );
    socket.once("end", () => {
      if (!buffer.includes("\n")) finish(new Error("The desktop app disconnected."));
    });
  });
}

/** Start only after the desktop's single-instance lock has been acquired. */
export async function startDesktopAppControl(
  stateDir: string,
  activate: (request: DesktopAppRequest) => Promise<void>,
): Promise<() => Promise<void>> {
  const { address, directory } = desktopAppControlAddress(stateDir);
  if (directory) {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const info = await lstat(directory);
    if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid?.())
      throw new Error("Unsafe desktop control directory.");
    await chmod(directory, 0o700);
    const active = await new Promise<boolean>((resolve, reject) => {
      const probe = createConnection(address);
      probe.setTimeout(500, () => {
        probe.destroy();
        reject(new Error("Cannot verify the desktop control socket."));
      });
      probe.once("connect", () => {
        probe.destroy();
        resolve(true);
      });
      probe.once("error", (error: NodeJS.ErrnoException) => {
        probe.destroy();
        if (error.code === "ENOENT" || error.code === "ECONNREFUSED") resolve(false);
        else reject(error);
      });
    });
    if (active) throw new Error("A desktop app already controls this state directory.");
    await unlink(address).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
  }
  const sockets = new Set<ReturnType<typeof createConnection>>();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    socket.setEncoding("utf8");
    socket.setTimeout(16_000, () => socket.destroy());
    let buffer = "";
    let handled = false;
    socket.on("data", (chunk: string) => {
      if (handled) return;
      buffer += chunk;
      if (Buffer.byteLength(buffer) > MAX_BYTES) {
        socket.destroy();
        return;
      }
      if (!buffer.includes("\n")) return;
      handled = true;
      void (async () => {
        let request: DesktopAppRequest | undefined;
        try {
          const input = JSON.parse(buffer.slice(0, buffer.indexOf("\n")));
          if (
            typeof input.id !== "string" ||
            input.id.length > 100 ||
            typeof input.path !== "string" ||
            !path.isAbsolute(input.path)
          )
            throw new Error("Invalid activation request.");
          request = { id: input.id, path: await realpath(input.path) };
          if (!(await stat(request.path)).isDirectory())
            throw new Error("The project path must be a directory.");
          await activate(request);
          socket.end(JSON.stringify({ id: request.id, ok: true }) + "\n");
        } catch (error) {
          socket.end(
            JSON.stringify({
              id: request?.id,
              ok: false,
              error: error instanceof Error ? error.message : "Activation failed.",
            }) + "\n",
          );
        }
      })();
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(address, () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
  if (directory) await chmod(address, 0o600);
  return async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    if (directory) await unlink(address).catch(() => {});
  };
}
