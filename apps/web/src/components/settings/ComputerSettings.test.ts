import { describe, expect, it } from "vitest";

import {
  backgroundUnavailableReason,
  computerPasswordMaskingDescription,
} from "./ComputerSettings";

describe("password masking description", () => {
  it("discloses visible password fields in fast mode", () => {
    expect(
      computerPasswordMaskingDescription({
        available: true,
        passwordMaskingSupported: true,
      }),
    ).toBe(
      "Fast mode improves screenshot performance. Password fields Chrome omits from accessibility search may appear in screenshots sent to your model.",
    );
  });
  it("identifies legacy helpers and platforms without selectable masking", () => {
    for (const status of [undefined, { available: true as const }]) {
      const description = computerPasswordMaskingDescription(status);
      expect(description).toContain("requires an updated computer helper");
      expect(description).toContain("Legacy / unknown");
    }
  });
});

describe("backgroundUnavailableReason", () => {
  it("points remote clients at the computer running F5 instead of checking forever", () => {
    expect(backgroundUnavailableReason(undefined, false)).toBe(
      "Choose background on the computer running F5.",
    );
  });

  it("waits for the desktop status when bridged", () => {
    expect(backgroundUnavailableReason(undefined)).toBe("Checking…");
  });

  it("is available only with the negotiated background capability", () => {
    expect(
      backgroundUnavailableReason({ available: true, background: { available: true } }),
    ).toBeUndefined();
    expect(backgroundUnavailableReason({ available: true })).toBe(
      "This F5 build or helper does not support background control.",
    );
    expect(
      backgroundUnavailableReason({
        available: true,
        background: { available: false, reason: "preview-off" },
      }),
    ).toBe("Background control is not enabled in this build yet.");
  });
});
