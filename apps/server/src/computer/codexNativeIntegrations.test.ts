import { describe, expect, it } from "vitest";
import { PROVIDER_INTEGRATION_RECORDS } from "@t3tools/shared/providerIntegrationCertification";
import { parseNativeHostManifest } from "../provider/chromeNativeHost";
import {
  CODEX_CHROME_HELPER_STALE,
  codexChromeChildEnvironment,
  codexChromeRegistrationsUnchanged,
  inspectCodexChrome,
  versionInRange,
  type CodexInspectionIo,
} from "./codexNativeIntegrations";

const record = PROVIDER_INTEGRATION_RECORDS["codex-chrome"][0]!;
const version = record.versions.appMin!;
const APP = "/Applications/ChatGPT.app";
const PLUGIN = `${APP}/Contents/Resources/plugins/openai-bundled/plugins/chrome`;
const CACHE = "/Users/me/.codex/plugins/cache/openai-bundled/chrome";
const HOST = `${CACHE}/${version}/extension-host/macos/arm64/ChatGPT for Chrome`;

function fixture(
  patch: {
    appVersion?: string;
    pluginVersion?: string;
    hostName?: string;
    extensionIds?: string[];
    signatureFails?: string;
    helperMissing?: boolean;
    registrationTarget?: string;
    origins?: string[];
    noRegistrations?: boolean;
  } = {},
) {
  const files: Record<string, string> = {
    [`${APP}/Contents/Info.plist`]: `<plist><dict><key>CFBundleIdentifier</key><string>com.openai.codex</string><key>CFBundleShortVersionString</key><string>${patch.appVersion ?? version}</string></dict></plist>`,
    [`${PLUGIN}/.codex-plugin/plugin.json`]: JSON.stringify({
      name: "chrome",
      version: patch.pluginVersion ?? version,
    }),
    [`${PLUGIN}/scripts/extension-ids.json`]: JSON.stringify({
      extensionHostName: patch.hostName ?? record.identity.hostName,
      extensionIds:
        patch.extensionIds ??
        record.identity.allowedOrigins.map((origin) =>
          origin.slice("chrome-extension://".length, -1),
        ),
    }),
    [`${PLUGIN}/scripts/browser-client.mjs`]: "",
    [`${PLUGIN}/scripts/browser-service.mjs`]: "",
    [`${PLUGIN}/skills/control-chrome/SKILL.md`]: "",
  };
  const verified: string[] = [];
  const helper = { version: 1 };
  const io: CodexInspectionIo = {
    readText: async (path) => {
      if (path in files) return files[path]!;
      throw Object.assign(new Error("missing"), { code: "ENOENT" });
    },
    isFile: async (path) => path in files,
    realpath: async (path) => {
      if (
        path === `${CACHE}/latest/extension-host/macos/arm64/ChatGPT for Chrome` ||
        path === HOST
      ) {
        if (patch.helperMissing) throw new Error("missing");
        return HOST;
      }
      if (path === CACHE) return CACHE;
      return path;
    },
    fingerprint: async (path) => `${path}@${helper.version}`,
    verify: async (path, requirement) => {
      verified.push(`${path}|${requirement.identifier ?? ""}`);
      return patch.signatureFails && path.endsWith(patch.signatureFails)
        ? { ok: false, reason: "mismatch" }
        : { ok: true, teamId: requirement.teamId, identifier: requirement.identifier ?? "" };
    },
    inspectRegistrations: async (descriptor) =>
      patch.noRegistrations
        ? []
        : descriptor.locations("", "/Users/me").map((location, index) =>
            index === 0 && location.kind === "file"
              ? parseNativeHostManifest(
                  location.browser,
                  location.path,
                  JSON.stringify({
                    name: record.identity.hostName,
                    type: "stdio",
                    path:
                      patch.registrationTarget ??
                      `${CACHE}/latest/extension-host/macos/arm64/ChatGPT for Chrome`,
                    allowed_origins: patch.origins ?? record.identity.allowedOrigins,
                  }),
                )
              : {
                  browser: location.browser,
                  location: location.kind === "file" ? location.path : "",
                  state: "absent" as const,
                },
          ),
  };
  return { io, verified, helper };
}
const inspect = (patch?: Parameters<typeof fixture>[0]) => {
  const { io, verified } = fixture(patch);
  return inspectCodexChrome({
    platform: "darwin",
    arch: "arm64",
    userHome: "/Users/me",
    record,
    io,
  }).then((result) => ({ result, verified }));
};

