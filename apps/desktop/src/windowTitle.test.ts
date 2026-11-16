import { describe, expect, it } from "vitest";

import { composeNativeWindowTitle } from "./windowTitle";

const work = { name: "Work", isDefault: false };
const fallback = { name: "Default", isDefault: true };

describe("composeNativeWindowTitle", () => {
  it("keeps the page title, including the attention prefix, and adds the profile", () => {
    expect(
      composeNativeWindowTitle({ pageTitle: "(2) Settings · F5", appName: "F5", profile: work }),
    ).toBe("(2) Settings · F5 · Work");
  });

  it("falls back to the app name for an empty page title", () => {
    expect(composeNativeWindowTitle({ pageTitle: " ", appName: "F5 (Dev)", profile: work })).toBe(
      "F5 (Dev) · Work",
    );
  });

  it("omits the profile for the Default profile", () => {
    expect(
      composeNativeWindowTitle({ pageTitle: "Usage · F5", appName: "F5", profile: fallback }),
    ).toBe("Usage · F5");
    expect(composeNativeWindowTitle({ pageTitle: "", appName: "F5", profile: fallback })).toBe(
      "F5",
    );
  });
});
