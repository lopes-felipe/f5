import type { DragEvent } from "react";
import { expect, it, vi } from "vitest";
import { nativeFileDrag } from "./nativeFileDrag";

it("uses native drag on Mac host windows and cancels a pending lookup on release", async () => {
  const start = vi.fn(async () => true);
  const platform = vi.spyOn(window.navigator, "platform", "get").mockReturnValue("MacIntel");
  vi.stubGlobal("desktopBridge", {});
  try {
    expect(nativeFileDrag("/tmp/file")).toEqual({});
    vi.stubGlobal("desktopBridge", { startFileDrag: start });
    const event = {
      preventDefault: vi.fn(),
      stopPropagation: vi.fn(),
    } as unknown as DragEvent<HTMLElement>;
    nativeFileDrag("/tmp/file").onDragStart!(event);
    await vi.waitFor(() => expect(start).toHaveBeenCalledExactlyOnceWith("/tmp/file"));

    let resolvePath!: (path: string) => void;
    const pending = new Promise<string>((resolve) => {
      resolvePath = resolve;
    });
    nativeFileDrag("/tmp/unresolved", () => pending).onDragStart!(event);
    window.dispatchEvent(new Event("pointerup"));
    resolvePath("/tmp/resolved");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(start).toHaveBeenCalledTimes(1);
  } finally {
    platform.mockRestore();
    vi.unstubAllGlobals();
  }
});
