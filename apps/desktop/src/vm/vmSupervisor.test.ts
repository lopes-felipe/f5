import { EventEmitter } from "node:events";
import type * as ChildProcess from "node:child_process";
import * as FS from "node:fs";
import * as OS from "node:os";
import * as Path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  parseVmSupervisorConfig,
  runVmSupervisor,
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

/** A fake Lima: `instances` maps name to status; records each command. */
function fakeLima(options: {
  status?: string | null;
  guestStatus?: { ready: boolean; reason?: string; backends?: string[] };
  installCode?: number;
}) {
  let status = options.status ?? null;
  const calls: string[][] = [];
  const run = vi.fn(async (command: string, args: ReadonlyArray<string>): Promise<RunResult> => {
    expect(command).toBe(config.limactl);
    calls.push([...args]);
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
        const guest = options.guestStatus ?? { ready: true, backends: [] };
        return { code: guest.ready ? 0 : 78, stdout: JSON.stringify(guest) + "\n", stderr: "" };
      }
      if (tool[0] === "install")
        return { code: options.installCode ?? 0, stdout: "", stderr: "f5-guest: bad archive\n" };
    }
    throw new Error(`unexpected limactl ${args.join(" ")}`);
  });
  return { run, calls, verbs: () => calls.map((args) => args[0]) };
}

function deps(run: VmSupervisorDeps["run"], spawn?: VmSupervisorDeps["spawn"]): VmSupervisorDeps {
  return {
    run,
    spawn: spawn ?? (() => fakeProcess()),
    ensureImage: async (pin, cacheDir) => Path.join(cacheDir, `${pin.sha256}.qcow2`),
    log: () => undefined,
  };
}

function fakeProcess(): ChildProcess.ChildProcess & { finish(code: number): void } {
  const child = Object.assign(new EventEmitter(), {
    exitCode: null as number | null,
    kill: vi.fn(function (this: { finish(code: number): void }) {
      this.finish(143);
      return true;
    }),
    finish(code: number) {
      if (child.exitCode !== null) return;
      child.exitCode = code;
      child.emit("exit", code, null);
    },
  });
  return child as unknown as ChildProcess.ChildProcess & { finish(code: number): void };
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
    expect(yaml.images[0]).toMatchObject({
      location: Path.join(config.imageCacheDir, `${imageSha256}.qcow2`),
      digest: `sha256:${imageSha256}`,
    });
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

  it("refuses a guest whose policy check fails", async () => {
    const lima = fakeLima({
      guestStatus: { ready: false, reason: "the egress policy is not loaded" },
    });
    await expect(new VmSupervisor(config, deps(lima.run)).prepare()).rejects.toThrow(
      /egress policy is not loaded/,
    );
    expect(lima.verbs()).not.toContain("copy");
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

  it("writes the refusal for main and exits 78 when the VM can't be prepared", async () => {
    const lima = fakeLima({
      guestStatus: { ready: false, reason: "the data disk is not attached" },
    });
    await expect(
      runVmSupervisor(config, deps(lima.run), new AbortController().signal),
    ).resolves.toBe(VM_REFUSED_EXIT_CODE);
    expect(JSON.parse(FS.readFileSync(config.startupErrorPath, "utf8")).message).toMatch(
      /data disk is not attached/,
    );
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

  it("restarts the incarnation when the port forward is lost", async () => {
    const lima = fakeLima({});
    const children: Array<ReturnType<typeof fakeProcess>> = [];
    const spawn = vi.fn(() => {
      const child = fakeProcess();
      children.push(child);
      return child;
    });
    const result = runVmSupervisor(config, deps(lima.run, spawn), new AbortController().signal);
    await vi.waitFor(() => expect(children).toHaveLength(2));
    children[0]!.finish(255);
    await expect(result).resolves.toBe(143);
    expect(lima.verbs()).not.toContain("stop");
  });
});