// ChatGPT.app inspection is macOS only; the fixtures are POSIX paths.
describe.skipIf(process.platform === "win32")("Codex Chrome inspection", () => {
  it("verifies the app, runtime and helper signatures with their pinned identifiers", async () => {
    const { result, verified } = await inspect();
    expect(result).toMatchObject({ available: true, hostTarget: HOST, pluginRoot: PLUGIN });
    expect(verified).toEqual([
      `${APP}|com.openai.codex`,
      `${APP}/Contents/Resources/cua_node/bin/node_repl|node_repl`,
      `${HOST}|extension-host`,
    ]);
  });

  it.each([
    [{ signatureFails: "ChatGPT.app" }, "signature"],
    [{ signatureFails: "node_repl" }, "signature"],
    [{ signatureFails: "ChatGPT for Chrome" }, "helper-stale"],
    [{ appVersion: "26.1014.1" }, "version"],
    [{ pluginVersion: "26.1012.1" }, "version"],
    [{ hostName: "com.example.other" }, "malformed"],
    [{ extensionIds: ["aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"] }, "malformed"],
    [{ helperMissing: true }, "helper-stale"],
    [{ registrationTarget: "/tmp/evil" }, "helper-stale"],
    [{ origins: ["chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/"] }, "registration"],
    [{ noRegistrations: true }, "registration"],
  ])("fails closed: %j", async (patch, state) => {
    expect((await inspect(patch)).result).toMatchObject({ available: false, state });
  });

  it("treats a replaced helper as changed setup mid-session", async () => {
    const { io, helper } = fixture();
    const installation = await inspectCodexChrome({
      platform: "darwin",
      arch: "arm64",
      userHome: "/Users/me",
      record,
      io,
    });
    if (!installation.available) throw new Error(installation.reason);
    expect(await codexChromeRegistrationsUnchanged(installation, "/Users/me", io)).toBe(true);
    // Same manifests, different file behind the signature-checked path.
    helper.version = 2;
    expect(await codexChromeRegistrationsUnchanged(installation, "/Users/me", io)).toBe(false);
  });

  it("asks the user to open the ChatGPT app when the helper is stale", async () => {
    expect((await inspect({ helperMissing: true })).result).toMatchObject({
      reason: CODEX_CHROME_HELPER_STALE,
    });
  });

  it("deduplicates the record's browser folders", () => {
    const locations = record.browsers.map((browser) => browser.nativeMessagingPath.join("/"));
    expect(new Set(locations).size).toBe(locations.length);
  });

  it("builds the child environment without inheriting secrets", async () => {
    const { result } = await inspect();
    if (!result.available) throw new Error("fixture should be available");
    const env = codexChromeChildEnvironment(result, "/isolated/codex", {
      PATH: "/bin",
      OPENAI_API_KEY: "secret",
      F5_PREVIEW_MCP_TOKEN_X: "token",
    });
    expect(env).toMatchObject({
      CODEX_HOME: "/isolated/codex",
      BROWSER_USE_AVAILABLE_BACKENDS: "chrome",
      NODE_REPL_TRUSTED_SERVICES: JSON.stringify({
        browser: `${PLUGIN}/scripts/browser-service.mjs`,
      }),
    });
    expect(env.OPENAI_API_KEY).toBeUndefined();
    expect(env.F5_PREVIEW_MCP_TOKEN_X).toBeUndefined();
  });

  it("compares dotted versions numerically", () => {
    expect(versionInRange("26.1013.40934", "26.1013.40934", "26.1013.40934")).toBe(true);
    expect(versionInRange("26.999.1", "26.1013.0", "27.0.0")).toBe(false);
    expect(versionInRange("26.1013.40934-beta", "26.0.0", "27.0.0")).toBe(false);
  });
});
