import { execFile } from "node:child_process";
import { EventEmitter } from "node:events";
import * as FS from "node:fs/promises";
import * as OS from "node:os";
import * as Path from "node:path";
import { promisify } from "node:util";
import { expect, it, vi } from "vitest";
import { BrowserOpenAuthority } from "../apps/desktop/src/browser/BrowserOpenAuthority.ts";
import { ComputerHostChannel } from "../apps/desktop/src/computer/ComputerHostChannel.ts";
import { ComputerLeaseAuthority } from "../apps/desktop/src/computer/ComputerLeaseAuthority.ts";
import { startBrowserOpenBridge } from "../apps/server/src/browser/BrowserOpenBridge.ts";
import { browserLauncherPath } from "../apps/server/src/browser/BrowserOpenLauncher.ts";
import { DesktopComputerHost } from "../apps/server/src/computer/DesktopComputerHost.ts";

class IpcEndpoint extends EventEmitter {
  connected = true;
  peer;
  send(message, callback) {
    queueMicrotask(() => this.peer.emit("message", message));
    callback?.(null);
    return true;
  }
}

it.skipIf(process.platform === "win32")(
  "runs the generated launcher through the real socket, host, channel and consent authority",
  async () => {
    const root = await FS.mkdtemp(Path.join(OS.tmpdir(), "f5-browser-roundtrip-"));
    const backend = new IpcEndpoint();
    const desktop = new IpcEndpoint();
    backend.peer = desktop;
    desktop.peer = backend;
    const effects = {
      prompt: vi.fn(async () => 1),
      open: vi.fn(async () => {}),
      copy: vi.fn(),
    };
    const authority = new BrowserOpenAuthority(effects);
    const channel = new ComputerHostChannel(
      { lease: new ComputerLeaseAuthority(), disconnect() {} },
      () => ({ available: false, reason: "helper-missing" }),
      () => {},
      undefined,
      undefined,
      {
        openExternalUrl: (profile, url) => authority.request(profile, url),
        cancelBrowserOpen: (profile) => authority.cancelProfile(profile),
      },
    );
    channel.register("work", "incarnation", desktop);
    const host = new DesktopComputerHost("work", "incarnation", backend, true);
    const close = await startBrowserOpenBridge(root, host, true);
    try {
      const run = promisify(execFile);
      for (const url of ["https://example.com/login", "https://example.com/again"]) {
        const result = await run(browserLauncherPath(root), [url]);
        expect(result.stderr).toContain("Open this URL to continue: " + url);
        expect(effects.open).toHaveBeenLastCalledWith(url);
      }
      expect(effects.prompt).toHaveBeenCalledOnce();
      expect(effects.prompt.mock.calls[0][0].profileId).toBe("work");
      effects.prompt.mockResolvedValueOnce(2);
      await run(browserLauncherPath(root), ["https://other.example.com"]);
      expect(effects.copy).toHaveBeenCalledWith("https://other.example.com/");
      expect(effects.open).toHaveBeenCalledTimes(2);
    } finally {
      await close();
      host.close();
      desktop.emit("disconnect");
      await FS.rm(root, { recursive: true, force: true });
    }
  },
);
