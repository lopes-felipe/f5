import { EventEmitter } from "node:events";
import type * as ChildProcess from "node:child_process";
import * as FS from "node:fs";
import * as OS from "node:os";
import * as Path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BACKEND_ARCHIVE, GUEST_IMAGE, pinnedDownloadPath } from "./guestImage";
import { inProcessLocks } from "./testing/inProcessLocks";
import {
  acquireInstanceLock,
  GUEST_REFUSED_EXIT_CODE,
  parseVmSupervisorConfig,
  runVmSupervisor,
  waitForExit,
  VM_REFUSED_EXIT_CODE,
  VM_STOP_FAILED_EXIT_CODE,
  VmSupervisor,
  VmSupervisorRefusal,
  type RunResult,
  type VmSupervisorConfig,
  type VmSupervisorDeps,
} from "./vmSupervisor";

const imageSha256 = "c".repeat(64);
const backendSha256 = "d".repeat(64);
let root: string;
let config: VmSupervisorConfig;
let locks: ReturnType<typeof inProcessLocks>;

beforeEach(() => {
  root = FS.mkdtempSync(Path.join(OS.tmpdir(), "f5-vm-supervisor-"));
  locks = inProcessLocks();
  config = {
    profileId: "0123456789abcdef0123456789abcdef",
    incarnation: "11111111-2222-4333-8444-555555555555",
    port: 41000,
    limactl: "/lima/bin/limactl",
    limaHome: Path.join(root, "lima"),
    vmDir: Path.join(root, "profile", "vm"),
    imageCacheDir: Path.join(root, "images"),
    backendCacheDir: Path.join(root, "backends"),
    imagePin: { url: "https://example.com/i.qcow2", sha256: imageSha256, size: 10 },
    backend: {
      archive: "/res/f5-1.2.3-linux-arm64.tar.gz",
      sha256: backendSha256,
      version: "1.2.3",
    },
    startupErrorPath: Path.join(root, "last-startup-error.json"),
  };
});
afterEach(() => {
  FS.rmSync(root, { recursive: true, force: true });
});

const ok = (stdout = ""): RunResult => ({ code: 0, stdout, stderr: "" });
const installed = { version: "1.2.3", sha256: backendSha256 };

type GuestStatus = {
  ready: boolean;
  reason?: string;
  backends?: Array<{ version: string; sha256: string }>;
};

/** A fake Lima (and ssh) holding one instance's status; records each command. */
function fakeLima(options: {
  status?: string | null;
  /** Successive `f5-guest status` answers; the last one repeats. */
  guestStatus?: GuestStatus | GuestStatus[];
  installCode?: number;
  copyFails?: boolean;
  /** Lima's stop leaves the VM running, even when forced. */
  stopFails?: boolean;
  /** The graceful stop leaves it running; the forced one works. */
  needsForce?: boolean;
  /** The ssh master's `-O check` answer. */
  forwardCheck?: () => RunResult;
  /** Runs before each command, e.g. to abort mid-preparation. */
  before?: (args: ReadonlyArray<string>) => void;
}) {
  let status = options.status ?? null;
  const statuses = [options.guestStatus ?? { ready: true, backends: [] }].flat();
  const calls: string[][] = [];
  const ssh: string[][] = [];
  const run = vi.fn(
    async (
      command: string,
      args: ReadonlyArray<string>,
      _timeoutMs?: number,
      _signal?: AbortSignal,
    ): Promise<RunResult> => {
      if (command === "ssh") {
        ssh.push([...args]);
        const operation = args[args.indexOf("-O") + 1];
        if (operation === "check") return options.forwardCheck?.() ?? ok();
        return { code: 255, stdout: "", stderr: "Control socket connect: No such file" };
      }
      expect(command).toBe(config.limactl);
      calls.push([...args]);
      options.before?.(args);
      const [verb] = args;
      if (verb === "list") return ok(status ? JSON.stringify({ name: "f5", status }) + "\n" : "");
      if (verb === "disk") {
        FS.mkdirSync(Path.join(config.limaHome, "_disks", "f5-data"), { recursive: true });
        return ok();
      }
      if (verb === "create") {
        status = "Stopped";
        return ok();
      }
      if (verb === "start") {
        status = "Running";
        return ok();
      }
      if (verb === "stop") {
        const forced = args.includes("--force");
        if (status === null) return { code: 1, stdout: "", stderr: "instance not found" };
        if (options.stopFails || (options.needsForce && !forced))
          return { code: 1, stdout: "", stderr: "timed out" };
        status = "Stopped";
        return ok();
      }
      if (verb === "delete") {
        status = null;
        return ok();
      }
      if (verb === "copy")
        return options.copyFails ? { code: 1, stdout: "", stderr: "no space left" } : ok();
      if (verb === "shell") {
        const tool = args.slice(args.indexOf("/opt/f5/bin/f5-guest") + 1);
        if (tool[0] === "status") {
          const guest = statuses.length > 1 ? statuses.shift()! : statuses[0]!;
          return { code: guest.ready ? 0 : 77, stdout: JSON.stringify(guest) + "\n", stderr: "" };
        }
        if (tool[0] === "install")
          return { code: options.installCode ?? 0, stdout: "", stderr: "f5-guest: bad archive\n" };
      }
      throw new Error(`unexpected limactl ${args.join(" ")}`);
    },
  );
  return {
    run,
    calls,
    ssh,
    verbs: () => calls.map((args) => args[0]),
    status: () => status,
  };
}

