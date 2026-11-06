import { spawnSync } from "node:child_process";

type CodesignResult = {
  status: number | null;
  stderr: string;
  signal?: NodeJS.Signals | null;
  error?: Error;
};

// Verifying the bundled Intel binary on a freshly mounted DMG exceeded the former
// 10 s limit on hosted macos-15-intel runners, and the timeout was reported as a
// bad signature.
export const CODESIGN_TIMEOUT_MS = 120_000;

function describe(result: CodesignResult): string {
  const parts = [`status=${result.status}`];
  if (result.signal) parts.push(`signal=${result.signal}`);
  if (result.error) parts.push(`error=${result.error.message}`);
  const stderr = result.stderr.trim();
  if (stderr) parts.push(`stderr=${stderr.slice(0, 2_000)}`);
  return parts.join(" ");
}

/** Metadata alone can survive tampering; verify the bytes before trusting the signer. */
export function verifyCodexVendorSignature(
  file: string,
  run: (args: string[]) => CodesignResult = (args) =>
    spawnSync("/usr/bin/codesign", args, { encoding: "utf8", timeout: CODESIGN_TIMEOUT_MS }),
): void {
  const verified = run(["--verify", "--strict", file]);
  if (verified.status !== 0) {
    const reason = verified.error || verified.signal ? "did not finish" : "failed";
    throw new Error(
      `Bundled Codex vendor signature verification ${reason}: ${file} (${describe(verified)})`,
    );
  }
  const signature = run(["-dv", "--verbose=2", file]);
  if (signature.status !== 0 || !/^TeamIdentifier=2DC432GLL2$/m.test(signature.stderr))
    throw new Error(`Bundled Codex vendor signer changed: ${file} (${describe(signature)})`);
}
