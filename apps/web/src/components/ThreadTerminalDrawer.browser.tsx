import "../index.css";

import { ThreadId, type TerminalEvent, type TerminalSessionSnapshot } from "@t3tools/contracts";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { page } from "vitest/browser";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import ThreadTerminalDrawer from "./ThreadTerminalDrawer";

const api = vi.hoisted(() => ({
  terminal: {
    snapshot: vi.fn<() => Promise<TerminalSessionSnapshot | null>>(async () => null),
    open: vi.fn(async () => null),
    resize: vi.fn(async () => {}),
    onEvent: vi.fn<(listener: (event: TerminalEvent) => void) => () => void>(() => () => {}),
  },
  contextMenu: { show: vi.fn<() => Promise<string | null>>(async () => null) },
}));
vi.mock("../nativeApi", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../nativeApi")>()),
  readNativeApi: () => api,
}));
vi.mock("../wsConnectionState", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../wsConnectionState")>()),
  getWsConnectionState: () => ({ phase: "connected", synchronized: true }),
  subscribeWsConnectionState: () => () => {},
}));

async function mountDrawer(height: number) {
  const host = document.createElement("div");
  host.style.cssText = "display:flex;flex-direction:column;height:100vh";
  document.body.append(host);
  const onHeightChange = vi.fn<(height: number) => void>();
  const onAddTerminalContext = vi.fn();
  const drawerContent = (terminalIds: string[]) => (
    <ThreadTerminalDrawer
      threadId={ThreadId.make("thread-drawer-test")}
      cwd="/tmp"
      height={height}
      terminalIds={terminalIds}
      activeTerminalId="default"
      terminalGroups={[{ id: "group-default", terminalIds }]}
      activeTerminalGroupId="group-default"
      focusRequestId={0}
      onSplitTerminal={() => {}}
      onNewTerminal={() => {}}
      onActiveTerminalChange={() => {}}
      onCloseTerminal={() => {}}
      onHeightChange={onHeightChange}
      onAddTerminalContext={onAddTerminalContext}
      resolvedTheme="dark"
      themePaletteRevision="test"
    />
  );
  const screen = await render(drawerContent(["default"]), { container: host });
  const drawer = () => host.querySelector<HTMLElement>("aside.thread-terminal-drawer")!;
  const handle = () => drawer().querySelector<HTMLElement>(".cursor-row-resize")!;
  return {
    onHeightChange,
    onAddTerminalContext,
    drawer,
    handle,
    setTerminalIds: (terminalIds: string[]) => screen.rerender(drawerContent(terminalIds)),
    cleanup: async () => {
      await screen.unmount();
      host.remove();
    },
  };
}

it("preserves the original terminal, input, and selection through split and unsplit", async () => {
  const opened = vi.spyOn(Terminal.prototype, "open");
  const disposed = vi.spyOn(Terminal.prototype, "dispose");
  const mounted = await mountDrawer(300);
  try {
    const original = opened.mock.contexts[0] as Terminal;
    const input = original.textarea;
    await new Promise<void>((resolve) => original.write("preserved", resolve));
    original.select(0, 0, 9);
    expect(original.getSelection()).toBe("preserved");

    await mounted.setTerminalIds(["default", "split"]);
    expect(opened).toHaveBeenCalledTimes(2);
    const split = opened.mock.contexts[1] as Terminal;
    expect(mounted.drawer().querySelector("textarea")).toBe(input);
    expect(disposed.mock.contexts).not.toContain(original);
    expect(original.getSelection()).toBe("preserved");

    await mounted.setTerminalIds(["default"]);
    expect(opened).toHaveBeenCalledTimes(2);
    expect(disposed.mock.contexts).toEqual([split]);
    expect(mounted.drawer().querySelector("textarea")).toBe(input);
    expect(original.getSelection()).toBe("preserved");
    original.focus();
    expect(document.activeElement).toBe(input);
  } finally {
    await mounted.cleanup();
    vi.restoreAllMocks();
  }
});

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

