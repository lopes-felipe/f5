import { expect, it } from "vitest";
import { appendStderrTail, stderrExcerpt } from "./stderrDiagnostics.ts";

it.each([
  [
    "source\nError: Missing optional dependency @openai/codex-darwin-arm64.\n at launcher\nNode.js v26",
    "Error: Missing optional dependency @openai/codex-darwin-arm64.",
  ],
  [
    "error: unexpected argument 'app-server'\nUsage: codex",
    "error: unexpected argument 'app-server'",
  ],
  [
    "Error [ERR_MODULE_NOT_FOUND]: Cannot find package\n at launcher",
    "Error [ERR_MODULE_NOT_FOUND]: Cannot find package",
  ],
  ["\u001b[31mError:\t invalid   config\u001b[0m\r\n", "Error: invalid config"],
  ["warning\nMissing API key.", "Missing API key."],
  ["\n \u001b[0m", undefined],
])("extracts actionable stderr from %s", (tail, expected) => {
  expect(stderrExcerpt(tail)).toBe(expected);
});

it("bounds both retained stderr and the displayed excerpt", () => {
  expect(appendStderrTail("x".repeat(9000), "tail")).toBe("x".repeat(8188) + "tail");
  expect(stderrExcerpt("Error: " + "x".repeat(1000))).toBe("Error: " + "x".repeat(504) + "…");
});
