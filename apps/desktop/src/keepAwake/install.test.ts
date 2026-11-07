import { beforeEach, expect, it, vi } from "vitest";
import { KeepAwakeController } from "./controller";
import { installKeepAwake, validatePreferences } from "./install";

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
}));
vi.mock("electron", () => ({
  app: { getPath: () => "/tmp/f5-keep-awake-nonexistent" },
  ipcMain: {
    removeHandler: (channel: string) => mocks.handlers.delete(channel),
    handle: (channel: string, handler: (...args: unknown[]) => unknown) =>
      mocks.handlers.set(channel, handler),
  },
  powerMonitor: { on: vi.fn(), removeListener: vi.fn() },
  powerSaveBlocker: {},
  screen: {},
}));
beforeEach(() => {
  vi.restoreAllMocks();
  mocks.handlers.clear();
  vi.spyOn(KeepAwakeController.prototype, "start").mockResolvedValue();
});
it("validates all fields strictly", () => {
  for (const input of [
    null,
    [],
    {},
    { mode: "invalid" },
    { closedLid: 1 },
    { keepDisplayOn: "yes" },
    { keepDisplayOn: true, unexpected: true },
    { unexpected: true },
    { mode: undefined },
  ])
    expect(() => validatePreferences(input)).toThrow();
  expect(validatePreferences({ mode: "off", closedLid: false })).toEqual({
    mode: "off",
    closedLid: false,
  });
  expect(validatePreferences({ keepDisplayOn: true })).toEqual({ keepDisplayOn: true });
});
it("authorizes every IPC request and gates only escalating mutations", async () => {
  const set = vi
    .spyOn(KeepAwakeController.prototype, "setPreferences")
    .mockResolvedValue({} as never);
  const permission = vi
    .spyOn(KeepAwakeController.prototype, "changePermission")
    .mockResolvedValue({} as never);
  const authorize = vi.fn((event: unknown) => {
    if (event !== "trusted-frame") throw new Error("Unregistered frame");
  });
  await installKeepAwake({ authorize, backends: () => [], broadcast: vi.fn() });
  for (const action of ["get", "set", "install", "remove"]) {
    expect(() => mocks.handlers.get("desktop:keep-awake-" + action)!("subframe")).toThrow(
      "Unregistered frame",
    );
  }
  const handler = mocks.handlers.get("desktop:keep-awake-set")!;
  for (const input of [
    { mode: "always" },
    { mode: "agents" },
    { closedLid: true },
    { keepDisplayOn: true },
  ])
    expect(() => handler("trusted-frame", input, false)).toThrow("gesture");
  await handler("trusted-frame", { mode: "off", closedLid: false }, false);
  expect(set).toHaveBeenCalledWith({ mode: "off", closedLid: false });
  await handler("trusted-frame", { keepDisplayOn: false }, false);
  expect(set).toHaveBeenCalledWith({ keepDisplayOn: false });
  await handler("trusted-frame", { mode: "always" }, true);
  for (const action of ["install", "remove"]) {
    const request = mocks.handlers.get("desktop:keep-awake-" + action)!;
    expect(() => request("trusted-frame", false)).toThrow("gesture");
    await request("trusted-frame", true);
  }
  expect(permission).toHaveBeenCalledTimes(2);
});
it("replaces stale IPC handlers after an update recovery", async () => {
  vi.spyOn(KeepAwakeController.prototype, "dispose").mockResolvedValue();
  const first = await installKeepAwake({
    authorize: vi.fn(),
    backends: () => [],
    broadcast: vi.fn(),
  });
  const original = mocks.handlers.get("desktop:keep-awake-set");
  await first.dispose();
  await installKeepAwake({ authorize: vi.fn(), backends: () => [], broadcast: vi.fn() });
  expect(mocks.handlers.size).toBe(4);
  expect(mocks.handlers.get("desktop:keep-awake-set")).not.toBe(original);
});
