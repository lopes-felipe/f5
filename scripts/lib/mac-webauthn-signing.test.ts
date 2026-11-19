import { describe, expect, it } from "vitest";
import { renderWebAuthnSigningPlist } from "./mac-webauthn-signing";

const base = "<plist><dict><key>com.apple.security.cs.allow-jit</key><true/></dict></plist>";
describe("macOS passkey signing", () => {
  it("adds only provisioning-profile-authorized capabilities", () => {
    const text = renderWebAuthnSigningPlist(
      base,
      {
        Entitlements: {
          "com.apple.application-identifier": "TEAM.io.github.lopesfelipe.f5",
          "keychain-access-groups": ["TEAM.*"],
          "com.apple.developer.web-browser.public-key-credential": true,
        },
      },
      "io.github.lopesfelipe.f5",
    );
    expect(text).toContain("TEAM.io.github.lopesfelipe.f5.webauthn");
    expect(text).toContain("web-browser.public-key-credential");
    expect(text).toContain("allow-jit");
  });
  it("keeps ungranted capabilities off and rejects another application's profile", () => {
    const text = renderWebAuthnSigningPlist(
      base,
      {
        Entitlements: {
          "com.apple.application-identifier": "TEAM.io.github.lopesfelipe.f5",
        },
      },
      "io.github.lopesfelipe.f5",
    );
    expect(text).not.toContain("keychain-access-groups");
    expect(text).not.toContain("web-browser.public-key-credential");
    expect(() =>
      renderWebAuthnSigningPlist(
        base,
        {
          Entitlements: {
            "application-identifier": "OTHER.com.other",
          },
        },
        "io.github.lopesfelipe.f5",
      ),
    ).toThrow("application identifier");
  });
});
