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
    for (const text of [
      "```sh\necho hi\n```",
      "~~~~sh\necho hi\n~~~~~",
      "```sh\r\necho hi\r\n```",
    ]) {
      expect(hasClosedCodeFence(text, 0, text.length, "echo hi\n")).toBe(true);
    }
    for (const text of ["```sh\necho hi", "````sh\necho hi\n```", "```sh\necho hi\n~~~"]) {
      expect(hasClosedCodeFence(text, 0, text.length, "echo hi\n")).toBe(false);
    }
    expect(hasClosedCodeFence("echo hi", undefined, undefined, "echo hi\n")).toBe(false);
  });
  it("ignores overindented markers and CRLF stream cuts the parser keeps as code", () => {
    const overindented = "- Diagram\n\n  ```sh\n  echo hi\n      ```";
    const start = overindented.indexOf("```");
    expect(hasClosedCodeFence(overindented, start, overindented.length, "echo hi\n    ```\n")).toBe(
      false,
    );
    const crCut = "```sh\r\necho hi\r\n\t```\r";
    expect(hasClosedCodeFence(crCut, 0, crCut.length, "echo hi\r\n\t```\n")).toBe(false);
  });
});
