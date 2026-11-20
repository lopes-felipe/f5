import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import { MAC_BACKEND_COMPUTER_SANDBOX } from "./backendComputerIsolation";
import {
  hostBackendLauncher,
  LINUX_VM_UNAVAILABLE_MESSAGE,
  resolveProfileBackendLauncher,
  type ProfileBackendLauncher,
} from "./profileBackendLauncher";

function fakeChild() {
  return Object.assign(new EventEmitter(), {
    pid: 7,
    connected: true,
    send: vi.fn(),
    disconnect: vi.fn(),
  }) as unknown as ChildProcess;
}

describe("profile backend launchers", () => {
  it("launches host backends in the GUI-denial sandbox with inherited IPC", () => {
    const child = fakeChild();
    const spawn = vi.fn(() => child);
    const launcher = hostBackendLauncher({ platform: "darwin", executable: "/F5", spawn });
    const launch = launcher.launch({
      entry: "/backend.js",
      nodeArgs: ["--require", "/cache.js"],
      cwd: "/cwd",
      env: { KEEP: "1" },
      incarnation: "inc",
    });
    expect(spawn).toHaveBeenCalledWith(
      "/usr/bin/sandbox-exec",
      ["-p", MAC_BACKEND_COMPUTER_SANDBOX, "/F5", "--require", "/cache.js", "/backend.js"],
      {
        cwd: "/cwd",
        env: {
          KEEP: "1",
          ELECTRON_RUN_AS_NODE: "1",
          F5_DESKTOP_COMPUTER_HOST: "ipc",
          F5_DESKTOP_BACKEND_INCARNATION: "inc",
        },
        stdio: ["ignore", "pipe", "pipe", "ipc"],
      },
    );
    expect(launch.process).toBe(child);
    expect(launch.channel.hostPid).toBe(7);
  });

  it("never resolves a Linux VM profile to the host launcher", () => {
    const host = hostBackendLauncher({ platform: "linux", executable: "/F5", spawn: vi.fn() });
    expect(resolveProfileBackendLauncher({}, { host })).toEqual({ ok: true, launcher: host });
    expect(resolveProfileBackendLauncher({ executionEnvironment: "host" }, { host }).ok).toBe(true);
    expect(resolveProfileBackendLauncher({ executionEnvironment: "linux-vm" }, { host })).toEqual({
      ok: false,
      message: LINUX_VM_UNAVAILABLE_MESSAGE,
    });
    // A launcher registered under the wrong environment is refused as well.
    expect(
      resolveProfileBackendLauncher({ executionEnvironment: "linux-vm" }, { "linux-vm": host }).ok,
    ).toBe(false);
    const vm: ProfileBackendLauncher = { environment: "linux-vm", launch: vi.fn() };
    expect(
      resolveProfileBackendLauncher({ executionEnvironment: "linux-vm" }, { "linux-vm": vm }).ok,
    ).toBe(true);
  });
});
