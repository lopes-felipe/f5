import { spawnSync } from "node:child_process";

/** Metadata alone can survive tampering; verify the bytes before trusting the signer. */
export function verifyCodexVendorSignature(
  file: string,
  run: (args: string[]) => { status: number | null; stderr: string } = (args) =>
    spawnSync("/usr/bin/codesign", args, { encoding: "utf8", timeout: 10_000 }),
): void {
  const verified = run(["--verify", "--strict", file]);
  if (verified.status !== 0)
    throw new Error("Bundled Codex vendor signature verification failed: " + file);
  const signature = run(["-dv", "--verbose=2", file]);
  if (signature.status !== 0 || !/^TeamIdentifier=2DC432GLL2$/m.test(signature.stderr))
    throw new Error("Bundled Codex vendor signer changed: " + file);
}
