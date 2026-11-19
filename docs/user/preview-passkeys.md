# Passkeys in preview tabs

On macOS, preview tabs and their sign-in windows can use Touch ID and the system
passkey sheet when the signed F5 build has the corresponding Apple entitlements.
Unsigned development builds retain Chromium's default behavior. Conditional
autofill requests also stay with Chromium.

The native sheet uses the preview frame's actual committed origin. It is available
only for a focused main frame on HTTPS or a loopback development server. Credentials
are discarded if the requesting frame navigates away while the sheet is open.

## Building an entitled macOS release

Set F5_MAC_PROVISIONING_PROFILE to the provisioning profile for
io.github.lopesfelipe.f5 when creating a signed macOS artifact. The build checks
the profile's application identifier and adds only authorized capabilities:

- A keychain access group authorizing the application identifier followed by
  .webauthn enables Electron's Touch ID authenticator.
- The com.apple.developer.web-browser.public-key-credential entitlement enables
  the system sheet for passkeys belonging to arbitrary preview sites.

F5 reads the effective code signature at runtime before enabling either path.
Providing a profile cannot grant an entitlement Apple has not authorized.
