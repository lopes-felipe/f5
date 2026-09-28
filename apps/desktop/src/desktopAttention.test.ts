import { EventEmitter } from "node:events";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
const electron = vi.hoisted(() => ({
  listeners: new Map<string, (...args: any[]) => void>(),
  handlers: new Map<string, (...args: any[]) => any>(),
  quit: vi.fn(),
  badge: vi.fn(),
  show: vi.fn(),
  close: vi.fn(),
}));
vi.mock("electron", () => ({
  app: {
    on: (name: string, handler: (...args: any[]) => void) => electron.listeners.set(name, handler),
    quit: electron.quit,
    setBadgeCount: electron.badge,
  },
  ipcMain: {
    handle: (name: string, handler: (...args: any[]) => any) =>
      electron.handlers.set(name, handler),
  },
  BrowserWindow: { getAllWindows: () => [] },
  Notification: class {
    static isSupported() {
      return true;
    }
    show = electron.show;
    close = electron.close;
  },
}));
import { installDesktopAttention } from "./desktopAttention";

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(10000);
  vi.clearAllMocks();
  electron.listeners.clear();
  electron.handlers.clear();
});
afterEach(() => vi.useRealTimers());
function contents(id: number) {
  return Object.assign(new EventEmitter(), {
    id,
    mainFrame: {},
    send: vi.fn(),
    isDestroyed: () => false,
  });
}
it("intercepts popup shortcuts and uses native hints outside app renderers", async () => {
  installDesktopAttention((id) => (id === 1 ? "a" : undefined));
  const popup = contents(2);
  electron.listeners.get("web-contents-created")!({}, popup);
  const event = { preventDefault: vi.fn() };
  const input = {
    type: "keyDown",
    key: "q",
    meta: true,
    control: true,
    alt: false,
    shift: false,
    isAutoRepeat: false,
  };
  popup.emit("before-input-event", event, input);
  await Promise.resolve();
  expect(event.preventDefault).toHaveBeenCalled();
  expect(electron.show).toHaveBeenCalledOnce();
  expect(electron.quit).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(100);
  popup.emit("before-input-event", event, input);
  expect(electron.quit).toHaveBeenCalledOnce();
});
it("rejects unowned windows and subframes and aggregates profile badges once", () => {
  installDesktopAttention((id) => (id < 3 ? "a" : id === 3 ? "b" : undefined));
  const one = contents(1),
    two = contents(2),
    three = contents(3),
    popup = contents(4);
  for (const view of [one, two, three, popup])
    electron.listeners.get("web-contents-created")!({}, view);
  const badge = electron.handlers.get("desktop:attention-badge")!;
  const event = (sender: ReturnType<typeof contents>) => ({
    sender,
    senderFrame: sender.mainFrame,
  });
  badge(event(one), 3);
  badge(event(two), 3);
  badge(event(three), 2);
  expect(electron.badge).toHaveBeenLastCalledWith(5);
  expect(() => badge(event(popup), 99)).toThrow("Untrusted");
  expect(() => badge({ ...event(one), senderFrame: {} }, 99)).toThrow("Untrusted");
  one.emit("destroyed");
  expect(electron.badge).toHaveBeenLastCalledWith(5);
  two.emit("destroyed");
  expect(electron.badge).toHaveBeenLastCalledWith(2);
});

it("routes preview guest hints to the owning renderer", async () => {
  installDesktopAttention((id) => (id === 1 ? "a" : undefined));
  const host = contents(1);
  const guest = Object.assign(contents(2), { hostWebContents: host });
  electron.listeners.get("web-contents-created")!({}, guest);
  guest.emit(
    "before-input-event",
    { preventDefault: vi.fn() },
    { type: "keyDown", key: "q", meta: true, control: true, isAutoRepeat: false },
  );
  await Promise.resolve();
  expect(host.send).toHaveBeenCalledWith("desktop:quit-hint", { state: "down", mode: "hold" });
  expect(electron.show).not.toHaveBeenCalled();
});
