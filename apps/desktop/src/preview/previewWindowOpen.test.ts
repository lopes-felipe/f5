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
