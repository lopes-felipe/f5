import { expect, it } from "vitest";
import { normalizeUserInputOptions } from "./userInputOptions";

it("fills missing and blank descriptions and drops unusable options", () => {
  expect(
    normalizeUserInputOptions([
      { label: " A ", description: " detail " },
      { label: " B ", description: " \t\n" },
      { label: "C" },
      { label: " " },
    ]),
  ).toEqual([
    { label: "A", description: "detail" },
    { label: "B", description: "B" },
    { label: "C", description: "C" },
  ]);
});
