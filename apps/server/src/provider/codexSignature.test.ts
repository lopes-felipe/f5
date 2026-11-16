import { expect, it, vi } from "vitest";
import { CODESIGN_TIMEOUT_MS, verifyCodexVendorSignature } from "./codexSignature";

it("rejects tampered files before accepting retained signature metadata", () => {
  const run = vi.fn(() => ({ status: 1, stderr: "/codex: invalid signature\n" }));
  expect(() => verifyCodexVendorSignature("/codex", run)).toThrow(
    "verification failed: /codex (status=1 stderr=/codex: invalid signature)",
  );
  expect(run).toHaveBeenCalledExactlyOnceWith(["--verify", "--strict", "/codex"]);
});
it("reports a codesign timeout as unfinished, not as a bad signature", () => {
  const run = vi.fn(() => ({
    status: null,
    signal: "SIGTERM" as const,
    error: new Error("spawnSync /usr/bin/codesign ETIMEDOUT"),
    stderr: "",
  }));
  expect(() => verifyCodexVendorSignature("/codex", run)).toThrow(
    "verification did not finish: /codex (status=null signal=SIGTERM error=spawnSync /usr/bin/codesign ETIMEDOUT)",
  );
});
it("gives slow runners enough time to verify large binaries", () => {
  expect(CODESIGN_TIMEOUT_MS).toBeGreaterThanOrEqual(60_000);
});
it("requires OpenAI's identity after successful verification", () => {
  const run = vi
    .fn()
    .mockReturnValueOnce({ status: 0, stderr: "" })
    .mockReturnValueOnce({ status: 0, stderr: "TeamIdentifier=F5\n" });
  expect(() => verifyCodexVendorSignature("/codex", run)).toThrow("signer changed");
});
it("accepts a verified OpenAI signature", () => {
  const run = vi.fn(() => ({ status: 0, stderr: "TeamIdentifier=2DC432GLL2\n" }));
  expect(() => verifyCodexVendorSignature("/codex", run)).not.toThrow();
  expect(run.mock.calls).toEqual([
    [["--verify", "--strict", "/codex"]],
    [["-dv", "--verbose=2", "/codex"]],
  ]);
});
