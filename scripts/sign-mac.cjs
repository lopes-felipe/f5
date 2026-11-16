const { createRequire } = require("node:module");
const { resolve } = require("node:path");

function preserveCodexVendorSignature(file) {
  return /\/node_modules\/@openai\/codex-[^/]+\/vendor(?:\/|$)/.test(file.replaceAll("\\", "/"));
}
exports.preserveCodexVendorSignature = preserveCodexVendorSignature;

function perFileOptions(options, file) {
  const inherited = options.optionsForFile?.(file) ?? {};
  if (!file.replaceAll("\\", "/").endsWith("/Contents/Resources/native/f5-computer-helper"))
    return inherited;
  return {
    ...inherited,
    entitlements: resolve(
      __dirname,
      "../apps/desktop/resources/entitlements.computer-helper.plist",
    ),
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
    // Codex Chrome certification requires OpenAI's original Developer ID signature.
    ignore: (file) =>
      preserveCodexVendorSignature(file) ||
      (typeof options.ignore === "function"
        ? options.ignore(file)
        : (options.ignore ?? []).some((pattern) =>
            typeof pattern === "function" ? pattern(file) : file.match(pattern),
          )),
    preAutoEntitlements: false,
    optionsForFile: (file) => perFileOptions(options, file),
  });
};
