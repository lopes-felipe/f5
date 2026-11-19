import { afterEach, expect, it, vi } from "vitest";
import { PASSKEY_ENABLE_CHANNEL, PASSKEY_GET_CHANNEL } from "./GuestProtocol";

const mocks = vi.hoisted(() => ({
  expose: vi.fn(),
  execute: vi.fn(),
  on: vi.fn(),
  invoke: vi.fn().mockResolvedValue(true),
}));
vi.mock("electron", () => ({
  contextBridge: { exposeInMainWorld: mocks.expose, executeInMainWorld: mocks.execute },
  ipcRenderer: { on: mocks.on, invoke: mocks.invoke, send: vi.fn() },
}));
afterEach(() => vi.unstubAllGlobals());

it("enables an already loaded guest only after the main-process signal and installs once", async () => {
  vi.resetModules();
  vi.clearAllMocks();
  vi.stubGlobal("window", { addEventListener: vi.fn() });
  await import("./guestPreload");
  expect(mocks.expose).not.toHaveBeenCalled();
  expect(mocks.execute).not.toHaveBeenCalled();
  const enable = mocks.on.mock.calls.find(([channel]) => channel === PASSKEY_ENABLE_CHANNEL)![1];
  mocks.invoke.mockResolvedValueOnce(false);
  enable();
  await Promise.resolve();
  expect(mocks.expose).not.toHaveBeenCalled();
  enable();
  enable();
  await vi.waitFor(() => expect(mocks.expose).toHaveBeenCalledTimes(1));
  expect(mocks.expose).toHaveBeenCalledTimes(1);
  expect(mocks.execute).toHaveBeenCalledTimes(1);
  const bridge = mocks.expose.mock.calls[0]![1];
  await expect(bridge.invoke("desktop:other", {})).rejects.toThrow("Unsupported");
  await bridge.invoke(PASSKEY_GET_CHANNEL, {});
  expect(mocks.invoke).toHaveBeenLastCalledWith(PASSKEY_GET_CHANNEL, {});
});
