import { expect, it } from "vitest";

import { previewDebugger } from "./previewDebugger";

it("keeps one Debugger per guest and still reaches it after the guest is destroyed", () => {
  let destroyed = false;
  const guest = {
    // Electron hands out a GC-managed wrapper; nothing else holds it.
    get debugger() {
      if (destroyed) throw new Error("Object has been destroyed");
      return { isAttached: () => true } as unknown as Electron.Debugger;
    },
  } as unknown as Electron.WebContents;

  const pinned = previewDebugger(guest);
  expect(previewDebugger(guest)).toBe(pinned);
  destroyed = true;
  expect(previewDebugger(guest)).toBe(pinned);
});
