import { describe, expect, it } from "vitest";

import {
  COMPOSER_EXPAND_MAX_HEIGHT_PX,
  computeComposerExpandBudget,
} from "./useComposerExpandBudget";

describe("computeComposerExpandBudget", () => {
  it("fits the whole dock stack, tray included, in half the host", () => {
    // 900px host, 160px tray + 100px composer chrome around a 40px editor:
    // 450 - 260 leaves 190px, too little to expand into.
    expect(
      computeComposerExpandBudget({ hostHeight: 900, stackHeight: 300, editorHeight: 40 }),
    ).toBeNull();
    expect(
      computeComposerExpandBudget({ hostHeight: 1200, stackHeight: 300, editorHeight: 40 }),
    ).toBe(336);
    // Without the tray the editor gets the room the tray took.
    expect(
      computeComposerExpandBudget({ hostHeight: 1200, stackHeight: 140, editorHeight: 40 }),
    ).toBe(496);
  });

  it("respects the dock's own max height (the redesign's cap)", () => {
    expect(
      computeComposerExpandBudget({
        hostHeight: 1400,
        stackHeight: 140,
        editorHeight: 40,
        dockMaxHeight: 420,
      }),
    ).toBe(320);
  });

  it("caps the editor and rounds down to the 8px grid", () => {
    expect(
      computeComposerExpandBudget({ hostHeight: 4000, stackHeight: 140, editorHeight: 40 }),
    ).toBe(COMPOSER_EXPAND_MAX_HEIGHT_PX);
    expect(
      computeComposerExpandBudget({ hostHeight: 1000, stackHeight: 143, editorHeight: 40 }),
    ).toBe(392);
  });

  it("hides the toggle when the stack leaves too little room", () => {
    expect(
      computeComposerExpandBudget({ hostHeight: 500, stackHeight: 140, editorHeight: 40 }),
    ).toBeNull();
  });
});
