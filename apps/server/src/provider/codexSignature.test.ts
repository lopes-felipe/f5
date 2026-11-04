import { expect, it, vi } from "vitest";
import { verifyCodexVendorSignature } from "./codexSignature";

it("rejects tampered files before accepting retained signature metadata", () => {
  const run = vi.fn(() => ({ status: 1, stderr: "TeamIdentifier=2DC432GLL2\n" }));
  expect(() => verifyCodexVendorSignature("/codex", run)).toThrow("verification failed");
  expect(run).toHaveBeenCalledExactlyOnceWith(["--verify", "--strict", "/codex"]);
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
