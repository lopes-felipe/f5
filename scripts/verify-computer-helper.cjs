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
    // electron-builder's Arch.arm64. Linux VM profiles exist only on Apple silicon.
    if (context.arch === 3) verifyLima(app);
  } else verify("signtool", ["verify", "/pa", helper]);
};

function defaultRun(command, args) {
  const result = spawnSync(command, args, { encoding: "utf8" });
  return {
    status: result.error ? null : result.status,
    output: `${result.stdout ?? ""}${result.stderr ?? ""}`,
  };
}

/**
 * The macOS arm64 app must carry Lima for Linux VM profiles: `limactl` signed with hardened
 * runtime and the virtualization entitlement (Virtualization.framework refuses to run VMs
 * for a process without it), plus the Linux guest agent and the templates limactl reads.
 */
function verifyLima(app, run = defaultRun) {
  const lima = join(app, "Contents/Resources/native/lima");
  const limactl = join(lima, "bin/limactl");
  for (const file of [
    limactl,
    join(lima, "share/lima/lima-guestagent.Linux-aarch64.gz"),
    join(lima, "share/lima/templates/default.yaml"),
  ])
    if (!existsSync(file)) throw new Error(`Packaged Lima file missing: ${file}`);
  if (run("codesign", ["--verify", "--strict", limactl]).status !== 0)
    throw new Error("limactl signing verification failed");
  const details = run("codesign", ["-dv", limactl]);
  if (details.status !== 0 || !/flags=0x[0-9a-f]*\([^)]*\bruntime\b/.test(details.output))
    throw new Error("limactl is not signed with hardened runtime");
  const entitlements = run("codesign", ["-d", "--entitlements", "-", "--xml", limactl]);
  if (
    entitlements.status !== 0 ||
    !entitlements.output.includes("<key>com.apple.security.virtualization</key><true/>")
  )
    throw new Error("limactl lacks the com.apple.security.virtualization entitlement");
}
exports.verifyLima = verifyLima;
