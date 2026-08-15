import { beforeEach, describe, expect, it } from "vitest";

import { useCommandPaletteStore } from "./commandPaletteStore";

beforeEach(() => {
  useCommandPaletteStore.setState({ open: false, mode: "command", openIntent: null });
});

describe("command palette modes", () => {
  it("opens a requested search mode and toggles the same mode closed", () => {
    useCommandPaletteStore.getState().toggleMode("files");
    expect(useCommandPaletteStore.getState()).toMatchObject({ open: true, mode: "files" });

    useCommandPaletteStore.getState().toggleMode("files");
    expect(useCommandPaletteStore.getState()).toMatchObject({ open: false, mode: "command" });
  });

  it("returns to command mode when the palette closes", () => {
    useCommandPaletteStore.getState().toggleMode("content");
    useCommandPaletteStore.getState().setOpen(false);

    expect(useCommandPaletteStore.getState()).toMatchObject({ open: false, mode: "command" });
  });
});
