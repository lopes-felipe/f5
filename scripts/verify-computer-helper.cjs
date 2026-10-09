const { spawnSync } = require("node:child_process");
const { existsSync } = require("node:fs");
const { join } = require("node:path");

function verify(command, args) {
  const result = spawnSync(command, args, { stdio: "inherit" });
  if (result.error || result.status !== 0)
    throw new Error(`Computer helper signing verification failed: ${command}`);
}
exports.default = async (context) => {
  const mac = context.electronPlatformName === "darwin";
  const app = mac
    ? join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`)
    : context.appOutDir;
  const helper = mac
    ? join(app, "Contents/Resources/native/f5-computer-helper")
    : join(app, "resources/native/f5-computer-helper.exe");
  if (!existsSync(helper)) throw new Error(`Packaged computer helper missing: ${helper}`);
  if (mac) {
    verify("codesign", ["--verify", "--deep", "--strict", app]);
    verify("codesign", ["--verify", "--strict", helper]);
    verify("codesign", ["-dv", helper]);
  } else verify("signtool", ["verify", "/pa", helper]);
};
