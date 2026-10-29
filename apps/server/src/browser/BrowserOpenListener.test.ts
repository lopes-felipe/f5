import * as FS from "node:fs/promises";
import * as Net from "node:net";
import * as OS from "node:os";
import * as Path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { startBrowserOpenListener } from "./BrowserOpenListener";
import { browserOpenSocketPath } from "./BrowserOpenLauncher";
import { DesktopComputerHost } from "../computer/DesktopComputerHost";

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
async function fixture(host = { openExternalUrl: vi.fn(async () => "copied" as const) }) {
  const root = await FS.mkdtemp(Path.join(OS.tmpdir(), "f5-browser-listener-"));
  cleanup.push(() => FS.rm(root, { recursive: true, force: true }));
  const close = await startBrowserOpenListener(root, host);
  cleanup.push(close);
  const socketPath = browserOpenSocketPath(root);
  const send = (data: string) =>
    new Promise<unknown>((resolve, reject) => {
      const socket = Net.createConnection(socketPath);
      let reply = "";
      socket.on("connect", () => socket.write(data));
      socket.on("data", (chunk) => {
        reply += chunk.toString();
      });
      socket.on("error", reject);
      socket.on("end", () => resolve(JSON.parse(reply)));
    });
  return { root, socketPath, send, host, close };
}
describe.skipIf(process.platform === "win32")("private browser socket", () => {
  it("does not unlink a live listener when the same profile starts twice", async () => {
    const h = await fixture();
    await expect(startBrowserOpenListener(h.root, h.host)).rejects.toThrow("already running");
    expect(await h.send('{"url":"https://example.com"}\n')).toEqual({ status: "copied" });
  });
  it("does not overwrite a regular file at the socket path", async () => {
    const root = await FS.mkdtemp(Path.join(OS.tmpdir(), "f5-browser-socket-file-"));
    cleanup.push(() => FS.rm(root, { recursive: true, force: true }));
    const socketPath = browserOpenSocketPath(root);
    await FS.mkdir(Path.dirname(socketPath), { recursive: true });
    await FS.writeFile(socketPath, "keep");
    cleanup.push(() => FS.rm(socketPath, { force: true }));
    await expect(
      startBrowserOpenListener(root, {
        openExternalUrl: async () => "opened",
      }),
    ).rejects.toThrow("not a socket");
    expect(await FS.readFile(socketPath, "utf8")).toBe("keep");
  });
  it("forwards one request, uses private permissions, and removes its socket on shutdown", async () => {
    const h = await fixture();
    expect((await FS.stat(Path.join(h.root, "browser-open"))).mode & 0o777).toBe(0o700);
    expect((await FS.stat(h.socketPath)).mode & 0o777).toBe(0o600);
    expect(await h.send('{"url":"https://example.com/login"}\n')).toEqual({ status: "copied" });
    expect(h.host.openExternalUrl).toHaveBeenCalledWith("https://example.com/login");
    cleanup.pop();
    await h.close();
    await expect(FS.stat(h.socketPath)).rejects.toMatchObject({ code: "ENOENT" });
  });
  it.each([
    "not json\n",
    "{}\n",
    '{"url":42}\n',
    '{"url":"file:///tmp/a"}\n',
    '{"url":"https://example.com"}\n{}\n',
    "a".repeat(8193),
  ])("rejects malformed or oversized requests", async (data) => {
    const h = await fixture();
    expect(await h.send(data)).toEqual({ status: "invalid" });
    expect(h.host.openExternalUrl).not.toHaveBeenCalled();
  });
  it("returns unavailable when the desktop did not negotiate browser support", async () => {
    const host = new DesktopComputerHost("p", "i", undefined, false);
    const root = await FS.mkdtemp(Path.join(OS.tmpdir(), "f5-browser-old-host-"));
    cleanup.push(() => FS.rm(root, { recursive: true, force: true }));
    const close = await startBrowserOpenListener(root, host);
    cleanup.push(close);
    const reply = await new Promise<string>((resolve, reject) => {
      const socket = Net.createConnection(browserOpenSocketPath(root));
      socket.on("connect", () => socket.write('{"url":"https://example.com"}\n'));
      socket.on("data", (data) => resolve(data.toString()));
      socket.on("error", reject);
    });
    expect(JSON.parse(reply)).toEqual({ status: "unavailable" });
    host.close();
  });
});
