const { createRequire } = require("node:module");
const { resolve } = require("node:path");

function preserveCodexVendorSignature(file) {
  return /\/node_modules\/@openai\/codex-[^/]+\/vendor(?:\/|$)/.test(file.replaceAll("\\", "/"));
}
exports.preserveCodexVendorSignature = preserveCodexVendorSignature;

/**
 * The Dock tile plug-in's executable (scripts/build-dock-tile.ts). Signing a bundle's main
 * executable signs and seals the whole bundle, so this one path is enough.
 */
const DOCK_TILE_EXECUTABLE =
  "/Contents/PlugIns/F5DockTile.docktileplugin/Contents/MacOS/F5DockTile";

/**
 * electron-builder's default `ignore` skips everything under Contents/PlugIns, and
 * osx-sign applies it to `binaries` too, so without this the plug-in would ship with only
 * its ad hoc linker signature. The rest of PlugIns, including the plug-in's images, stays
 * skipped: the bundle signature seals them.
 */
function signingIgnore(options) {
  const inherited = (file) =>
    typeof options.ignore === "function"
      ? options.ignore(file)
      : (options.ignore ?? []).some((pattern) =>
          typeof pattern === "function" ? pattern(file) : file.match(pattern),
        );
  return (file) => {
    if (file.replaceAll("\\", "/").endsWith(DOCK_TILE_EXECUTABLE)) return false;
    // Codex Chrome certification requires OpenAI's original Developer ID signature.
    return preserveCodexVendorSignature(file) || Boolean(inherited(file));
  };
}
exports.signingIgnore = signingIgnore;

// Bundled executables signed with their own entitlements instead of the app's.
const PER_FILE_ENTITLEMENTS = {
  "/Contents/Resources/native/f5-computer-helper": "entitlements.computer-helper.plist",
  // Lima boots Linux VM profiles with Virtualization.framework.
  "/Contents/Resources/native/lima/bin/limactl": "entitlements.lima.plist",
  // Loaded into the Dock's process, which ignores a plug-in's entitlements: it needs none.
  [DOCK_TILE_EXECUTABLE]: "entitlements.dock-tile.plist",
};
exports.PER_FILE_ENTITLEMENTS = PER_FILE_ENTITLEMENTS;

function perFileOptions(options, file) {
  const inherited = options.optionsForFile?.(file) ?? {};
  const normalized = file.replaceAll("\\", "/");
  const suffix = Object.keys(PER_FILE_ENTITLEMENTS).find((path) => normalized.endsWith(path));
  if (!suffix) return inherited;
  return {
    ...inherited,
    entitlements: resolve(__dirname, "../apps/desktop/resources", PER_FILE_ENTITLEMENTS[suffix]),
    hardenedRuntime: true,
  };
}
exports.perFileOptions = perFileOptions;
function timestampFailure(error) {
  const detail = [error?.message, error?.stderr, error?.cause?.message].join("\n");
  if (
    /certificate.*(?:expired|revoked|not trusted|invalid)|(?:invalid|missing|unsupported) entitlements?|entitlements?.*(?:not permitted|invalid)|identity.*(?:not found|invalid)|verification failed|invalid signature/i.test(
      detail,
    )
  )
    return false;
  return /A timestamp was expected but was not found|timestamp (?:service|server).*(?:unavailable|not available|timed? out|ECONNRESET|HTTP 50[234])/i.test(
    detail,
  );
}
async function signWithRetry(
  sign,
  options,
  delay = (ms) => new Promise((done) => setTimeout(done, ms)),
) {
  try {
    return await sign(options);
  } catch (error) {
    if (!timestampFailure(error)) throw error;
    console.warn("Transient macOS signing timestamp failure; retrying the same application once.");
    if (process.env.F5_SIGNING_RETRY_REPORT) {
      const fs = require("node:fs");
      fs.appendFileSync(process.env.F5_SIGNING_RETRY_REPORT, "timestamp-retry\n");
    }
    await delay(5000);
    return sign(options);
  }
}
exports.timestampFailure = timestampFailure;
exports.signWithRetry = signWithRetry;
exports.default = async (options) => {
  // Resolve the exact osx-sign version owned by the pinned electron-builder.
  const builderRequire = createRequire(require.resolve("electron-builder"));
  const libRequire = createRequire(builderRequire.resolve("app-builder-lib"));
  const { signAsync } = libRequire("@electron/osx-sign");
  return signWithRetry(signAsync, {
    ...options,
    ignore: signingIgnore(options),
    preAutoEntitlements: false,
    optionsForFile: (file) => perFileOptions(options, file),
  });
};
