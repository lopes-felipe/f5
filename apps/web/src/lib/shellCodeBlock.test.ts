import { describe, expect, it } from "vitest";
import { hasClosedCodeFence, runnableShellCode } from "./shellCodeBlock";

describe("shell code execution", () => {
  it("retains multiline commands and refuses invisible or incomplete source", () => {
    expect(runnableShellCode("bash", "\n echo first\n\techo second\n")).toBe(
      "echo first\n\techo second",
    );
    for (const source of [
      "",
      "echo \\\n",
      "echo \u001b[2J",
      "echo \u202Ehidden",
      "echo \u{e0001}",
      "x".repeat(32_001),
    ]) {
      expect(runnableShellCode("sh", source)).toBeNull();
    }
    expect(runnableShellCode("typescript", "echo 1")).toBeNull();
  });
  it("requires a closing fence of the same type and sufficient length", () => {
    for (const text of ["```sh\necho hi\n```", "~~~~sh\necho hi\n~~~~~"]) {
      expect(hasClosedCodeFence(text, 0, text.length)).toBe(true);
    }
    for (const text of ["```sh\necho hi", "````sh\necho hi\n```", "```sh\necho hi\n~~~"]) {
      expect(hasClosedCodeFence(text, 0, text.length)).toBe(false);
    }
    expect(hasClosedCodeFence("echo hi", undefined, undefined)).toBe(false);
  });
});
