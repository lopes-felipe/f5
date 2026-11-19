import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import type { WebContents } from "electron";
import type { PasskeyBackend } from "./PasskeyBackend";

const configure = vi.hoisted(() => vi.fn());
vi.mock("electron", () => ({
  app: { configureWebAuthn: configure },
  BrowserWindow: {
    fromWebContents: () => ({
      isDestroyed: () => false,
      getNativeWindowHandle: () => Buffer.from([1]),
    }),
  },
  dialog: { showMessageBox: async () => ({ response: 1 }) },
  webContents: { fromFrame: () => undefined },
}));
import { createPreviewPasskeys, resolveWebAuthnEntitlements } from "./Passkeys";
import { PASSKEY_GET_CHANNEL } from "./GuestProtocol";

describe("signed WebAuthn entitlements", () => {
  it("requires separately authorized Touch ID and browser capabilities", () => {
    expect(resolveWebAuthnEntitlements({})).toEqual({ browserPasskeys: false });
    expect(
      resolveWebAuthnEntitlements({
        "com.apple.application-identifier": "TEAM.io.f5",
        "keychain-access-groups": ["TEAM.io.f5.*"],
      }),
    ).toEqual({ browserPasskeys: false, touchIdKeychainAccessGroup: "TEAM.io.f5.webauthn" });
    expect(
      resolveWebAuthnEntitlements({
        "com.apple.application-identifier": "TEAM.io.f5",
        "keychain-access-groups": ["OTHER.*"],
        "com.apple.developer.web-browser.public-key-credential": true,
      }),
    ).toEqual({ browserPasskeys: true });
  });
  it("does not configure or serve passkeys in an unentitled build", () => {
    configure.mockClear();
    const service = createPreviewPasskeys({ browserPasskeys: false });
    service.configure();
    expect(configure).not.toHaveBeenCalled();
    expect(service.bridgeEnabled).toBe(false);
    expect(service.attachGuest({} as WebContents)).toBeTypeOf("function");
  });
});

it("pins origin and document, rejects background/child frames, and serializes ceremonies", async () => {
  const handlers = new Map<string, (...args: any[]) => Promise<any>>();
  const events = new EventEmitter();
  const frame = { origin: "https://example.com", isDestroyed: () => false };
  let focused = true;
  const guest = {
    on: events.on.bind(events),
    removeListener: events.removeListener.bind(events),
    mainFrame: frame,
    hostWebContents: {},
    isFocused: () => focused,
    ipc: {
      removeHandler: (key: string) => handlers.delete(key),
      handle: (key: string, handler: (...args: any[]) => Promise<any>) =>
        handlers.set(key, handler),
    },
  } as unknown as WebContents;
  let finish: (value: any) => void = () => {};
  const get = vi.fn<PasskeyBackend["get"]>(
    () =>
      new Promise<any>((resolve) => {
        finish = resolve;
      }),
  );
  const service = createPreviewPasskeys({ browserPasskeys: true }, { get, create: get });
  const detach = service.attachGuest(guest);
  const handler = handlers.get(PASSKEY_GET_CHANNEL)!;
  expect(await handler({ senderFrame: {} }, {})).toMatchObject({ success: false });
  focused = false;
  expect(await handler({ senderFrame: frame }, {})).toMatchObject({ success: false });
  focused = true;
  const pending = handler({ senderFrame: frame }, {});
  await Promise.resolve();
  expect(await handler({ senderFrame: frame }, {})).toMatchObject({ success: false });
  expect(get.mock.calls[0]?.[1]).toMatchObject({ origin: "https://example.com" });
  // A reload to the same origin still replaces the document that asked.
  events.emit("did-start-navigation", { isMainFrame: true, isSameDocument: false });
  finish({ success: true, data: {} });
  expect(await pending).toMatchObject({ success: false });
  detach();
  expect(handlers.size).toBe(0);
  expect(events.listenerCount("did-start-navigation")).toBe(0);
});

it("installs an account picker only once per entitled session", async () => {
  const session = new EventEmitter();
  const service = createPreviewPasskeys({
    browserPasskeys: false,
    touchIdKeychainAccessGroup: "TEAM.app.webauthn",
  });
  service.installSessionHandlers(session as never);
  service.installSessionHandlers(session as never);
  const callback = vi.fn();
  session.emit(
    "select-webauthn-account",
    {},
    { accounts: [{ credentialId: "one" }], frame: null },
    callback,
  );
  await vi.waitFor(() => expect(callback).toHaveBeenCalledWith("one"));
  expect(session.listenerCount("select-webauthn-account")).toBe(1);
});
