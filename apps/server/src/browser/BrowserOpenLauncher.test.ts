import { spawn } from "node:child_process";
import * as FS from "node:fs/promises";
import * as Net from "node:net";
import * as OS from "node:os";
import * as Path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  browserLauncherDir,
  browserLauncherPath,
  browserOpenSocketPath,
  prepareBrowserOpenLauncher,
} from "./BrowserOpenLauncher";

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

async function fixture() {
  const root = await FS.mkdtemp(Path.join(OS.tmpdir(), "f5-browser-launcher-"));
  cleanup.push(() => FS.rm(root, { recursive: true, force: true }));
  await prepareBrowserOpenLauncher(root);
  return root;
}

function run(file: string, args: string[]) {
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(file, args, { env: process.env });
    let stdout = "",
      stderr = "";
    child.stdout.on("data", (data) => {
      stdout += data;
    });
    child.stderr.on("data", (data) => {
      stderr += data;
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

async function respond(root: string, status: string) {
  const requests: unknown[] = [];
  const server = Net.createServer((socket) => {
    socket.once("data", (chunk) => {
      requests.push(JSON.parse(chunk.toString()));
      socket.end(JSON.stringify({ status }) + "\n");
    });
  });
  const socketPath = browserOpenSocketPath(root);
  await FS.mkdir(Path.dirname(socketPath), { recursive: true });
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  cleanup.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
  return requests;
}

describe.skipIf(process.platform === "win32")("browser launcher", () => {
  it("generates private executables containing the selected socket and handles long byte paths", async () => {
    const root = await fixture();
    expect((await FS.stat(browserLauncherDir(root))).mode & 0o777).toBe(0o700);
    for (const file of ["f5-open-url", "open", "open-url.cjs"]) {
      expect((await FS.stat(Path.join(browserLauncherDir(root), file))).mode & 0o777).toBe(0o700);
    }
    expect(
      await FS.readFile(Path.join(browserLauncherDir(root), "open-url.cjs"), "utf8"),
    ).toContain(JSON.stringify(browserOpenSocketPath(root)));
    expect(browserOpenSocketPath("/short")).toBe("/short/browser-open/open.sock");
    const long = browserOpenSocketPath("/" + "é".repeat(60));
    expect(long).toMatch(/f5-browser-[a-f0-9]{12}\.sock$/);
    expect(Path.dirname(long)).toBe(OS.tmpdir());
    expect(long).not.toBe(browserOpenSocketPath("/" + "é".repeat(61)));
  });
  it.each([
    ["opened", 0],
    ["copied", 0],
    ["denied", 1],
    ["busy", 1],
    ["invalid", 1],
    ["unavailable", 2],
  ])("maps %s to exit %i and always prints the manual URL", async (status, code) => {
    const root = await fixture();
    const requests = await respond(root, status as string);
    const result = await run(browserLauncherPath(root), ["https://example.com/login?a=b"]);
    expect(result.code).toBe(code);
    expect(result.stderr).toContain("Open this URL to continue: https://example.com/login?a=b");
    expect(requests).toEqual([{ url: "https://example.com/login?a=b" }]);
  });
  it("returns unavailable for a missing socket and invalid for unsupported arguments", async () => {
    const root = await fixture();
    expect((await run(browserLauncherPath(root), ["https://example.com"])).code).toBe(2);
    for (const args of [[], ["file:///tmp/a"], ["https://example.com", "extra"], ["bad"]])
      expect((await run(browserLauncherPath(root), args)).code).toBe(1);
  });
  it.each([["https://example.com"], ["http://localhost:3000/callback"], ["HTTPS://EXAMPLE.COM"]])(
    "forwards a single HTTP URL through the open shim: %s",
    async (url) => {
      const root = await fixture();
      const requests = await respond(root, "opened");
      expect((await run(Path.join(browserLauncherDir(root), "open"), [url])).code).toBe(0);
      expect(requests).toEqual([{ url }]);
    },
  );
  it.each([
    ["-a", "Calculator"],
    ["/tmp/file"],
    ["https://example.com", "https://other.com"],
    ["mailto:user@example.com"],
    ["file:///tmp/a"],
    [],
  ])("passes other arguments unchanged to the system open: %j", async (...args) => {
    const root = await fixture();
    const shim = Path.join(browserLauncherDir(root), "open");
    const fallback = Path.join(root, "system-open");
    await FS.writeFile(fallback, "#!/bin/sh\nprintf '%s\\n' fallback \"$@\"\n", { mode: 0o700 });
    // Substitute only the OS executable, to observe argv without launching a real app.
    await FS.writeFile(shim, (await FS.readFile(shim, "utf8")).replace("/usr/bin/open", fallback));
    const result = await run(shim, args);
    expect(result.stdout.trim().split("\n")).toEqual(["fallback", ...args]);
    expect(result.stderr).toBe("");
  });
});