/** Lima's image paths are POSIX on every platform the tests run on. */
const imagePath = `/cache/images/${imageSha256}.qcow2`;

/** Every lease the default `leaseDownload` handed out, to check each was released. */
let leases: Array<{ kind: string; path: string; release: ReturnType<typeof vi.fn> }> = [];
beforeEach(() => {
  leases = [];
});

const fakeLease: VmSupervisorDeps["leaseDownload"] = async (kind, pin, cacheDir) => {
  const lease = {
    kind: kind.label,
    path: kind === GUEST_IMAGE ? imagePath : pinnedDownloadPath(cacheDir, pin.sha256, kind),
    release: vi.fn(),
  };
  leases.push(lease);
  return lease;
};

function deps(
  run: VmSupervisorDeps["run"],
  spawn?: VmSupervisorDeps["spawn"],
  extra: Partial<VmSupervisorDeps> = {},
): VmSupervisorDeps {
  return {
    run,
    spawn: spawn ?? (() => fakeProcess()),
    ensureImage: async () => imagePath,
    ensureBackendArchive: async () => {
      throw new Error("unexpected backend download");
    },
    leaseDownload: fakeLease,
    signalForwardReady: vi.fn(),
    writeStderr: () => undefined,
    lock: locks.acquire,
    log: () => undefined,
    pollMs: 1,
    ...extra,
  };
}

type FakeProcess = ChildProcess.ChildProcess & {
  finish(code: number, stderr?: string): void;
  terminate(signal: NodeJS.Signals): void;
};

function fakeProcess(): FakeProcess {
  const stderr = new PassThrough();
  const child = Object.assign(new EventEmitter(), {
    exitCode: null as number | null,
    signalCode: null as NodeJS.Signals | null,
    stderr,
    kill: vi.fn((signal?: NodeJS.Signals) => {
      child.terminate(signal ?? "SIGTERM");
      return true;
    }),
    finish(code: number, message?: string) {
      if (child.exitCode !== null || child.signalCode !== null) return;
      if (message) stderr.emit("data", Buffer.from(message));
      child.exitCode = code;
      child.emit("exit", code, null);
    },
    terminate(signal: NodeJS.Signals) {
      if (child.exitCode !== null || child.signalCode !== null) return;
      child.signalCode = signal;
      child.emit("exit", null, signal);
    },
  });
  return child as unknown as FakeProcess;
}

