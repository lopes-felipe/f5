import { ThreadId } from "@t3tools/contracts";
import { afterEach, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { useRightPanelStore } from "../rightPanelStore";
import { ThreadNavigationController } from "./ThreadNavigationController";

const router = vi.hoisted(() => ({
  state: { location: { pathname: "/settings" } },
  navigate: vi.fn(),
  history: { back: vi.fn(), forward: vi.fn() },
}));
vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-router")>()),
  useRouter: () => router,
}));
vi.mock("~/keybindings", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/keybindings")>()),
  useServerKeybindings: () => [
    {
      command: "rightPanel.reopenClosed",
      shortcut: {
        key: "t",
        metaKey: true,
        ctrlKey: false,
        shiftKey: true,
        altKey: false,
        modKey: false,
      },
    },
  ],
}));

const pressReopen = () =>
  window.dispatchEvent(
    new KeyboardEvent("keydown", { key: "t", metaKey: true, shiftKey: true, cancelable: true }),
  );

afterEach(() => {
  useRightPanelStore.setState({ byThreadId: {}, closedHistory: [], tabMenuThreadId: null });
  router.navigate.mockReset();
});

it("reopens the last closed tab in its own thread from another page", async () => {
  const owner = ThreadId.makeUnsafe("owner-thread");
  const store = useRightPanelStore.getState();
  store.open(owner, "diff");
  store.closeSurface(owner, "diff");
  const screen = await render(<ThreadNavigationController />);
  try {
    pressReopen();
    expect(useRightPanelStore.getState().byThreadId[owner]?.activeSurfaceId).toBe("diff");
    expect(router.navigate).toHaveBeenCalledOnce();
    const target = router.navigate.mock.calls[0]![0];
    expect(target).toMatchObject({ to: "/$threadId", params: { threadId: owner }, replace: false });
    // Another page's search params do not follow the user into the thread.
    expect(target.search({ tab: "keybindings" })).toEqual({ diff: "1" });

    pressReopen();
    expect(router.navigate).toHaveBeenCalledOnce();
  } finally {
    await screen.unmount();
  }
});
