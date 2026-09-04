import { describe, expect, it } from "vitest";

import { formatCodexUnsupportedModelError, isUnsupportedCodexModelError } from "./codexErrors.ts";

describe("Codex unsupported model errors", () => {
  it.each([
    "The 'gpt-6-astra' model is not supported for this account.",
    "unknown model: gpt-6-astra",
    "requested model not found",
  ])("matches %s", (message) => {
    expect(isUnsupportedCodexModelError(message)).toBe(true);
  });

  it("appends a generic recovery hint without replacing the provider diagnostic", () => {
    const message = "unknown model: gpt-6-astra";
    const formatted = formatCodexUnsupportedModelError(message);

    expect(formatted).toContain(message);
    expect(formatted).toContain("Choose another model");
  });

  it("leaves unrelated errors unchanged", () => {
    expect(formatCodexUnsupportedModelError("permission denied")).toBe("permission denied");
    expect(formatCodexUnsupportedModelError("The model cache directory does not exist")).toBe(
      "The model cache directory does not exist",
    );
  });
});
