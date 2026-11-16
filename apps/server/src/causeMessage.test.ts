import { Cause } from "effect";
import { expect, test } from "vitest";
import { userFacingCauseMessage } from "./causeMessage.ts";
test("uses the exception message without its stack, collapses whitespace, and bounds persisted reasons", () => {
  const cause = Cause.fail(new Error(" first\n  second "));
  expect(userFacingCauseMessage(cause, "fallback")).toBe("first second");
  expect(userFacingCauseMessage(cause, "fallback", { maxLength: 6 })).toBe("first…");
  expect(userFacingCauseMessage(Cause.fail(new Error("   ")), "fallback")).toBe("fallback");
});
