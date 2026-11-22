import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { encodeBackendFrame } from "@t3tools/shared/backendFrames";
import { MAC_BACKEND_COMPUTER_SANDBOX } from "../backendComputerIsolation";
import {
  resolveVmLaunchAssets,
  VM_READINESS_TIMEOUT_MS,
  VM_STOP_GRACE_MS,
  vmBackendLauncher,
  VmSlotReservations,
  type VmLaunchAssets,
} from "./vmBackendLauncher";
import { VM_FORWARD_READY, VM_SHUTDOWN_BUDGET_MS } from "./vmSupervisor";

const archive = "/res/vm/f5-1.2.3-linux-arm64.tar.gz";
const manifest = {
  schemaVersion: 1,
  version: "1.2.3",
  artifacts: [
    {
      target: "linux-arm64",
      url: "https://github.com/lopes-felipe/f5/releases/download/v1.2.3/f5-1.2.3-linux-arm64.tar.gz",
      sha256: "d".repeat(64),
      size: 100,
    },
  ],
};
const lock = {
  image: {
    url: "https://github.com/lopes-felipe/f5/releases/download/vm-guest-image-abc/f5-guest.qcow2",
    sha256: "c".repeat(64),
    size: 10,
  },
};

function resolve(overrides: Partial<Parameters<typeof resolveVmLaunchAssets>[0]> = {}) {
  return resolveVmLaunchAssets({
    env: {
      F5_EXPERIMENTAL_LINUX_VM: "1",
      F5_VM_LIMACTL: "/lima/bin/limactl",
      F5_VM_BACKEND_ARCHIVE: archive,
    },
    platform: "darwin",
    arch: "arm64",
    resourcesPath: "/res",
    packaged: false,
    lock,
    exists: () => true,
    readFile: (path) => {
      expect(path).toBe("/res/vm/f5-1.2.3-linux-arm64.json");
      return JSON.stringify(manifest);
    },
    ...overrides,
  });
}

describe("resolveVmLaunchAssets", () => {
  it("resolves Lima, the backend archive and the pinned image", () => {
    expect(resolve()).toEqual({
      ok: true,
      assets: {
        limactl: "/lima/bin/limactl",
        backend: { archive, sha256: "d".repeat(64), version: "1.2.3" },
        imagePin: lock.image,
      },
    });
  });

  it("is off without the hidden flag", () => {
    expect(resolve({ env: { F5_VM_LIMACTL: "/l", F5_VM_BACKEND_ARCHIVE: archive } })).toMatchObject(
      { ok: false, reason: expect.stringMatching(/not enabled/) },
    );
  });

  it("needs Apple silicon", () => {
    expect(resolve({ arch: "x64" }).ok).toBe(false);
    expect(resolve({ platform: "linux" }).ok).toBe(false);
  });

  it("refuses missing Lima or a manifest for another archive", () => {
    expect(resolve({ exists: (path) => path !== "/lima/bin/limactl" })).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/Lima is missing/),
    });
    expect(
      resolve({
        readFile: () =>
          JSON.stringify({
            ...manifest,
            artifacts: [{ ...manifest.artifacts[0], url: "https://x.test/other.tar.gz" }],
          }),
      }),
    ).toMatchObject({ ok: false, reason: expect.stringMatching(/different archive/) });
  });

  it("refuses a build without a pinned image", () => {
    expect(resolve({ lock: { image: null } })).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/no pinned guest image/),
    });
  });

  it("ignores every development override in packaged builds", () => {
    const readFile = vi.fn(() => JSON.stringify(manifest));
    const resolved = resolve({
      packaged: true,
      env: {
        F5_EXPERIMENTAL_LINUX_VM: "1",
        F5_VM_LIMACTL: "/evil/limactl",
        F5_VM_BACKEND_ARCHIVE: "/evil/f5-1.2.3-linux-arm64.tar.gz",
        F5_VM_IMAGE_URL: "https://evil.test/image.qcow2",
        F5_VM_IMAGE_SHA256: "a".repeat(64),
        F5_VM_IMAGE_SIZE: "5",
      },
      exists: (path) => path === "/res/native/lima/bin/limactl",
      readFile,
    });
    // The bundled archive is absent here, so resolution stops there, never at /evil.
    expect(resolved).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/archive is missing/),
    });
    expect(readFile).not.toHaveBeenCalled();
  });

  it("resolves the bundled assets in packaged builds whatever the overrides say", () => {
    const resolved = resolve({
      packaged: true,
      env: {
        F5_EXPERIMENTAL_LINUX_VM: "1",
        F5_VM_LIMACTL: "/evil/limactl",
        F5_VM_BACKEND_ARCHIVE: "/evil/f5-1.2.3-linux-arm64.tar.gz",
        F5_VM_IMAGE_URL: "https://evil.test/image.qcow2",
        F5_VM_IMAGE_SHA256: "a".repeat(64),
        F5_VM_IMAGE_SIZE: "5",
      },
      exists: (path) => !path.startsWith("/evil"),
      readDir: (path) => {
        expect(path).toBe("/res/vm");
        return ["f5-1.2.3-linux-arm64.tar.gz", "f5-1.2.3-linux-arm64.json"];
      },
    });
    expect(resolved).toEqual({
      ok: true,
      assets: {
        limactl: "/res/native/lima/bin/limactl",
        backend: { archive, sha256: "d".repeat(64), version: "1.2.3" },
        imagePin: lock.image,
      },
    });
  });

  it("refuses, rather than throwing, when the bundled VM directory can't be read", () => {
    expect(
      resolve({
        packaged: true,
        readDir: () => {
          throw new Error("EACCES: permission denied");
        },
      }),
    ).toMatchObject({ ok: false, reason: expect.stringMatching(/could not be read: EACCES/) });
  });

  it("lets development builds override the image", () => {
    const resolved = resolve({
      env: {
        F5_EXPERIMENTAL_LINUX_VM: "1",
        F5_VM_LIMACTL: "/lima/bin/limactl",
        F5_VM_BACKEND_ARCHIVE: archive,
        F5_VM_IMAGE_URL: "https://dev.test/image.qcow2",
        F5_VM_IMAGE_SHA256: "a".repeat(64),
        F5_VM_IMAGE_SIZE: "5",
      },
    });
    expect(resolved.ok && resolved.assets.imagePin).toEqual({
      url: "https://dev.test/image.qcow2",
      sha256: "a".repeat(64),
      size: 5,
    });
  });
});

