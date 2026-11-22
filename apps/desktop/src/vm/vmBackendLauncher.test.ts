import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { encodeBackendFrame } from "@t3tools/shared/backendFrames";
import { MAC_BACKEND_COMPUTER_SANDBOX } from "../backendComputerIsolation";
import {
  resolveVmLaunchAssets,
  VM_READINESS_TIMEOUT_MS,
  vmBackendLauncher,
  type VmLaunchAssets,
} from "./vmBackendLauncher";

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
    stdout.write(encodeBackendFrame({ type: "hello" }));
    await vi.waitFor(() => expect(received).toEqual([{ type: "hello" }]));
  });
});
