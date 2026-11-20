import { expect, it } from "vitest";
import { updatePiExtensionStatuses as update } from "./extensionStatuses.ts";
it("replaces and clears keyed status without losing other extensions, stripping terminal controls", () => {
  const first = update([], { statusKey: "one", statusText: "\u001b[31mReady\u001b[0m" });
  expect(first).toEqual([{ key: "one", text: "Ready" }]);
  const both = update(first, { statusKey: "two", statusText: "Waiting" });
  expect(update(both, { statusKey: "one", statusText: "Done" })).toEqual([
    { key: "one", text: "Done" },
    { key: "two", text: "Waiting" },
  ]);
  expect(update(both, { statusKey: "one" })).toEqual([{ key: "two", text: "Waiting" }]);
  expect(update(both, { statusKey: "one", statusText: "Ready" })).toBe(both);
  expect(update(both, { statusKey: "bad", statusText: {} })).toBe(both);
  expect(update([], { statusKey: " ", statusText: "Ignored" })).toEqual([]);
});
