import type { DragEvent } from "react";
import { expect, it, vi } from "vitest";
import { nativeFileDrag } from "./nativeFileDrag";

it("starts the trusted drag before waiting for path resolution", async () => {
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
    expect(start).toHaveBeenLastCalledWith(expect.any(Function));
    resolvePath("/tmp/resolved");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(start).toHaveBeenCalledTimes(2);
  } finally {
    platform.mockRestore();
    vi.unstubAllGlobals();
  }
});
