import { afterEach, expect, it, vi } from "vitest";
import type { DesktopBridge } from "@t3tools/contracts";
const mocks = vi.hoisted(() => ({
  expose: vi.fn(),
  invoke: vi.fn(async () => ({})),
}));
vi.mock("electron", () => ({
  contextBridge: { exposeInMainWorld: mocks.expose },
  ipcRenderer: { sendSync: () => null, invoke: mocks.invoke },
  webUtils: {},
}));
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
it("gates escalating preload calls with a consumed, expiring, trusted grant including drag selection", async () => {
  vi.resetModules();
  mocks.expose.mockClear();
  mocks.invoke.mockClear();
  const listeners = new Map<string, EventListener[]>();
  vi.stubGlobal("window", {
    addEventListener: (name: string, listener: EventListener) =>
      listeners.set(name, [...(listeners.get(name) ?? []), listener]),
  });
  let now = 0;
  vi.spyOn(performance, "now").mockImplementation(() => now);
  await import("../preload");
  const bridge = (mocks.expose.mock.calls[0]![1] as DesktopBridge).keepAwake!;
  const emit = (name: string, props: Partial<MouseEvent> = {}) => {
    for (const listener of listeners.get(name) ?? [])
      listener({ isTrusted: true, button: 0, detail: 1, ...props } as MouseEvent);
  };
  const trusted = () => mocks.invoke.mock.calls.at(-1)?.at(-1);
  emit("click", { isTrusted: false, detail: 0 });
  await bridge.setPreferences({ mode: "always" });
  expect(trusted()).toBe(false);
  emit("mouseup"); // Base UI commits its synthetic click during mouseup.
  await bridge.setPreferences({ mode: "agents" });
  expect(trusted()).toBe(true);
  emit("click"); // The follow-up physical click must not replenish the grant.
  await bridge.installLidPermission();
  expect(trusted()).toBe(false);
  emit("keydown");
  now = 1000;
  await bridge.setPreferences({ closedLid: true });
  expect(trusted()).toBe(false);
  emit("keydown");
  await bridge.setPreferences({ mode: "off", closedLid: false });
  expect(trusted()).toBe(false);
  await bridge.removeLidPermission();
  expect(trusted()).toBe(true);
  await bridge.removeLidPermission();
  expect(trusted()).toBe(false);
  emit("click", { detail: 0 });
  await bridge.installLidPermission();
  expect(trusted()).toBe(true);
});
