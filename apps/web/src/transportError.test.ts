import { describe, expect, it } from "vitest";

import { isTransportConnectionErrorMessage, sanitizeThreadErrorMessage } from "./transportError";

describe("transportError", () => {
  it("detects websocket close errors", () => {
    expect(isTransportConnectionErrorMessage("WebSocket connection closed.")).toBe(true);
  });

  it("detects websocket send failures", () => {
    expect(isTransportConnectionErrorMessage("Failed to send WebSocket request.")).toBe(true);
  });

  it("leaves non-transport errors untouched", () => {
    expect(isTransportConnectionErrorMessage("Failed to compact thread.")).toBe(false);
    expect(sanitizeThreadErrorMessage("Failed to compact thread.")).toBe(
      "Failed to compact thread.",
    );
  });

  it("sanitizes transport-only thread errors to null", () => {
    expect(sanitizeThreadErrorMessage("WebSocket connection closed.")).toBeNull();
  });
});
