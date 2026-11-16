import { describe, expect, it } from "vitest";

import { APP_DISPLAY_NAME } from "../branding";
import { composeDocumentTitle } from "../lib/documentTitle";
import { resolveContextTitle } from "./useDocumentTitle";

describe("document titles", () => {
  it("composes page, app name and attention prefix", () => {
    expect(composeDocumentTitle(null, 0)).toBe(APP_DISPLAY_NAME);
    expect(composeDocumentTitle("  ", 0)).toBe(APP_DISPLAY_NAME);
    expect(composeDocumentTitle("Usage", 0)).toBe("Usage · F5");
    expect(composeDocumentTitle("Usage", 4)).toBe("(4) Usage · F5");
  });

  it("shows only the project unless detailed titles are enabled", () => {
    const input = { projectName: "f5", itemTitle: "Fix the secret login bug" };
    expect(resolveContextTitle("project", input)).toBe("f5");
    expect(resolveContextTitle("thread", input)).toBe("Fix the secret login bug");
    expect(resolveContextTitle("thread", { projectName: "f5", itemTitle: " " })).toBe("f5");
    expect(resolveContextTitle("project", { itemTitle: "Leaky title" })).toBeNull();
  });
});
