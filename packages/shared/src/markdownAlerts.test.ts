import { describe, expect, it } from "vitest";
import { matchGfmAlertMarker, splitGfmAlert, type GfmAlertNode } from "./markdownAlerts";

const paragraph = (...children: GfmAlertNode[]): GfmAlertNode => ({ type: "paragraph", children });
const text = (value: string): GfmAlertNode => ({ type: "text", value });

describe("matchGfmAlertMarker", () => {
  it.each(["NOTE", "TIP", "IMPORTANT", "WARNING", "CAUTION", "warning"])("matches %s", (name) => {
    expect(matchGfmAlertMarker(`[!${name}]\nBody`)).toEqual({
      type: name.toLowerCase(),
      length: name.length + 4,
      endsLine: true,
    });
  });

  it("rejects unknown types and markers followed by text on the same line", () => {
    expect(matchGfmAlertMarker("[!FOO]\nBody")).toBeNull();
    expect(matchGfmAlertMarker("[!NOTE] trailing")).toBeNull();
    expect(matchGfmAlertMarker("see [!NOTE]")).toBeNull();
  });
});

describe("splitGfmAlert", () => {
  it("strips the marker line and keeps the body", () => {
    expect(splitGfmAlert({ children: [paragraph(text("[!TIP]\nUse it."))] })).toEqual({
      type: "tip",
      children: [paragraph(text("Use it."))],
    });
  });

  it("removes a hard break after the marker and drops a marker-only paragraph", () => {
    expect(
      splitGfmAlert({ children: [paragraph(text("[!NOTE]"), { type: "break" }, text("Body"))] }),
    ).toEqual({ type: "note", children: [paragraph(text("Body"))] });
    const body = paragraph(text("Body"));
    expect(splitGfmAlert({ children: [paragraph(text("[!CAUTION]")), body] })).toEqual({
      type: "caution",
      children: [body],
    });
  });

  it("is not an alert when the marker shares its line with inline content", () => {
    expect(
      splitGfmAlert({ children: [paragraph(text("[!NOTE]"), { type: "strong", children: [] })] }),
    ).toBeNull();
    expect(splitGfmAlert({ children: [paragraph(text("Before [!NOTE]"))] })).toBeNull();
  });
});
