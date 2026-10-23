import "../index.css";

import { ThreadId } from "@t3tools/contracts";
import { page } from "vitest/browser";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import ThreadTerminalDrawer from "./ThreadTerminalDrawer";

async function mountDrawer(height: number) {
  const host = document.createElement("div");
  host.style.cssText = "display:flex;flex-direction:column;height:100vh";
  document.body.append(host);
  const onHeightChange = vi.fn<(height: number) => void>();
  const screen = await render(
    <ThreadTerminalDrawer
      threadId={ThreadId.make("thread-drawer-test")}
      cwd="/tmp"
      height={height}
      terminalIds={["default"]}
      activeTerminalId="default"
      terminalGroups={[{ id: "group-default", terminalIds: ["default"] }]}
      activeTerminalGroupId="group-default"
      focusRequestId={0}
      onSplitTerminal={() => {}}
      onNewTerminal={() => {}}
      onActiveTerminalChange={() => {}}
      onCloseTerminal={() => {}}
      onHeightChange={onHeightChange}
      onAddTerminalContext={() => {}}
      resolvedTheme="dark"
      themePaletteRevision="test"
    />,
    { container: host },
  );
  const drawer = () => host.querySelector<HTMLElement>("aside.thread-terminal-drawer")!;
  const handle = () => drawer().querySelector<HTMLElement>(".cursor-row-resize")!;
  return {
    onHeightChange,
    drawer,
    handle,
    cleanup: async () => {
      await screen.unmount();
      host.remove();
    },
  };
}

function pointer(target: HTMLElement, type: string, clientY: number) {
  target.dispatchEvent(
    new PointerEvent(type, {
      bubbles: true,
      cancelable: true,
      pointerId: 1,
      pointerType: "mouse",
      button: 0,
      clientY,
    }),
  );
}

describe("ThreadTerminalDrawer height", () => {
  afterEach(async () => {
    await page.viewport(1200, 900);
    document.body.innerHTML = "";
  });

  it("follows a drag without persisting until release", async () => {
    await page.viewport(1200, 900);
    const mounted = await mountDrawer(300);
    try {
      const handle = mounted.handle();
      handle.setPointerCapture = () => {};
      handle.hasPointerCapture = () => false;
      pointer(handle, "pointerdown", 500);
      pointer(handle, "pointermove", 400);
      expect(mounted.drawer().style.height).toBe("400px");
      expect(mounted.onHeightChange).not.toHaveBeenCalled();

      pointer(handle, "pointerup", 400);
      await vi.waitFor(() => expect(mounted.onHeightChange).toHaveBeenCalledWith(400));
      expect(mounted.onHeightChange).toHaveBeenCalledTimes(1);
      expect(mounted.drawer().style.height).toBe("400px");
    } finally {
      await mounted.cleanup();
    }
  });

  it("restores its height after the window shrinks and grows back", async () => {
    await page.viewport(1200, 900);
    const mounted = await mountDrawer(600);
    try {
      expect(mounted.drawer().style.height).toBe("600px");

      await page.viewport(1200, 400);
      await vi.waitFor(() => expect(mounted.drawer().style.height).toBe("300px"));

      await page.viewport(1200, 900);
      await vi.waitFor(() => expect(mounted.drawer().style.height).toBe("600px"));
      expect(mounted.onHeightChange).not.toHaveBeenCalled();
    } finally {
      await mounted.cleanup();
    }
  });
});
