export interface WebAuthnEntitlements {
  readonly touchIdKeychainAccessGroup?: string;
  readonly browserPasskeys: boolean;
}

/** Uses the effective code signature, never an entitlement claimed by a page or package file. */
export function resolveWebAuthnEntitlements(value: unknown): WebAuthnEntitlements {
  if (!value || typeof value !== "object") return { browserPasskeys: false };
  const raw = value as Record<string, unknown>;
  const identifier = raw["com.apple.application-identifier"] ?? raw["application-identifier"];
  const groups = raw["keychain-access-groups"];
  const group = typeof identifier === "string" ? identifier + ".webauthn" : undefined;
  const authorized =
    group !== undefined &&
    Array.isArray(groups) &&
    groups.some(
      (entry) =>
        typeof entry === "string" &&
        (entry === group || (entry.endsWith("*") && group.startsWith(entry.slice(0, -1)))),
    );
  return {
    browserPasskeys: raw["com.apple.developer.web-browser.public-key-credential"] === true,
    ...(authorized ? { touchIdKeychainAccessGroup: group } : {}),
  };
}