describe("ThreadTerminalDrawer selection actions", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    api.terminal.snapshot.mockResolvedValue(null);
    api.contextMenu.show.mockReset().mockResolvedValue(null);
  });

  async function mountSelection() {
    const snapshot: TerminalSessionSnapshot = {
      threadId: "thread-drawer-test",
      terminalId: "default",
      epoch: "selection-test",
      generation: 0,
      revision: 0,
      cwd: "/tmp",
      status: "running",
      pid: 123,
      history: "",
      exitCode: null,
      exitSignal: null,
      updatedAt: "2026-11-06T00:00:00.000Z",
    };
    api.terminal.snapshot.mockResolvedValue(snapshot);
    api.terminal.snapshot.mockClear();
    const opened = vi.spyOn(Terminal.prototype, "open");
    const terminal = () => opened.mock.contexts.at(-1) as Terminal | undefined;
    // Keep every scheduled fit deterministic while exercising the real xterm.
    vi.spyOn(FitAddon.prototype, "fit").mockImplementation(() => terminal()?.resize(80, 10));
    let listener: ((event: TerminalEvent) => void) | undefined;
    api.terminal.onEvent.mockImplementation((callback) => {
      listener = callback;
      return () => {
        listener = undefined;
      };
    });
    const mounted = await mountDrawer(300);
    await vi.waitFor(() => expect(api.terminal.snapshot).toHaveBeenCalled());
    const active = terminal()!;
    const parsed = () => new Promise<void>((resolve) => active.write("", resolve));
    await parsed();
    let revision = 0;
    const output = (data: string) =>
      listener!({
        type: "output",
        ...snapshot,
        revision: ++revision,
        data,
        createdAt: snapshot.updatedAt,
      });
    output("\x1b[?1049h\x1b[H" + Array.from({ length: 10 }, (_, i) => "row " + i).join("\r\n"));
    await parsed();
    active.select(0, 6, 5);
    expect(active.getSelection()).toBe("row 6");
    const screen = active.element!.querySelector<HTMLElement>(".xterm-screen")!;
    return { ...mounted, active, screen, output, parsed };
  }

  it("opens the delayed selection menu despite intervening output and uses shifted lines", async () => {
    let choose: (action: string) => void = () => {};
    api.contextMenu.show.mockImplementation(
      () =>
        new Promise((resolve) => {
          choose = resolve;
        }),
    );
    const mounted = await mountSelection();
    try {
      // A multi-click mouseup schedules the action after 260 ms.
      mounted.screen.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0 }));
      window.dispatchEvent(new MouseEvent("mouseup", { button: 0, detail: 2 }));
      mounted.output("\x1b[1;1Hredraw\x1b[10;6H");
      await mounted.parsed();
      await vi.waitFor(() => expect(api.contextMenu.show).toHaveBeenCalledOnce());
      // Scroll the selected text while the native menu is open.
      mounted.output("\r\nrow 10\r\nrow 11");
      await mounted.parsed();
      expect(mounted.active.getSelectionPosition()?.start.y).toBe(4);
      choose("add-to-chat");
      await vi.waitFor(() =>
        expect(mounted.onAddTerminalContext).toHaveBeenCalledWith(
          expect.objectContaining({ text: "row 6", lineStart: 5, lineEnd: 5 }),
        ),
      );
      expect(mounted.active.hasSelection()).toBe(false);
    } finally {
      await mounted.cleanup();
    }
  });

  it("clears and refocuses after declining stale Add to chat context", async () => {
    let choose: (action: string) => void = () => {};
    api.contextMenu.show.mockImplementation(
      () =>
        new Promise((resolve) => {
          choose = resolve;
        }),
    );
    const mounted = await mountSelection();
    try {
      mounted.screen.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, button: 2 }));
      await vi.waitFor(() => expect(api.contextMenu.show).toHaveBeenCalledOnce());
      mounted.active.select(0, 4, 5);
      mounted.active.blur();
      choose("add-to-chat");
      await vi.waitFor(() => expect(mounted.active.hasSelection()).toBe(false));
      expect(mounted.onAddTerminalContext).not.toHaveBeenCalled();
      expect(document.activeElement).toBe(mounted.active.textarea);
    } finally {
      await mounted.cleanup();
    }
  });
});
