import { it, expect, vi } from "vitest";
import { registerPreviewWindowOpen } from "./previewWindowOpen";
it("permits only sandboxed HTTP new-window children with the guest session and blocks nested popups", () => {
  let handler: any, created: any;
  const guest = {
    once: vi.fn(),
    removeListener: vi.fn(),
    session: { name: "isolated" },
    setWindowOpenHandler: vi.fn((h) => (handler = h)),
    on: vi.fn((_e, h) => (created = h)),
  };
  const owner = { isDestroyed: () => false, once: vi.fn() },
    external = vi.fn();
  registerPreviewWindowOpen(guest as never, owner as never, external);
  const decision = handler({ url: "https://login.example.test/", disposition: "new-window" });
  expect(decision.action).toBe("allow");
  expect(decision.overrideBrowserWindowOptions).toMatchObject({
    parent: owner,
    width: 520,
    height: 720,
    webPreferences: {
      session: guest.session,
      sandbox: true,
      nodeIntegration: false,
      contextIsolation: true,
    },
  });
  expect(handler({ url: "file:///secret", disposition: "new-window" }).action).toBe("deny");
  expect(handler({ url: "https://example.test/", disposition: "background-tab" }).action).toBe(
    "deny",
  );
  expect(external).toHaveBeenCalled();
  const childHandler = vi.fn();
  created({ once: vi.fn(), webContents: { setWindowOpenHandler: childHandler, on: vi.fn() } });
  expect(childHandler.mock.calls[0]![0]({ url: "https://nested.test/" })).toEqual({
    action: "deny",
  });
});

function popupHarness(options: { agent: boolean; allowed: (url: string) => boolean }) {
  let handler: any, created: any;
  const guest = {
    once: vi.fn(),
    removeListener: vi.fn(),
    session: {},
    setWindowOpenHandler: vi.fn((h) => (handler = h)),
    on: vi.fn((_e, h) => (created = h)),
  };
  const owner = { isDestroyed: () => false, once: vi.fn(), removeListener: vi.fn() };
  const external = vi.fn();
  const blocked = vi.fn();
  const state = { agent: options.agent };
  const controller = registerPreviewWindowOpen(
    guest as never,
    owner as never,
    external,
    undefined,
    {
      isAgentNavigation: () => state.agent,
      isAllowedUrl: options.allowed,
      onBlocked: blocked,
    },
  );
  const makeChild = (url: string) => {
    const listeners = new Map<string, (...args: any[]) => void>();
    const child = {
      once: vi.fn(),
      isDestroyed: vi.fn(() => false),
      destroy: vi.fn(),
      webContents: {
        setWindowOpenHandler: vi.fn(),
        on: vi.fn((event: string, listener: (...args: any[]) => void) =>
          listeners.set(event, listener),
        ),
        getURL: () => url,
        stop: vi.fn(),
      },
    };
    created(child);
    return { child, listeners };
  };
  return { handler: () => handler, makeChild, external, blocked, controller, state };
}

it("keeps agent-driven popups inside the parent tab's allowlist for their whole lifetime", () => {
  let allowedHosts = ["login.example.test"];
  const allowed = (url: string) => allowedHosts.includes(new URL(url).hostname);
  const harness = popupHarness({ agent: true, allowed });

  // A disallowed popup is refused outright and never handed to the system browser.
  expect(harness.handler()({ url: "https://evil.test/", disposition: "new-window" }).action).toBe(
    "deny",
  );
  expect(harness.blocked).toHaveBeenCalledWith("https://evil.test/");
  // Non-popup dispositions during agent actions never open the system browser either.
  expect(
    harness.handler()({ url: "https://login.example.test/", disposition: "foreground-tab" }).action,
  ).toBe("deny");
  expect(harness.external).not.toHaveBeenCalled();

  expect(
    harness.handler()({ url: "https://login.example.test/", disposition: "new-window" }).action,
  ).toBe("allow");
  const { child, listeners } = harness.makeChild("https://login.example.test/");
  const redirect = { url: "https://evil.test/cb", isMainFrame: true, preventDefault: vi.fn() };
  listeners.get("will-redirect")!(redirect);
  expect(redirect.preventDefault).toHaveBeenCalled();
  const navigate = { preventDefault: vi.fn() };
  listeners.get("will-navigate")!(navigate, "https://evil.test/");
  expect(navigate.preventDefault).toHaveBeenCalled();

  // Revoking the host closes the agent popup.
  allowedHosts = [];
  harness.controller.enforcePolicy();
  expect(child.destroy).toHaveBeenCalled();
});

it("leaves user-opened sign-in popups with the user", () => {
  const harness = popupHarness({ agent: false, allowed: () => false });
  expect(
    harness.handler()({ url: "https://accounts.example.test/", disposition: "new-window" }).action,
  ).toBe("allow");
  const { child, listeners } = harness.makeChild("https://accounts.example.test/");
  const navigate = { preventDefault: vi.fn() };
  listeners.get("will-navigate")!(navigate, "https://idp.example.test/");
  expect(navigate.preventDefault).not.toHaveBeenCalled();
  harness.controller.enforcePolicy();
  expect(child.destroy).not.toHaveBeenCalled();
  expect(harness.blocked).not.toHaveBeenCalled();
});
