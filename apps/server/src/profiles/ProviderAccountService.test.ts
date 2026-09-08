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
      const { handle } = await service.start(ProviderInstanceId.make("codex"));
      onData("private login output");
      expect(emit).toHaveBeenCalledWith(
        expect.objectContaining({ handle, data: "private login output" }),
      );
      expect(await FS.readdir(stateDir)).toEqual([]);
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
      await service.start(ProviderInstanceId.make("codex"), true);
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
