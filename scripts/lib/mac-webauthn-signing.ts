import { spawnSync } from "node:child_process";
import { resolveWebAuthnEntitlements } from "@t3tools/shared/macWebAuthn";

function xml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

/** Only grants present in the provisioning profile may enter the app signature. */
export function renderWebAuthnSigningPlist(base: string, value: unknown, appId: string): string {
  if (!value || typeof value !== "object") throw new Error("Invalid macOS provisioning profile.");
  const profile = value as { Entitlements?: Record<string, unknown> };
  const raw = profile.Entitlements;
  const identifier = raw?.["com.apple.application-identifier"] ?? raw?.["application-identifier"];
  if (typeof identifier !== "string" || !identifier.endsWith("." + appId))
    throw new Error("The provisioning profile does not authorize this application identifier.");
  const grants = resolveWebAuthnEntitlements(raw);
  const additions = [
    "<key>com.apple.application-identifier</key><string>" + xml(identifier) + "</string>",
    ...(typeof raw?.["com.apple.developer.team-identifier"] === "string"
      ? [
          "<key>com.apple.developer.team-identifier</key><string>" +
            xml(raw["com.apple.developer.team-identifier"]) +
            "</string>",
        ]
      : []),
    ...(grants.touchIdKeychainAccessGroup
      ? [
          "<key>keychain-access-groups</key><array><string>" +
            xml(grants.touchIdKeychainAccessGroup) +
            "</string></array>",
        ]
      : []),
    ...(grants.browserPasskeys
      ? ["<key>com.apple.developer.web-browser.public-key-credential</key><true/>"]
      : []),
  ].join("\n");
  const close = base.lastIndexOf("</dict>");
  if (close < 0) throw new Error("Invalid base macOS entitlements.");
  return base.slice(0, close) + additions + "\n" + base.slice(close);
}

export function readMacProvisioningProfile(file: string): unknown {
  const decoded = spawnSync("/usr/bin/security", ["cms", "-D", "-i", file], {
    encoding: "utf8",
    timeout: 5000,
    maxBuffer: 1024 * 1024,
  });
  if (decoded.status !== 0) throw new Error("Could not decode the macOS provisioning profile.");
  const json = spawnSync("/usr/bin/plutil", ["-convert", "json", "-o", "-", "-"], {
    input: decoded.stdout,
    encoding: "utf8",
    timeout: 5000,
    maxBuffer: 1024 * 1024,
  });
  if (json.status !== 0) throw new Error("Could not read provisioning profile entitlements.");
  return JSON.parse(json.stdout) as unknown;
}
