import { EventEmitter } from "node:events";
import type * as ChildProcess from "node:child_process";
import * as FS from "node:fs";
import * as OS from "node:os";
import * as Path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  acquireInstanceLock,
  parseVmSupervisorConfig,
  runVmSupervisor,
  waitForExit,
  VM_REFUSED_EXIT_CODE,
  VmSupervisor,
  VmSupervisorRefusal,
  type RunResult,
  type VmSupervisorConfig,
  type VmSupervisorDeps,
} from "./vmSupervisor";

const imageSha256 = "c".repeat(64);
let root: string;
let config: VmSupervisorConfig;

beforeEach(() => {
  root = FS.mkdtempSync(Path.join(OS.tmpdir(), "f5-vm-supervisor-"));
  config = {
    profileId: "0123456789abcdef0123456789abcdef",
    incarnation: "11111111-2222-4333-8444-555555555555",
    port: 41000,
    limactl: "/lima/bin/limactl",
    limaHome: Path.join(root, "lima"),
    vmDir: Path.join(root, "profile", "vm"),
    imageCacheDir: Path.join(root, "images"),
    imagePin: { url: "https://example.com/i.qcow2", sha256: imageSha256, size: 10 },
    backend: {
      archive: "/res/f5-1.2.3-linux-arm64.tar.gz",
      sha256: "d".repeat(64),
      version: "1.2.3",
    },
    startupErrorPath: Path.join(root, "last-startup-error.json"),
  };
});
afterEach(() => {
  FS.rmSync(root, { recursive: true, force: true });
});

const ok = (stdout = ""): RunResult => ({ code: 0, stdout, stderr: "" });

type GuestStatus = { ready: boolean; reason?: string; backends?: string[] };

/** A fake Lima holding one instance's status; records each command. */
function fakeLima(options: {
  status?: string | null;
  /** Successive `f5-guest status` answers; the last one repeats. */
  guestStatus?: GuestStatus | GuestStatus[];
  installCode?: number;
  /** Runs before each command, e.g. to abort mid-preparation. */
  before?: (args: ReadonlyArray<string>) => void;
}) {
  let status = options.status ?? null;
  const statuses = [options.guestStatus ?? { ready: true, backends: [] }].flat();
  const calls: string[][] = [];
  const run = vi.fn(
    async (
      command: string,
      args: ReadonlyArray<string>,
      _timeoutMs?: number,
      _signal?: AbortSignal,
    ): Promise<RunResult> => {
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
        status = "Stopped";
        return ok();
      }
      if (verb === "delete") {
        status = null;
        return ok();
      }
      if (verb === "copy") return ok();
      if (verb === "shell") {
        const tool = args.slice(args.indexOf("/opt/f5/bin/f5-guest") + 1);
        if (tool[0] === "status") {
          const guest = statuses.length > 1 ? statuses.shift()! : statuses[0]!;
          return { code: guest.ready ? 0 : 78, stdout: JSON.stringify(guest) + "\n", stderr: "" };
        }
        if (tool[0] === "install")
          return { code: options.installCode ?? 0, stdout: "", stderr: "f5-guest: bad archive\n" };
      }
      throw new Error(`unexpected limactl ${args.join(" ")}`);
    },
  );
  return { run, calls, verbs: () => calls.map((args) => args[0]) };
}

/** Lima's image paths are POSIX on every platform the tests run on. */
const imagePath = `/cache/images/${imageSha256}.qcow2`;

function deps(run: VmSupervisorDeps["run"], spawn?: VmSupervisorDeps["spawn"]): VmSupervisorDeps {
  return {
    run,
    spawn: spawn ?? (() => fakeProcess()),
    ensureImage: async () => imagePath,
    log: () => undefined,
    pollMs: 1,
  };
}

type FakeProcess = ChildProcess.ChildProcess & {
  finish(code: number): void;
  terminate(signal: NodeJS.Signals): void;
};

