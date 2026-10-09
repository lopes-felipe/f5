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
    expect(handlers.size).toBe(6);
    expect([...handlers.keys()].some((name) => /execute|request$/.test(name))).toBe(false);
    const event = {} as IpcMainInvokeEvent;
    const answer = { requestId: "r", backendIncarnation: "b", decisions: [] };
    expect(() => handlers.get("desktop-computer:answer")!(event, answer, false)).toThrow("trusted");
    expect(input.answer).not.toHaveBeenCalled();
    handlers.get("desktop-computer:answer")!(event, answer, true);
    expect(input.answer).toHaveBeenCalledWith("profile", answer);
    input.authorize.mockImplementation(() => {
      throw new Error("Wrong profile");
    });
    for (const name of handlers.keys())
      expect(() => handlers.get(name)!(event)).toThrow("Wrong profile");
  });
});
