import * as processRunner from "../processRunner";
import * as FS from "node:fs/promises";
import * as Path from "node:path";
import * as OS from "node:os";
import * as Net from "node:net";
import { Effect, Schema } from "effect";
import { ProviderInstanceId, ServerSettings } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vitest";
import type { ServerConfigShape } from "../config";
import type { ServerSettingsShape } from "../serverSettings";
import type { TerminalManagerShape } from "../terminal/Services/Manager";
import type { PtyProcess } from "../terminal/Services/PTY";
import { ProviderAccountService, assertOAuthPortAvailable } from "./ProviderAccountService";
import { acquireInstanceLock } from "./InstanceLock";

it("reports an external OAuth listener without stopping its owner", async () => {
  const listener = Net.createServer();
  await new Promise<void>((resolve) => listener.listen(0, "127.0.0.1", resolve));
  try {
    const port = (listener.address() as Net.AddressInfo).port;
    await expect(assertOAuthPortAvailable(port)).rejects.toThrow(`port ${port}`);
    expect(listener.listening).toBe(true);
  } finally {
    await new Promise<void>((resolve) => listener.close(() => resolve()));
  }
});

describe("profile account terminals", () => {
  it("streams without history and holds the OAuth lease until cancellation exits", async () => {
    const root = await FS.mkdtemp(Path.join(OS.tmpdir(), "f5-account-"));
    const stateDir = Path.join(root, "state");
    await FS.mkdir(stateDir);
    const profilesRoot = Path.join(root, "profiles");
    let onData!: (data: string) => void;
    let onExit!: (event: { exitCode: number; signal: number | null }) => void;
    const process: PtyProcess = {
      pid: 123,
      write: vi.fn(),
      resize: vi.fn(),
      kill: vi.fn(),
      onData: (callback) => {
        onData = callback;
        return () => {};
      },
      onExit: (callback) => {
        onExit = callback;
        return () => {};
      },
    };
    const spawn = vi.fn(() => Effect.succeed(process));
    const emit = vi.fn();
    const refresh = vi.fn(async () => {});
    const settings = Schema.decodeUnknownSync(ServerSettings)({
      providerInstances: {
        codex: {
          driver: "codex",
          environment: [
            { name: "OPENAI_API_KEY", value: "configured-secret", sensitive: true },
            { name: "KEEP", value: "setting" },
          ],
          config: {
            binaryPath: globalThis.process.execPath,
            homePath: Path.join(stateDir, "codex"),
          },
        },
      },
    });
    const updateSettings = vi.fn((patch: unknown) =>
      Effect.succeed({ ...settings, ...(patch as object) }),
    );
    const service = new ProviderAccountService(
      { stateDir, profilesRoot } as ServerConfigShape,
      { getSettings: Effect.succeed(settings), updateSettings } as unknown as ServerSettingsShape,
      { createAccountProcess: spawn } as unknown as TerminalManagerShape,
      emit,
      refresh,
      async () => false,
    );
    try {
      const occupied = Net.createServer();
      await new Promise<void>((resolve, reject) => {
        occupied.once("error", reject);
        occupied.listen(1455, "127.0.0.1", resolve);
      });
      let handle: string;
      try {
        ({ handle } = await service.start(
          ProviderInstanceId.make("codex"),
          false,
          service,
          "device-code",
        ));
        expect(spawn).toHaveBeenCalledWith(
          expect.objectContaining({ args: ["login", "--device-auth"] }),
        );
      } finally {
        await new Promise<void>((resolve) => occupied.close(() => resolve()));
      }
      onData("private login output");
      expect(emit).toHaveBeenCalledWith(
        expect.objectContaining({ handle, data: "private login output" }),
        service,
      );
      expect(await FS.readdir(stateDir)).toEqual([]);
      expect(() => service.input(handle, "foreign", {})).toThrow(/Unknown/);
      await expect(service.cancel(handle, {})).rejects.toThrow(/another connection/);
      service.input(handle, "verification-code\r");
      expect(process.write).toHaveBeenCalledWith("verification-code\r");
      const cancelled = service.cancel(handle);
      expect(process.kill).toHaveBeenCalled();
      const lockPath = Path.join(profilesRoot, "locks", "provider-oauth.lock.sqlite");
      await expect(acquireInstanceLock(lockPath)).rejects.toMatchObject({
        _tag: "ProfileBusyError",
      });
      onExit({ exitCode: 0, signal: null });
      await cancelled;
      (await acquireInstanceLock(lockPath)).release();
      expect(refresh).toHaveBeenCalled();
      const logout = await service.start(ProviderInstanceId.make("codex"), true);
      service.input(logout.handle, "confirm-sign-out\r");
      expect(process.write).toHaveBeenCalledWith("confirm-sign-out\r");
      onExit({ exitCode: 0, signal: null });
      await vi.waitFor(() => expect(updateSettings).toHaveBeenCalled());
      const patch = updateSettings.mock.calls[0]![0];
      expect(JSON.stringify(patch)).not.toContain("configured-secret");
      expect(JSON.stringify(patch)).toContain("KEEP");
    } finally {
      await service.dispose();
      await FS.rm(root, { recursive: true, force: true });
    }
  });
  it("rejects logout before spawning when the instance has an active turn", async () => {
    const service = new ProviderAccountService(
      {} as ServerConfigShape,
      {} as unknown as ServerSettingsShape,
      {} as TerminalManagerShape,
      () => {},
      async () => {},
      async () => true,
    );
    await expect(service.start(ProviderInstanceId.make("codex"), true)).rejects.toThrow(
      /active turn/,
    );
  });
});