describe("VmSlotReservations", () => {
  it("lets three concurrent opens take only the two VM slots", () => {
    const slots = new VmSlotReservations();
    const a = slots.reserve("a", []);
    slots.reserve("b", []);
    // Neither a nor b counts as running yet; their reservations alone fill the cap.
    expect(() => slots.reserve("c", [])).toThrow(/Two Linux VM profiles/);
    a();
    expect(() => slots.reserve("c", [])).not.toThrow();
  });

  it("counts running VMs and doesn't double-count a profile that is both", () => {
    const slots = new VmSlotReservations();
    const release = slots.reserve("a", []);
    // `a` is now opening and running: one slot, so `b` still fits and `c` doesn't.
    expect(() => slots.reserve("b", ["a"])).not.toThrow();
    expect(() => slots.reserve("c", ["a"])).toThrow(/Two Linux VM profiles/);
    release();
    release();
    // Only `b` is left.
    expect(() => slots.reserve("c", [])).not.toThrow();
  });

  it("lets a profile reopen while it holds its own slot", () => {
    const slots = new VmSlotReservations();
    slots.reserve("a", []);
    slots.reserve("b", []);
    expect(() => slots.reserve("a", ["b"])).not.toThrow();
  });
});

function fakeSupervisor() {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const child = Object.assign(new EventEmitter(), {
    pid: 9,
    stdin,
    stdout,
    stderr: new PassThrough(),
  });
  return { child: child as unknown as ChildProcess, stdin, stdout };
}

