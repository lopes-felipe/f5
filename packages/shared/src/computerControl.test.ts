import { describe, expect, it } from "vitest";
import { ComputerControlError, computerError } from "./computerControl";

describe("ComputerControlError Interrupted messages", () => {
  it.each([
    ["paused", "press Resume in F5"],
    ["user-input", "used the mouse or keyboard"],
    ["kill-switch", "stopped computer control"],
    ["access-changed", "app access changed"],
    ["policy-changed", "settings changed"],
    ["turn-ended", "turn ended"],
    ["permit-expired", "permit expired"],
  ] as const)("names the %s cause", (cause, guidance) => {
    const error = new ComputerControlError({ _tag: "Interrupted", cause });
    expect(error.message.startsWith(`Interrupted (${cause}): `)).toBe(true);
    expect(error.message).toContain(guidance);
  });

  it("keeps the structured error unchanged", () => {
    const error = new ComputerControlError({
      _tag: "Interrupted",
      cause: "paused",
      actionStarted: false,
    });
    expect(computerError(error)).toEqual({
      _tag: "Interrupted",
      cause: "paused",
      actionStarted: false,
    });
  });
});
