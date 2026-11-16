import { expect, it } from "vitest";

import { tooltipTopCollisionPadding } from "./tooltip";

it("keeps tooltips out of the macOS desktop titlebar only", () => {
  expect(tooltipTopCollisionPadding(true, "MacIntel")).toBe(57);
  expect(tooltipTopCollisionPadding(false, "MacIntel")).toBe(5);
  expect(tooltipTopCollisionPadding(true, "Win32")).toBe(5);
  expect(tooltipTopCollisionPadding(true, "Linux x86_64")).toBe(5);
});