/** Records spawned children: [0] is the ssh forward, [1] the backend. */
function spawnRecorder() {
  const spawned: Array<{ command: string; args: string[]; stdio: unknown; child: FakeProcess }> =
    [];
  const spawn = vi.fn((command: string, args: ReadonlyArray<string>, stdio: unknown) => {
    const child = fakeProcess();
    spawned.push({ command, args: [...args], stdio, child });
    return child;
  });
  return { spawn, spawned, children: () => spawned.map((entry) => entry.child) };
}

const startupError = () => JSON.parse(FS.readFileSync(config.startupErrorPath, "utf8"));

describe("parseVmSupervisorConfig", () => {
  it("accepts a well-formed configuration", () => {
    expect(parseVmSupervisorConfig(JSON.stringify(config))).toEqual(config);
  });

  it.each([
    { profileId: "../x" },
    { incarnation: "not-a-uuid" },
    { port: 80 },
    { limaHome: "relative" },
    { backend: { archive: "/a", sha256: "x", version: "1" } },
    { backend: { archive: "/a", sha256: backendSha256, version: "../1" } },
    { backend: { archive: "relative", sha256: backendSha256, version: "1" } },
    { backend: { sha256: backendSha256, version: "1" } },
    {
      backend: {
        archive: "/a",
        download: { url: "https://example.com/b.tar.gz", size: 5 },
        sha256: backendSha256,
        version: "1",
      },
    },
    {
      backend: {
        download: { url: "http://example.com/b.tar.gz", size: 5 },
        sha256: backendSha256,
        version: "1",
      },
    },
    {
      backend: {
        download: { url: "https://example.com/b.tar.gz", size: 0 },
        sha256: backendSha256,
        version: "1",
      },
    },
    { backendCacheDir: "relative" },
  ])("refuses %#", (patch) => {
    expect(() => parseVmSupervisorConfig(JSON.stringify({ ...config, ...patch }))).toThrow(
      VmSupervisorRefusal,
    );
  });

  it("refuses a missing configuration", () => {
    expect(() => parseVmSupervisorConfig(undefined)).toThrow(VmSupervisorRefusal);
  });
});

