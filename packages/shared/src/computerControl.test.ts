import { describe, expect, it } from "vitest";
import { COMPUTER_INTERRUPTED_STOP, ComputerControlError, computerError } from "./computerControl";

describe("ComputerControlError Interrupted messages", () => {
  it.each([
    ["paused", "press Resume in F5"],
    ["user-input", "took the mouse or keyboard"],
    ["kill-switch", "stopped computer control"],
    ["access-changed", "app access changed"],
    ["policy-changed", "settings changed"],
    ["permit-expired", "withdrawn before the action ran"],
  ] as const)("names the %s cause and tells the agent to stop and ask", (cause, reason) => {
    const { message } = new ComputerControlError({ _tag: "Interrupted", cause });
    expect(message.startsWith(`Interrupted (${cause}): `)).toBe(true);
    expect(message).toContain(reason);
    expect(message.endsWith(COMPUTER_INTERRUPTED_STOP)).toBe(true);
    // Never invites the agent to keep acting after an interruption.
    expect(message).not.toMatch(/observe again|retry/i);
  });

  it("explains an ended turn without asking the user", () => {
    const { message } = new ComputerControlError({ _tag: "Interrupted", cause: "turn-ended" });
    expect(message).toBe(
      "Interrupted (turn-ended): this turn ended; no further computer actions run in it.",
    );
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
