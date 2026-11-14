import { expect, it, vi } from "vitest";
import {
  completeAppActivation,
  takeAppActivations,
  type AppActivationEntry,
} from "./appActivationQueue";
it("delivers only the target profile/window and authenticates acknowledgements", () => {
  const complete = vi.fn();
  const entries = new Map<string, AppActivationEntry>([
    ["one", { request: { id: "one", path: "/repo" }, profileId: "work", senderId: 7, complete }],
    ["two", { request: { id: "two", path: "/other" }, profileId: "personal", complete: vi.fn() }],
  ]);
  expect(takeAppActivations(entries, "work", 8)).toEqual([]);
  expect(takeAppActivations(entries, "personal", 7)).toEqual([entries.get("two")!.request]);
  completeAppActivation(entries, "work", 8, "one");
  completeAppActivation(entries, "personal", 7, "one");
  expect(complete).not.toHaveBeenCalled();
  expect(takeAppActivations(entries, "work", 7)).toEqual([entries.get("one")!.request]);
  completeAppActivation(entries, "work", 7, "one", "Could not create thread");
  expect(complete).toHaveBeenCalledWith("Could not create thread");
});