describe("VmSupervisor.prepare", () => {
  it("provisions a new VM: data disk, instance, boot, backend install", async () => {
    const lima = fakeLima({});
    await new VmSupervisor(config, deps(lima.run)).prepare();
    expect(lima.verbs()).toEqual(["list", "disk", "create", "start", "shell", "copy", "shell"]);
    const yaml = JSON.parse(FS.readFileSync(Path.join(config.vmDir, "lima.yaml"), "utf8"));
    expect(yaml.images[0]).toMatchObject({ location: imagePath, digest: `sha256:${imageSha256}` });
    // The image was held from create through the first boot, then released.
    expect(leases.map((lease) => lease.kind)).toEqual(["guest image"]);
    expect(leases[0]!.release).toHaveBeenCalledOnce();
    expect(JSON.parse(FS.readFileSync(Path.join(config.vmDir, "instance.json"), "utf8"))).toEqual({
      imageSha256,
      backendSha256,
    });
    expect(lima.calls[5]).toEqual([
      "copy",
      config.backend.archive,
      `f5:/tmp/f5-backend-${config.incarnation}.tar.gz`,
    ]);
    expect(lima.calls[6]).toEqual([
      "shell",
      "--workdir",
      "/",
      "f5",
      "sudo",
      "-n",
      "/opt/f5/bin/f5-guest",
      "install",
      "1.2.3",
      backendSha256,
      `/tmp/f5-backend-${config.incarnation}.tar.gz`,
    ]);
  });

  it("reuses a running VM that already has this image and this exact backend build", async () => {
    FS.mkdirSync(config.vmDir, { recursive: true });
    FS.writeFileSync(Path.join(config.vmDir, "instance.json"), JSON.stringify({ imageSha256 }));
    FS.mkdirSync(Path.join(config.limaHome, "_disks", "f5-data"), { recursive: true });
    const lima = fakeLima({
      status: "Running",
      guestStatus: { ready: true, backends: [installed] },
    });
    await new VmSupervisor(config, deps(lima.run)).prepare();
    expect(lima.verbs()).toEqual(["list", "shell"]);
  });

  it("downloads a pinned backend before booting, copies it under a lease, then prunes", async () => {
    const download = { url: "https://example.com/f5-1.2.3-linux-arm64.tar.gz", size: 100 };
    config = { ...config, backend: { version: "1.2.3", sha256: backendSha256, download } };
    FS.mkdirSync(config.backendCacheDir, { recursive: true });
    const stale = Path.join(config.backendCacheDir, `${"e".repeat(64)}.tar.gz`);
    FS.writeFileSync(stale, "old build");
    const downloaded = pinnedDownloadPath(config.backendCacheDir, backendSha256, BACKEND_ARCHIVE);
    const lima = fakeLima({});
    let verbsAtDownload: Array<string | undefined> = [];
    const ensureBackendArchive = vi.fn(async () => {
      verbsAtDownload = lima.verbs();
      return downloaded;
    });
    await new VmSupervisor(config, deps(lima.run, undefined, { ensureBackendArchive })).prepare();
    expect(ensureBackendArchive).toHaveBeenCalledWith(
      { ...download, sha256: backendSha256 },
      config.backendCacheDir,
      expect.any(AbortSignal),
    );
    // The VM didn't hold its memory through the download.
    expect(verbsAtDownload).not.toContain("start");
    expect(lima.calls[5]).toEqual([
      "copy",
      downloaded,
      `f5:/tmp/f5-backend-${config.incarnation}.tar.gz`,
    ]);
    const backendLease = leases.find((lease) => lease.kind === BACKEND_ARCHIVE.label)!;
    expect(backendLease.release).toHaveBeenCalledOnce();
    expect(FS.existsSync(stale)).toBe(false);

    // A warm start of a guest that has this build downloads and leases nothing.
    ensureBackendArchive.mockClear();
    leases = [];
    const warm = fakeLima({
      status: "Running",
      guestStatus: { ready: true, backends: [installed] },
    });
    await new VmSupervisor(config, deps(warm.run, undefined, { ensureBackendArchive })).prepare();
    expect(ensureBackendArchive).not.toHaveBeenCalled();
    expect(leases).toEqual([]);
  });

  it("installs from a lease after boot when the record wrongly says the guest has the build", async () => {
    const download = { url: "https://example.com/f5-1.2.3-linux-arm64.tar.gz", size: 100 };
    config = { ...config, backend: { version: "1.2.3", sha256: backendSha256, download } };
    FS.mkdirSync(config.vmDir, { recursive: true });
    FS.writeFileSync(
      Path.join(config.vmDir, "instance.json"),
      JSON.stringify({ imageSha256, backendSha256 }),
    );
    FS.mkdirSync(Path.join(config.limaHome, "_disks", "f5-data"), { recursive: true });
    const lima = fakeLima({ status: "Stopped" });
    await new VmSupervisor(config, deps(lima.run)).prepare();
    expect(lima.verbs()).toEqual(["list", "start", "shell", "copy", "shell"]);
    expect(leases.map((lease) => lease.kind)).toEqual([BACKEND_ARCHIVE.label]);
    expect(leases[0]!.release).toHaveBeenCalledOnce();
  });

  it("releases the backend lease when the copy fails", async () => {
    const download = { url: "https://example.com/f5-1.2.3-linux-arm64.tar.gz", size: 100 };
    config = { ...config, backend: { version: "1.2.3", sha256: backendSha256, download } };
    const lima = fakeLima({ copyFails: true });
    await expect(
      new VmSupervisor(
        config,
        deps(lima.run, undefined, { ensureBackendArchive: async () => "/cache/b.tar.gz" }),
      ).prepare(),
    ).rejects.toThrow(/Copying the backend/);
    const backendLease = leases.find((lease) => lease.kind === BACKEND_ARCHIVE.label)!;
    expect(backendLease.release).toHaveBeenCalledOnce();
  });

  it("refuses without installing when the backend download fails", async () => {
    config = {
      ...config,
      backend: {
        version: "1.2.3",
        sha256: backendSha256,
        download: { url: "https://example.com/b.tar.gz", size: 100 },
      },
    };
    const lima = fakeLima({});
    const ensureBackendArchive = async () => {
      throw new Error("The F5 backend archive failed digest verification and was discarded.");
    };
    await expect(
      runVmSupervisor(
        config,
        deps(lima.run, undefined, { ensureBackendArchive }),
        new AbortController().signal,
      ),
    ).resolves.toBe(VM_REFUSED_EXIT_CODE);
    expect(startupError().message).toMatch(/digest verification/);
    expect(lima.verbs()).not.toContain("copy");
  });

  it("reinstalls a backend whose version matches but whose archive digest doesn't", async () => {
    const lima = fakeLima({
      guestStatus: { ready: true, backends: [{ version: "1.2.3", sha256: "e".repeat(64) }] },
    });
    await new VmSupervisor(config, deps(lima.run)).prepare();
    expect(lima.verbs().slice(-2)).toEqual(["copy", "shell"]);
  });

  it("replaces the root disk when the pinned image changes, keeping the data disk", async () => {
    FS.mkdirSync(config.vmDir, { recursive: true });
    FS.writeFileSync(
      Path.join(config.vmDir, "instance.json"),
      JSON.stringify({ imageSha256: "e".repeat(64) }),
    );
    FS.mkdirSync(Path.join(config.limaHome, "_disks", "f5-data"), { recursive: true });
    const lima = fakeLima({
      status: "Running",
      guestStatus: { ready: true, backends: [installed] },
    });
    await new VmSupervisor(config, deps(lima.run)).prepare();
    expect(lima.verbs()).toEqual(["list", "stop", "list", "delete", "create", "start", "shell"]);
    expect(FS.existsSync(Path.join(config.limaHome, "_disks", "f5-data"))).toBe(true);
  });

  it("refuses to replace the root disk of a VM Lima can't stop", async () => {
    FS.mkdirSync(config.vmDir, { recursive: true });
    FS.writeFileSync(
      Path.join(config.vmDir, "instance.json"),
      JSON.stringify({ imageSha256: "e".repeat(64) }),
    );
    const lima = fakeLima({ status: "Running", stopFails: true });
    await expect(new VmSupervisor(config, deps(lima.run)).prepare()).rejects.toThrow(
      /could not be stopped/,
    );
    expect(lima.verbs()).not.toContain("delete");
  });

  it("refuses a guest whose policy check fails, without retrying", async () => {
    const lima = fakeLima({ guestStatus: { ready: false, reason: "the f5 user has sudo rights" } });
    await expect(new VmSupervisor(config, deps(lima.run)).prepare()).rejects.toThrow(/sudo rights/);
    expect(lima.verbs()).toEqual(["list", "disk", "create", "start", "shell"]);
  });

  it("waits while a booting guest is still loading its egress policy", async () => {
    const lima = fakeLima({
      guestStatus: [
        { ready: false, reason: "the data disk is not attached" },
        { ready: false, reason: "the egress policy is not loaded" },
        { ready: true, backends: [installed] },
      ],
    });
    await new VmSupervisor(config, deps(lima.run)).prepare();
    expect(lima.verbs()).toEqual(["list", "disk", "create", "start", "shell", "shell", "shell"]);
  });

  it("refuses status output that isn't a readiness report", async () => {
    const run = vi.fn(async (_command: string, args: ReadonlyArray<string>) =>
      args[0] === "shell" ? { code: 0, stdout: "garbage\n", stderr: "" } : ok(),
    );
    await expect(new VmSupervisor(config, deps(run)).prepare()).rejects.toThrow(/not ready/);
  });

  it("refuses foreign Lima configuration that would merge into the instance", async () => {
    FS.mkdirSync(Path.join(config.limaHome, "_config"), { recursive: true });
    FS.writeFileSync(Path.join(config.limaHome, "_config", "override.yaml"), "mounts: []\n");
    const lima = fakeLima({});
    await expect(new VmSupervisor(config, deps(lima.run)).prepare()).rejects.toThrow(
      /override\.yaml/,
    );
    expect(lima.calls).toEqual([]);
  });

  it("passes the stop signal to every Lima command and the image download", async () => {
    const stop = new AbortController();
    const lima = fakeLima({});
    const ensureImage = vi.fn(async () => imagePath);
    await new VmSupervisor(config, { ...deps(lima.run), ensureImage }, stop.signal).prepare();
    expect(ensureImage).toHaveBeenCalledWith(config.imagePin, config.imageCacheDir, stop.signal);
    for (const call of lima.run.mock.calls) expect(call[3]).toBe(stop.signal);
  });
});

