import { expect, it, vi } from "vitest";
import { revealSenderWindow } from "./revealWindow";

it("restores the authenticated sender's window before showing and focusing", () => {
  const calls: string[] = [];
  revealSenderWindow(
    () => {
      calls.push("authorize");
    },
    () => ({
      isDestroyed: () => false,
      isMinimized: () => true,
      restore: () => {
        calls.push("restore");
      },
      show: () => {
        calls.push("show");
      },
      focus: () => {
        calls.push("focus");
      },
    }),
  );
  expect(calls).toEqual(["authorize", "restore", "show", "focus"]);
});

it("rejects unauthorized callers before looking up a window", () => {
  const lookup = vi.fn();
  expect(() =>
    revealSenderWindow(() => {
      throw new Error("untrusted");
    }, lookup),
  ).toThrow("untrusted");
  expect(lookup).not.toHaveBeenCalled();
});