describe("vmBackendLauncher", () => {
  const assets: VmLaunchAssets = {
    limactl: "/lima/bin/limactl",
    backend: { archive, sha256: "d".repeat(64), version: "1.2.3" },
    imagePin: lock.image,
  };
  const request = {
    entry: "/server/index.mjs",
    nodeArgs: [],
    cwd: "/home",
    env: { HOME: "/Users/me", TMPDIR: "/tmp/me", T3CODE_AUTH_TOKEN: "secret", GH_TOKEN: "gh" },
    incarnation: "11111111-2222-4333-8444-555555555555",
    profileId: "0123456789abcdef0123456789abcdef",
    profileStateDir: "/Users/me/.f5/userdata-profiles/0123456789abcdef0123456789abcdef",
    port: 41000,
    authToken: "a".repeat(48),
  };

  it("runs the supervisor sandboxed, with no inherited secrets, and sends the boot line first", async () => {
    const { child, stdin, stdout } = fakeSupervisor();
    const spawn = vi.fn(() => child);
    const launcher = vmBackendLauncher({
      platform: "darwin",
      executable: "/F5",
      supervisorEntry: "/app/vmSupervisorEntry.js",
      stateDir: "/Users/me/.f5/userdata",
      assets,
      startupErrorPath: (id) => `/errors/${id}.json`,
      spawn,
    });
    expect(launcher.environment).toBe("linux-vm");
    expect(launcher.readinessTimeoutMs).toBe(VM_READINESS_TIMEOUT_MS);
    // Main must not force-kill the supervisor while `limactl stop` can still be running.
    expect(launcher.stopGraceMs).toBe(VM_STOP_GRACE_MS);
    expect(VM_STOP_GRACE_MS).toBeGreaterThan(VM_SHUTDOWN_BUDGET_MS);
    const launch = launcher.launch(request);
    const [command, args, options] = spawn.mock.calls[0] as unknown as [
      string,
      string[],
      { env: NodeJS.ProcessEnv; stdio: unknown },
    ];
    expect(command).toBe("/usr/bin/sandbox-exec");
    expect(args).toEqual(["-p", MAC_BACKEND_COMPUTER_SANDBOX, "/F5", "/app/vmSupervisorEntry.js"]);
    expect(options.stdio).toEqual(["pipe", "pipe", "pipe"]);
    expect(Object.keys(options.env).sort()).toEqual([
      "ELECTRON_RUN_AS_NODE",
      "F5_VM_SUPERVISOR_CONFIG",
      "HOME",
      "LANG",
      "PATH",
      "TMPDIR",
    ]);
    const config = JSON.parse(options.env.F5_VM_SUPERVISOR_CONFIG!);
    expect(config).toMatchObject({
      profileId: request.profileId,
      incarnation: request.incarnation,
      port: 41000,
      limaHome: "/Users/me/.f5/userdata/vm/0123456789abcdef",
      vmDir: `${request.profileStateDir}/vm`,
      imageCacheDir: "/Users/me/.f5/userdata/vm/images",
      startupErrorPath: `/errors/${request.profileId}.json`,
    });
    expect(JSON.stringify(config)).not.toContain(request.authToken);

    expect(stdin.read()?.toString()).toBe(
      JSON.stringify({ port: 41000, authToken: request.authToken, profileId: request.profileId }) +
        "\n",
    );
    expect(launch.stdoutIsLog).toBe(false);
    expect(launch.channel.hostPid).toBeUndefined();
    const received: unknown[] = [];
    launch.channel.onMessage((message) => received.push(message));
    let reachable = false;
    void launch.reachable!.then(() => {
      reachable = true;
    });
    // The supervisor's own frame comes first and is consumed; the backend's follow.
    stdout.write(encodeBackendFrame({ type: VM_FORWARD_READY, incarnation: request.incarnation }));
    stdout.write(encodeBackendFrame({ type: "hello" }));
    await vi.waitFor(() => expect(received).toEqual([{ type: "hello" }]));
    expect(reachable).toBe(true);
  });

  it.each([
    ["a backend frame", { type: "hello" }],
    ["another incarnation's signal", { type: VM_FORWARD_READY, incarnation: "other" }],
  ])("closes the channel, never reachable, when %s comes first", async (_name, first) => {
    const { child, stdout } = fakeSupervisor();
    const launch = vmBackendLauncher({
      platform: "darwin",
      executable: "/F5",
      supervisorEntry: "/app/vmSupervisorEntry.js",
      stateDir: "/Users/me/.f5/userdata",
      assets,
      startupErrorPath: (id) => `/errors/${id}.json`,
      spawn: () => child,
    }).launch(request);
    const received: unknown[] = [];
    launch.channel.onMessage((message) => received.push(message));
    stdout.write(encodeBackendFrame(first));
    await expect(launch.reachable).rejects.toThrow(/before the port was forwarded/);
    expect(launch.channel.connected).toBe(false);
    expect(received).toEqual([]);
  });
});