it("rechecks the snapshot and honors Claude loggedIn=false even with exit code zero", async () => {
  const refresh = vi.fn(async () => {});
  const service = new ProviderAccountService(
    {} as ServerConfigShape,
    {
      getSettings: Effect.succeed(Schema.decodeUnknownSync(ServerSettings)({})),
    } as unknown as ServerSettingsShape,
    {} as TerminalManagerShape,
    () => {},
    refresh,
    async () => false,
  );
  const id = ProviderInstanceId.make("claudeAgent");
  const resolved = vi.spyOn(service, "resolve").mockResolvedValue({
    instance: { driver: "claudeAgent" },
    environment: {},
    invocation: () => ({ file: "claude", args: ["auth", "status"] }),
  } as unknown as Awaited<ReturnType<typeof service.resolve>>);
  const process = vi.spyOn(processRunner, "runProcess").mockResolvedValue({
    stdout: '{"loggedIn":false,"authMethod":"none"}',
    stderr: "",
    code: 0,
  } as Awaited<ReturnType<typeof processRunner.runProcess>>);
  try {
    expect(await service.status(id)).toMatchObject({ status: "unauthenticated" });
    expect(refresh).toHaveBeenCalledWith(id);
  } finally {
    process.mockRestore();
    resolved.mockRestore();
  }
});

describe("Antigravity account ownership", () => {
  it("keeps one profile's account invisible to another with the same instance ID", async () => {
    const { antigravityProfileDirectory } =
      await import("../provider/acp/AntigravityAcpSupport.ts");
    const root = await FS.mkdtemp(Path.join(OS.tmpdir(), "f5-agy-profiles-"));
    const settings = Schema.decodeUnknownSync(ServerSettings)({
      providerInstances: { antigravity: { driver: "antigravity", config: { enabled: true } } },
    });
    const instanceId = ProviderInstanceId.make("antigravity");
    const make = (stateDir: string) =>
      new ProviderAccountService(
        { stateDir } as ServerConfigShape,
        { getSettings: Effect.succeed(settings) } as unknown as ServerSettingsShape,
        {} as TerminalManagerShape,
        () => {},
        async () => {},
        async () => false,
      );
    try {
      const a = Path.join(root, "a");
      const b = Path.join(root, "b");
      const token = Path.join(antigravityProfileDirectory(a, instanceId), "antigravity-acp");
      await FS.mkdir(token, { recursive: true });
      await FS.writeFile(Path.join(token, "acp_token.json"), '{"token":"synthetic"}');
      expect((await make(a).status(instanceId)).status).toBe("authenticated");
      expect((await make(b).status(instanceId)).status).toBe("unauthenticated");
    } finally {
      await FS.rm(root, { recursive: true, force: true });
    }
  });

  it("holds the OAuth lease during install and only lets its owner cancel", async () => {
    const { AntigravityInstallation } = await import("../provider/AntigravityInstallation.ts");
    const install = vi
      .spyOn(AntigravityInstallation.prototype, "install")
      .mockImplementation(
        (signal) =>
          new Promise((_resolve, reject) =>
            signal!.addEventListener("abort", () => reject(signal!.reason), { once: true }),
          ),
      );
    const root = await FS.mkdtemp(Path.join(OS.tmpdir(), "f5-agy-owner-"));
    const settings = Schema.decodeUnknownSync(ServerSettings)({
      providerInstances: { antigravity: { driver: "antigravity" } },
    });
    const emit = vi.fn();
    const service = new ProviderAccountService(
      { stateDir: root, profilesRoot: root } as ServerConfigShape,
      { getSettings: Effect.succeed(settings) } as unknown as ServerSettingsShape,
      {} as TerminalManagerShape,
      emit,
      async () => {},
      async () => false,
    );
    const owner = {};
    const stranger = {};
    const instanceId = ProviderInstanceId.make("antigravity");
    try {
      const { handle } = await service.start(instanceId, false, owner, "install");
      await expect(service.cancel(handle, stranger)).rejects.toThrow("another connection");
      await expect(
        acquireInstanceLock(Path.join(root, "locks", "provider-oauth.lock.sqlite")),
      ).rejects.toThrow();
      await service.disconnect(owner);
      expect(emit.mock.calls.every(([, recipient]) => recipient === owner)).toBe(true);
      const lease = await acquireInstanceLock(
        Path.join(root, "locks", "provider-oauth.lock.sqlite"),
      );
      lease.release();
    } finally {
      await service.dispose();
      install.mockRestore();
      await FS.rm(root, { recursive: true, force: true });
    }
  });
});
