import "../../index.css";
import { afterEach, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { DesktopPromptLinkController } from "./DesktopPromptLinkController";

const navigate = vi.hoisted(() => vi.fn(async () => {}));
const toast = vi.hoisted(() => ({ add: vi.fn() }));
const startup = vi.hoisted(() => ({ ready: true }));
vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-router")>()),
  useNavigate: () => navigate,
}));
vi.mock("~/lib/startupReady", () => ({ useStartupReady: () => startup.ready }));
vi.mock("../ui/toast", () => ({ toastManager: toast }));

const bridge = {
  takePromptLinks: vi.fn(),
  onPromptLinksAvailable: vi.fn((_listener: () => void) => () => {}),
};
afterEach(() => {
  vi.clearAllMocks();
  startup.ready = true;
  Reflect.deleteProperty(window, "desktopBridge");
});
function installBridge() {
  Object.defineProperty(window, "desktopBridge", { value: bridge, configurable: true });
}

it("opens the newest queued link once startup is ready and names the profile", async () => {
  installBridge();
  bridge.takePromptLinks.mockResolvedValue({ links: [], profileName: null });
  bridge.takePromptLinks.mockResolvedValueOnce({
    links: ["f5://new?prompt=first", "f5://new?prompt=second", "f5://settings"],
    profileName: "Work",
  });
  startup.ready = false;
  const screen = await render(<DesktopPromptLinkController />);
  expect(bridge.takePromptLinks).not.toHaveBeenCalled();

  startup.ready = true;
  await screen.rerender(<DesktopPromptLinkController />);
  await vi.waitFor(() =>
    expect(navigate).toHaveBeenCalledWith({
      href: "/new?prompt=second",
      state: { promptLinkDelivery: expect.any(String) },
    }),
  );
  expect(navigate).toHaveBeenCalledTimes(1);
  expect(toast.add).toHaveBeenCalledWith(
    expect.objectContaining({ title: "Opened the link in your Work profile" }),
  );
});

it("takes links again when its window gains focus", async () => {
  installBridge();
  bridge.takePromptLinks.mockResolvedValueOnce({ links: [], profileName: null });
  bridge.takePromptLinks.mockResolvedValueOnce({
    links: ["f5://thread/thread-1?prompt=Retry"],
    profileName: null,
  });
  await render(<DesktopPromptLinkController />);
  await vi.waitFor(() => expect(bridge.takePromptLinks).toHaveBeenCalledTimes(1));

  window.dispatchEvent(new Event("focus"));
  await vi.waitFor(() =>
    expect(navigate).toHaveBeenCalledWith(
      expect.objectContaining({ href: "/thread-1?prompt=Retry" }),
    ),
  );
  expect(toast.add).not.toHaveBeenCalled();
});
