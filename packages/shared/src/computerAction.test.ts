import { describe, expect, it } from "vitest";
import {
  computerToolHeading,
  computerToolOp,
  extractComputerStep,
  previewToolHeading,
  previewToolOp,
  sanitizeComputerStep,
} from "./computerAction";

describe("computerToolOp", () => {
  it("maps prefixed and bare tool names to ops", () => {
    expect(computerToolOp("mcp__f5_computer__computer_activate_app")).toBe("activateApp");
    expect(computerToolOp("computer_click")).toBe("click");
    expect(computerToolOp("computer_unknown")).toBeUndefined();
    expect(computerToolOp("preview_click")).toBeUndefined();
  });

  it("keeps the existing heading wording", () => {
    expect(computerToolHeading("computer_click", "inProgress")).toBe("Clicking…");
    expect(computerToolHeading("computer_click", "failed")).toBe("Clicking failed");
    expect(computerToolHeading("computer_click", "completed")).toBe("Clicked");
  });
});

describe("previewToolOp", () => {
  it.each(["f5_preview", "f5_preview_2", "__f5_preview", "f5_preview_ab12cd34"])(
    "accepts the %s server",
    (server) => {
      expect(previewToolOp(server, "preview_click")).toBe("click");
      expect(previewToolOp(undefined, `mcp__${server}__preview_wait_for`)).toBe("wait_for");
    },
  );

  it("rejects lookalike servers and unknown tools", () => {
    expect(previewToolOp("my_f5_preview", "preview_click")).toBeUndefined();
    expect(previewToolOp("f5_preview", "preview_teleport")).toBeUndefined();
    expect(previewToolOp("f5_preview", "computer_click")).toBeUndefined();
    expect(previewToolOp(undefined, "preview_click")).toBeUndefined();
  });

  it("words preview headings", () => {
    expect(previewToolHeading("preview_navigate", "inProgress")).toBe("Navigating…");
    expect(previewToolHeading("mcp__f5_preview__preview_snapshot", "completed")).toBe(
      "Read the page",
    );
  });
});

describe("extractComputerStep", () => {
  const ok = (structuredContent: Record<string, unknown>) => ({
    structuredContent,
    content: [{ type: "text", text: JSON.stringify(structuredContent) }],
  });

  it("keeps key chords made only of key names", () => {
    expect(
      extractComputerStep("computer_key", {
        input: { keys: ["Meta+L"], repeat: 2 },
        result: ok({ appName: "Google Chrome" }),
      }),
    ).toEqual({ appName: "Google Chrome", keyChord: "Meta+L", repeat: 2 });
    expect(
      extractComputerStep("computer_key", { input: { keys: "Meta++" }, result: ok({}) }),
    ).toEqual({ keyChord: "Meta++" });
  });

  it("drops chords that could be free text, and chords of failed calls", () => {
    expect(
      extractComputerStep("computer_key", { input: { keys: "hunter2" }, result: ok({}) }),
    ).toBeUndefined();
    expect(
      extractComputerStep("computer_key", {
        input: { keys: "Enter" },
        result: { isError: true, structuredContent: { error: { _tag: "TargetBlocked" } } },
      }),
    ).toEqual({ outcome: "TargetBlocked" });
    expect(extractComputerStep("computer_key", { input: { keys: "Enter" } })).toBeUndefined();
  });

  it("counts typed code points without copying the text", () => {
    const step = extractComputerStep("computer_type", {
      input: { text: "PRIVATE_🙂" },
      result: ok({}),
    });
    expect(step).toEqual({ typedLength: 9 });
    expect(JSON.stringify(step)).not.toContain("PRIVATE");
  });

  it("reads app and outcome from text JSON when structured content is absent", () => {
    expect(
      extractComputerStep("computer_click", {
        input: { x: 640.4, y: 212 },
        result: [
          { type: "text", text: JSON.stringify({ appName: "Finder", outcome: "verified" }) },
        ],
      }),
    ).toEqual({ appName: "Finder", x: 640, y: 212, outcome: "verified" });
  });

  it("ignores non-computer tools", () => {
    expect(extractComputerStep("preview_click", { input: { x: 1, y: 2 } })).toBeUndefined();
  });
});

describe("sanitizeComputerStep", () => {
  it("rejects bad types and overlong values", () => {
    expect(
      sanitizeComputerStep({
        appName: "x".repeat(201),
        x: "1",
        y: 2,
        keyChord: "secret words",
        repeat: 1.5,
        typedLength: -1,
        outcome: "has spaces",
      }),
    ).toBeUndefined();
    expect(sanitizeComputerStep("nope")).toBeUndefined();
  });

  it("round-trips a valid summary", () => {
    const step = { appName: "Chrome", x: 1, y: 2, keyChord: "Meta+,, Enter", repeat: 3 };
    expect(sanitizeComputerStep(step)).toEqual(step);
  });
});