describe("VmSupervisor.stopVm", () => {
  it("confirms the stop with Lima", async () => {
    const lima = fakeLima({ status: "Running" });
    await expect(new VmSupervisor(config, deps(lima.run)).stopVm()).resolves.toBe(true);
    expect(lima.verbs()).toEqual(["stop", "list"]);
  });

  it("forces the VM off when the graceful stop leaves it running", async () => {
    const lima = fakeLima({ status: "Running", needsForce: true });
    await expect(new VmSupervisor(config, deps(lima.run)).stopVm()).resolves.toBe(true);
    expect(lima.calls.map((args) => args.join(" "))).toEqual([
      "stop f5",
      "list --json",
      "stop --force f5",
      "list --json",
    ]);
  });

  it("reports a VM Lima can't stop", async () => {
    const lima = fakeLima({ status: "Running", stopFails: true });
    await expect(new VmSupervisor(config, deps(lima.run)).stopVm()).resolves.toBe(false);
  });

  it("counts an absent instance as stopped", async () => {
    const lima = fakeLima({});
    await expect(new VmSupervisor(config, deps(lima.run)).stopVm()).resolves.toBe(true);
  });
});

describe("runVmSupervisor", () => {
  it("forwards the port, tells main it is reachable, then runs the backend on main's stdio", async () => {
    const lima = fakeLima({});
    const { spawn, spawned } = spawnRecorder();
    const signalForwardReady = vi.fn(() => {
      // The forward is up and the backend not started yet.
      expect(spawned.map((entry) => entry.command)).toEqual(["ssh"]);
    });
    const result = runVmSupervisor(
      config,
      deps(lima.run, spawn, { signalForwardReady }),
      new AbortController().signal,
    );
    await vi.waitFor(() => expect(spawned).toHaveLength(2));
    const [forwards, backend] = spawned;
    const control = Path.join(config.limaHome, "f5", "ctl");
    expect(forwards!.command).toBe("ssh");
    expect(forwards!.args).toEqual(
      expect.arrayContaining([
        "ExitOnForwardFailure=yes",
        "-L",
        "127.0.0.1:41000:127.0.0.1:41000",
        "lima-f5",
      ]),
    );
    // The control socket is its own argument, never part of an `-o` line.
    expect(forwards!.args.slice(2, 4)).toEqual(["-S", control]);
    expect(forwards!.args.some((arg) => arg.startsWith("ControlPath"))).toBe(false);
    expect(forwards!.stdio).toEqual(["ignore", "ignore", "pipe"]);
    // A stale master goes first; readiness is the new master's own answer.
    expect(lima.ssh.map((args) => args[args.indexOf("-O") + 1])).toEqual(["exit", "check"]);
    expect(signalForwardReady).toHaveBeenCalledOnce();
    expect(backend!.args).toEqual([
      "shell",
      "--workdir",
      "/",
      "f5",
      "sudo",
      "-n",
      "/opt/f5/bin/f5-guest",
      "launch",
      config.incarnation,
      "1.2.3",
      backendSha256,
    ]);
    expect(backend!.stdio).toEqual(["inherit", "inherit", "pipe"]);
    backend!.child.finish(3);
    await expect(result).resolves.toBe(3);
    expect(forwards!.child.kill).toHaveBeenCalled();
    // A crash shuts the VM down too: it runs only while a supervisor does.
    expect(lima.verbs().slice(-2)).toEqual(["stop", "list"]);
    expect(lima.status()).toBe("Stopped");
  });

  it("refuses with the port named when the forward can't bind it, before any backend", async () => {
    const lima = fakeLima({ forwardCheck: () => ({ code: 255, stdout: "", stderr: "" }) });
    const { spawn, spawned } = spawnRecorder();
    const signalForwardReady = vi.fn();
    const result = runVmSupervisor(
      config,
      deps(lima.run, spawn, { signalForwardReady }),
      new AbortController().signal,
    );
    await vi.waitFor(() => expect(spawned).toHaveLength(1));
    spawned[0]!.child.finish(255, "bind [127.0.0.1]:41000: Address already in use.\n");
    await expect(result).resolves.toBe(VM_REFUSED_EXIT_CODE);
    expect(startupError().message).toMatch(
      /Port 41000 could not be forwarded.*Address already in use/,
    );
    // ssh's own trailing period isn't doubled.
    expect(startupError().message).not.toMatch(/\.\./);
    expect(signalForwardReady).not.toHaveBeenCalled();
    expect(spawned).toHaveLength(1);
    expect(lima.status()).toBe("Stopped");
  });

  it("writes the refusal for main, stops the VM and exits 78 when it can't be prepared", async () => {
    const lima = fakeLima({ guestStatus: { ready: false, reason: "the f5 user has sudo rights" } });
    await expect(
      runVmSupervisor(config, deps(lima.run), new AbortController().signal),
    ).resolves.toBe(VM_REFUSED_EXIT_CODE);
    expect(startupError()).toEqual({ message: expect.stringMatching(/sudo rights/) });
    // Nothing would own a booted VM after a refusal.
    expect(lima.verbs().slice(-2)).toEqual(["stop", "list"]);
    expect(locks.held.size).toBe(0);
  });

  it("logs a failed Lima command's whole output, not just the refusal's last line", async () => {
    const lima = fakeLima({ installCode: 1 });
    const logged: string[] = [];
    const writeStderr = (chunk: Uint8Array) => logged.push(Buffer.from(chunk).toString());
    await expect(
      runVmSupervisor(
        config,
        deps(lima.run, undefined, { writeStderr }),
        new AbortController().signal,
      ),
    ).resolves.toBe(VM_REFUSED_EXIT_CODE);
    expect(startupError()).toEqual({ message: expect.stringMatching(/bad archive/) });
    expect(logged.join("")).toContain(
      "[vm] Installing the backend in the VM (exit 1) output:\nf5-guest: bad archive\n",
    );
  });

  it("tells main when a refusal leaves a VM Lima can't stop", async () => {
    const lima = fakeLima({
      guestStatus: { ready: false, reason: "the f5 user has sudo rights" },
      stopFails: true,
    });
    await expect(
      runVmSupervisor(config, deps(lima.run), new AbortController().signal),
    ).resolves.toBe(VM_REFUSED_EXIT_CODE);
    expect(startupError()).toEqual({
      message: expect.stringMatching(/sudo rights.*could not be shut down/),
      vmStillRunning: true,
    });
  });

  it("abandons preparation when main stops the profile, then stops the VM", async () => {
    const stop = new AbortController();
    const lima = fakeLima({
      before: (args) => {
        if (args[0] === "start") stop.abort();
      },
    });
    const spawn = vi.fn(() => fakeProcess());
    await expect(runVmSupervisor(config, deps(lima.run, spawn), stop.signal)).resolves.toBe(0);
    expect(lima.verbs()).toEqual(["list", "disk", "create", "start", "stop", "list"]);
    expect(spawn).not.toHaveBeenCalled();
  });

  it("exits VM_STOP_FAILED when main stops the profile and the VM won't go down", async () => {
    const lima = fakeLima({ stopFails: true });
    const { spawn, children } = spawnRecorder();
    const stop = new AbortController();
    const result = runVmSupervisor(config, deps(lima.run, spawn), stop.signal);
    await vi.waitFor(() => expect(children()).toHaveLength(2));
    stop.abort();
    await expect(result).resolves.toBe(VM_STOP_FAILED_EXIT_CODE);
  });

  it("passes the guest's own refusal reason to main", async () => {
    const lima = fakeLima({});
    const { spawn, children } = spawnRecorder();
    const result = runVmSupervisor(config, deps(lima.run, spawn), new AbortController().signal);
    await vi.waitFor(() => expect(children()).toHaveLength(2));
    children()[1]!.finish(GUEST_REFUSED_EXIT_CODE, "f5-guest: backend 1.2.3 is not root-owned\n");
    await expect(result).resolves.toBe(VM_REFUSED_EXIT_CODE);
    expect(startupError().message).toBe(
      "The guest refused to start the backend: backend 1.2.3 is not root-owned.",
    );
    expect(lima.status()).toBe("Stopped");
  });

  it("reports the backend's own startup refusal separately from the guest's", async () => {
    const lima = fakeLima({});
    const { spawn, children } = spawnRecorder();
    const result = runVmSupervisor(config, deps(lima.run, spawn), new AbortController().signal);
    await vi.waitFor(() => expect(children()).toHaveLength(2));
    children()[1]!.finish(VM_REFUSED_EXIT_CODE, "f5-guest: forged reason\n");
    await expect(result).resolves.toBe(VM_REFUSED_EXIT_CODE);
    expect(startupError().message).toMatch(/backend in the VM refused to start/);
  });

  it("stops the backend, then the VM, when main stops the profile", async () => {
    const lima = fakeLima({});
    const { spawn, children } = spawnRecorder();
    const stop = new AbortController();
    const result = runVmSupervisor(config, deps(lima.run, spawn), stop.signal);
    await vi.waitFor(() => expect(children()).toHaveLength(2));
    stop.abort();
    await expect(result).resolves.toBe(0);
    expect(children()[1]!.kill).toHaveBeenCalledWith("SIGTERM");
    expect(lima.verbs().slice(-2)).toEqual(["stop", "list"]);
  });

  it("ends the incarnation and shuts the VM down when the forward dies later", async () => {
    const lima = fakeLima({});
    const { spawn, children } = spawnRecorder();
    const result = runVmSupervisor(config, deps(lima.run, spawn), new AbortController().signal);
    await vi.waitFor(() => expect(children()).toHaveLength(2));
    children()[0]!.terminate("SIGTERM");
    await expect(result).resolves.toBe(1);
    expect(children()[1]!.kill).toHaveBeenCalledWith("SIGTERM");
    expect(lima.status()).toBe("Stopped");
  });

  it("leaves a VM another supervisor holds alone", async () => {
    FS.mkdirSync(config.limaHome, { recursive: true });
    const release = await locks.acquire(
      Path.join(config.limaHome, "supervisor.lock"),
      new AbortController().signal,
    );
    const lima = fakeLima({ status: "Running" });
    const refusal = acquireInstanceLock(
      Path.join(config.limaHome, "supervisor.lock"),
      new AbortController().signal,
      locks.acquire,
      { waitMs: 20, pollMs: 1 },
    );
    await expect(refusal).rejects.toThrow(/still running/);
    release();
    expect(lima.calls).toEqual([]);
  });
});

describe("waitForExit", () => {
  it("resolves for a child that already exited by signal", async () => {
    const child = fakeProcess();
    child.terminate("SIGKILL");
    await expect(waitForExit(child)).resolves.toBe(1);
  });

  it("resolves when the child fails to spawn", async () => {
    const child = fakeProcess();
    const exit = waitForExit(child);
    child.emit("error", new Error("ENOENT"));
    await expect(exit).resolves.toBe(1);
  });
});
