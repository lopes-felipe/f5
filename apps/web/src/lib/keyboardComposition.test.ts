import { describe, expect, it } from "vitest";

import { isKeyboardEventComposing } from "./keyboardComposition";

describe("isKeyboardEventComposing", () => {
  it("recognizes native, fallback, and legacy IME composition state", () => {
    expect(isKeyboardEventComposing({ isComposing: true, keyCode: 13 })).toBe(true);
    expect(isKeyboardEventComposing({ isComposing: false, keyCode: 13 }, true)).toBe(true);
    expect(isKeyboardEventComposing({ isComposing: false, keyCode: 229 })).toBe(true);
    expect(isKeyboardEventComposing({ isComposing: false, keyCode: 13 })).toBe(false);
  });
});