function fakeProcess(): FakeProcess {
  const child = Object.assign(new EventEmitter(), {
    exitCode: null as number | null,
    signalCode: null as NodeJS.Signals | null,
    kill: vi.fn((signal?: NodeJS.Signals) => {
      child.terminate(signal ?? "SIGTERM");
      return true;
    }),
    finish(code: number) {
      if (child.exitCode !== null || child.signalCode !== null) return;
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
    { backend: { archive: "/a", sha256: "d".repeat(64), version: "../1" } },
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
    expect(JSON.parse(FS.readFileSync(Path.join(config.vmDir, "instance.json"), "utf8"))).toEqual({
      imageSha256,
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
      config.backend.sha256,
      `/tmp/f5-backend-${config.incarnation}.tar.gz`,
    ]);
  });

  it("reuses a running VM that already has this image and backend", async () => {
    FS.mkdirSync(config.vmDir, { recursive: true });
    FS.writeFileSync(Path.join(config.vmDir, "instance.json"), JSON.stringify({ imageSha256 }));
    FS.mkdirSync(Path.join(config.limaHome, "_disks", "f5-data"), { recursive: true });
    const lima = fakeLima({ status: "Running", guestStatus: { ready: true, backends: ["1.2.3"] } });
    await new VmSupervisor(config, deps(lima.run)).prepare();
    expect(lima.verbs()).toEqual(["list", "shell"]);
  });

  it("replaces the root disk when the pinned image changes, keeping the data disk", async () => {
    FS.mkdirSync(config.vmDir, { recursive: true });
    FS.writeFileSync(
      Path.join(config.vmDir, "instance.json"),
      JSON.stringify({ imageSha256: "e".repeat(64) }),
    );
    FS.mkdirSync(Path.join(config.limaHome, "_disks", "f5-data"), { recursive: true });
    const lima = fakeLima({ status: "Running", guestStatus: { ready: true, backends: ["1.2.3"] } });
    await new VmSupervisor(config, deps(lima.run)).prepare();
    expect(lima.verbs()).toEqual(["list", "stop", "delete", "create", "start", "shell"]);
    expect(FS.existsSync(Path.join(config.limaHome, "_disks", "f5-data"))).toBe(true);
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
        { ready: true, backends: ["1.2.3"] },
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
});

describe("runVmSupervisor", () => {
  it("forwards the profile port, launches the backend on main's stdio and exits with it", async () => {
    const lima = fakeLima({});
    const spawned: Array<{
      command: string;
      args: string[];
      stdio: unknown;
      child: ReturnType<typeof fakeProcess>;
    }> = [];
    const spawn = vi.fn((command: string, args: ReadonlyArray<string>, stdio: unknown) => {
      const child = fakeProcess();
      spawned.push({ command, args: [...args], stdio, child });
      return child;
    });
    const result = runVmSupervisor(config, deps(lima.run, spawn), new AbortController().signal);
    await vi.waitFor(() => expect(spawned).toHaveLength(2));
    const [forwards, backend] = spawned;
    expect(forwards!.command).toBe("ssh");
    expect(forwards!.args).toEqual(
      expect.arrayContaining([
        "ExitOnForwardFailure=yes",
        "-L",
        "127.0.0.1:41000:127.0.0.1:41000",
        "lima-f5",
      ]),
    );
    expect(forwards!.stdio).toEqual(["ignore", "ignore", "inherit"]);
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
    ]);
    expect(backend!.stdio).toEqual(["inherit", "inherit", "inherit"]);
    backend!.child.finish(3);
    await expect(result).resolves.toBe(3);
    expect(forwards!.child.kill).toHaveBeenCalled();
  });

  it("writes the refusal for main, stops the VM and exits 78 when it can't be prepared", async () => {
    const lima = fakeLima({ guestStatus: { ready: false, reason: "the f5 user has sudo rights" } });
    await expect(
      runVmSupervisor(config, deps(lima.run), new AbortController().signal),
    ).resolves.toBe(VM_REFUSED_EXIT_CODE);
    expect(JSON.parse(FS.readFileSync(config.startupErrorPath, "utf8")).message).toMatch(
      /sudo rights/,
    );
    // Nothing would own a booted VM after a refusal.
    expect(lima.verbs().at(-1)).toBe("stop");
    expect(FS.existsSync(Path.join(config.limaHome, "supervisor.lock"))).toBe(false);
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
    expect(lima.verbs()).toEqual(["list", "disk", "create", "start", "stop"]);
    expect(spawn).not.toHaveBeenCalled();
  });

  it("passes the stop signal to every Lima command and the image download", async () => {
    const stop = new AbortController();
    const lima = fakeLima({});
    const ensureImage = vi.fn(async () => imagePath);
    await new VmSupervisor(config, { ...deps(lima.run), ensureImage }, stop.signal).prepare();
    expect(ensureImage).toHaveBeenCalledWith(config.imagePin, config.imageCacheDir, stop.signal);
    for (const call of lima.run.mock.calls) expect(call[3]).toBe(stop.signal);
  });

  it("stops the VM and refuses when the guest refuses to launch the backend", async () => {
    const lima = fakeLima({});
    const children: FakeProcess[] = [];
    const spawn = vi.fn(() => {
      const child = fakeProcess();
      children.push(child);
      return child;
    });
    const result = runVmSupervisor(config, deps(lima.run, spawn), new AbortController().signal);
    await vi.waitFor(() => expect(children).toHaveLength(2));
    children[1]!.finish(VM_REFUSED_EXIT_CODE);
    await expect(result).resolves.toBe(VM_REFUSED_EXIT_CODE);
    expect(lima.verbs().at(-1)).toBe("stop");
  });

  it("stops the backend, then the VM, when main stops the profile", async () => {
    const lima = fakeLima({});
    const children: Array<ReturnType<typeof fakeProcess>> = [];
    const spawn = vi.fn(() => {
      const child = fakeProcess();
      children.push(child);
      return child;
    });
    const stop = new AbortController();
    const result = runVmSupervisor(config, deps(lima.run, spawn), stop.signal);
    await vi.waitFor(() => expect(children).toHaveLength(2));
    stop.abort();
    await expect(result).resolves.toBe(0);
    expect(children[1]!.kill).toHaveBeenCalledWith("SIGTERM");
    expect(lima.verbs().at(-1)).toBe("stop");
  });

  it("ends the incarnation, leaving the VM up, when the forward dies by signal first", async () => {
    const lima = fakeLima({});
    const children: FakeProcess[] = [];
    const spawn = vi.fn(() => {
      const child = fakeProcess();
      children.push(child);
      return child;
    });
    const result = runVmSupervisor(config, deps(lima.run, spawn), new AbortController().signal);
    await vi.waitFor(() => expect(children).toHaveLength(2));
    // The forward is gone, by signal, before anything waits on it.
    children[0]!.terminate("SIGTERM");
    await expect(result).resolves.toBe(1);
    expect(children[1]!.kill).toHaveBeenCalledWith("SIGTERM");
    expect(lima.verbs()).not.toContain("stop");
  });

  it("waits for another supervisor of the same VM, and refuses if it doesn't finish", async () => {
    FS.mkdirSync(config.limaHome, { recursive: true });
    const lock = Path.join(config.limaHome, "supervisor.lock");
    FS.writeFileSync(lock, "4242");
    const signal = new AbortController().signal;
    await expect(
      acquireInstanceLock(lock, signal, { waitMs: 20, pollMs: 1, isAlive: () => true }),
    ).rejects.toThrow(/still running/);
    expect(FS.readFileSync(lock, "utf8")).toBe("4242");
  });

  it("takes over a lock whose owner is gone, and releases only its own", async () => {
    FS.mkdirSync(config.limaHome, { recursive: true });
    const lock = Path.join(config.limaHome, "supervisor.lock");
    FS.writeFileSync(lock, "4242");
    const release = await acquireInstanceLock(lock, new AbortController().signal, {
      isAlive: () => false,
    });
    expect(FS.readFileSync(lock, "utf8")).toBe(String(process.pid));
    FS.writeFileSync(lock, "999");
    release();
    expect(FS.readFileSync(lock, "utf8")).toBe("999");
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
