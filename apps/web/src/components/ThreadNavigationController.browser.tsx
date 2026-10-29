import { ThreadId } from "@t3tools/contracts";
import { afterEach, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { useRightPanelStore } from "../rightPanelStore";
import { recordThreadUndo, releaseThreadUndoShortcut } from "../threadUndo";
import { ThreadNavigationController } from "./ThreadNavigationController";
import { ToastProvider } from "./ui/toast";

const router = vi.hoisted(() => ({
  state: { location: { pathname: "/settings" } },
  navigate: vi.fn(),
  history: { back: vi.fn(), forward: vi.fn() },
}));
vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-router")>()),
  useRouter: () => router,
  // The toast viewport reads the route's thread to decide which notices to show.
  useParams: (options: { select: (params: Record<string, unknown>) => unknown }) =>
    options.select({}),
}));
vi.mock("~/keybindings", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/keybindings")>()),
  useServerKeybindings: () => [
    {
      command: "thread.undo",
      shortcut: {
        key: "z",
        metaKey: true,
        ctrlKey: false,
        shiftKey: false,
        altKey: false,
        modKey: false,
      },
      // The default rule: threadUndoAvailable && !editableFocus && !dialogFocus.
      whenAst: {
        type: "and",
        left: {
          type: "and",
          left: { type: "identifier", name: "threadUndoAvailable" },
          right: { type: "not", node: { type: "identifier", name: "editableFocus" } },
        },
        right: { type: "not", node: { type: "identifier", name: "dialogFocus" } },
      },
    },
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

it("lets a fresh undo notice claim mod+z inside a text field until another key", async () => {
  const undo = vi.fn().mockResolvedValue(undefined);
  // The real viewport renders the undo notice as a non-modal dialog, which must not block mod+z.
  const screen = await render(
    <ToastProvider>
      <ThreadNavigationController />
      <textarea aria-label="Composer" />
    </ToastProvider>,
  );
  const textarea = screen.container.querySelector("textarea")!;
  const editorUndo = vi.fn();
  textarea.addEventListener("keydown", (event) => {
    if (!event.defaultPrevented && event.key === "z") editorUndo();
  });
  const press = (key: string, init: KeyboardEventInit = {}) =>
    textarea.dispatchEvent(
      new KeyboardEvent("keydown", {
        key,
        code: `Key${key.toUpperCase()}`,
        bubbles: true,
        cancelable: true,
        ...init,
      }),
    );
  try {
    textarea.focus();
    recordThreadUndo("Settled", undo);
    await vi.waitFor(() =>
      expect(document.querySelector('[role="dialog"][aria-modal="false"]')).not.toBeNull(),
    );
    press("z", { metaKey: true });
    expect(undo).toHaveBeenCalledOnce();
    expect(editorUndo).not.toHaveBeenCalled();
    // Held: repeats are cancelled instead of reaching the editor's undo.
    press("z", { metaKey: true, repeat: true });
    expect(editorUndo).not.toHaveBeenCalled();

    recordThreadUndo("Snoozed", undo);
    press("a");
    press("z", { metaKey: true });
    expect(undo).toHaveBeenCalledOnce();
    expect(editorUndo).toHaveBeenCalledOnce();
  } finally {
    await screen.unmount();
  }
});

it("leaves mod+z to a focused terminal and to an open modal dialog", async () => {
  const undo = vi.fn().mockResolvedValue(undefined);
  const screen = await render(
    <>
      <ThreadNavigationController />
      <div className="xterm">
        <textarea aria-label="Terminal input" className="xterm-helper-textarea" />
      </div>
    </>,
  );
  const input = screen.container.querySelector("textarea")!;
  const press = (target: Element) =>
    target.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "z",
        code: "KeyZ",
        metaKey: true,
        bubbles: true,
        cancelable: true,
      }),
    );
  const dialog = document.createElement("div");
  dialog.setAttribute("role", "dialog");
  try {
    input.focus();
    recordThreadUndo("Archived", undo);
    // The terminal keeps the key for the shell even while a fresh undo claims it.
    expect(press(input)).toBe(true);
    expect(undo).not.toHaveBeenCalled();

    document.body.append(dialog);
    expect(press(document.body)).toBe(true);
    expect(undo).not.toHaveBeenCalled();
    dialog.remove();
    expect(press(document.body)).toBe(false);
    expect(undo).toHaveBeenCalledOnce();
  } finally {
    dialog.remove();
    releaseThreadUndoShortcut();
    await screen.unmount();
  }
});
