import type { IpcMain, IpcMainInvokeEvent } from "electron";
import { describe, expect, it, vi } from "vitest";
import { registerComputerIpc } from "./registerComputerIpc";
vi.mock("./permissions", () => ({
  requestComputerPermission: vi.fn(),
  openComputerPermissionSettings: vi.fn(),
}));
describe("renderer computer controls", () => {
  it("requires sender authorization for every method and trusted gestures for widening", () => {
    const handlers = new Map<string, (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown>();
    const input = {
      authorize: vi.fn(() => "profile"),
      status: vi.fn(() => ({ available: true as const })),
      retry: vi.fn(),
      answer: vi.fn(),
      pause: vi.fn(),
    };
    const ipc = {
      handle: (name: string, fn: (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown) =>
        handlers.set(name, fn),
      removeHandler: (name: string) => handlers.delete(name),
    };
    registerComputerIpc(ipc as unknown as IpcMain, input);
    expect(handlers.size).toBe(10);
    expect([...handlers.keys()].some((name) => /execute|request$/.test(name))).toBe(false);
    const event = {} as IpcMainInvokeEvent;
    const answer = { requestId: "r", backendIncarnation: "b", decisions: [] };
    expect(() => handlers.get("desktop-computer:answer")!(event, answer, false)).toThrow("trusted");
    expect(input.answer).not.toHaveBeenCalled();
    handlers.get("desktop-computer:answer")!(event, answer, true);
    expect(input.answer).toHaveBeenCalledWith("profile", answer);
    const pause = handlers.get("desktop-computer:pause")!;
    expect(() => pause(event, "t", false, false)).toThrow("trusted");
    expect(input.pause).not.toHaveBeenCalled();
    pause(event, "t", true, false);
    pause(event, "t", false, true);
    expect(input.pause).toHaveBeenLastCalledWith("profile", "t", false);
    input.pause.mockImplementation(() => {
      throw new Error("monitor unhealthy");
    });
    expect(() => pause(event, "t", false, true)).toThrow("monitor unhealthy");
    input.authorize.mockImplementation(() => {
      throw new Error("Wrong profile");
    });
    for (const name of handlers.keys())
      expect(() => handlers.get(name)!(event)).toThrow("Wrong profile");
  });
  it("lists and revokes the profile's always-allow, and can't grant one", () => {
    const handlers = new Map<string, (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown>();
    const integrationConsents = {
      list: vi.fn((): Array<"codex-chrome"> => ["codex-chrome"]),
      revoke: vi.fn(),
    };
    registerComputerIpc(
      {
        handle: (name: string, fn: (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown) =>
          handlers.set(name, fn),
        removeHandler: (name: string) => handlers.delete(name),
      } as unknown as IpcMain,
      {
        authorize: () => "profile",
        status: () => ({ available: true as const }),
        retry: vi.fn(),
        answer: vi.fn(),
        pause: vi.fn(),
        integrationConsents,
      },
    );
    const event = {} as IpcMainInvokeEvent;
    expect(handlers.get("desktop-computer:integration-consents")!(event)).toEqual(["codex-chrome"]);
    expect(integrationConsents.list).toHaveBeenCalledWith("profile");
    handlers.get("desktop-computer:revoke-integration-consent")!(event, "codex-chrome");
    expect(integrationConsents.revoke).toHaveBeenCalledWith("profile", "codex-chrome");
    handlers.get("desktop-computer:revoke-integration-consent")!(event, "claude-chrome");
    expect(integrationConsents.revoke).toHaveBeenCalledWith("profile", "claude-chrome");
    for (const other of ["codex-computer", "claude"])
      expect(() =>
        handlers.get("desktop-computer:revoke-integration-consent")!(event, other),
      ).toThrow("Invalid integration");
    expect([...handlers.keys()].some((name) => /allow|grant/.test(name))).toBe(false);
  });
  it("decodes exact computer policy for revocation and derives profile identity from the sender", () => {
    const handlers = new Map<string, (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown>();
    const computerConsents = { list: vi.fn(() => []), revoke: vi.fn() };
    registerComputerIpc(
      {
        handle: (name: string, fn: (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown) =>
          handlers.set(name, fn),
        removeHandler: (name: string) => handlers.delete(name),
      } as unknown as IpcMain,
      {
        authorize: () => "authenticated-profile",
        status: () => ({ available: true }),
        retry: vi.fn(),
        answer: vi.fn(),
        pause: vi.fn(),
        computerConsents,
      },
    );
    const event = {} as IpcMainInvokeEvent;
    handlers.get("desktop-computer:remembered-consents")!(event);
    expect(computerConsents.list).toHaveBeenCalledWith("authenticated-profile");
    const policy = { version: 1, kind: "full-access-session", policyVersion: 1 };
    handlers.get("desktop-computer:revoke-remembered-consent")!(event, policy);
    expect(computerConsents.revoke).toHaveBeenCalledWith("authenticated-profile", policy);
    for (const invalid of [
      { ...policy, profileId: "other" },
      { ...policy, appId: "extra" },
      { ...policy, policyVersion: 2 },
    ])
      expect(() =>
        handlers.get("desktop-computer:revoke-remembered-consent")!(event, invalid),
      ).toThrow();
    expect(computerConsents.revoke).toHaveBeenCalledTimes(1);
  });
});
