import { describe, expect, it } from "vitest";
import { createInitialDesktopUpdateState } from "./updateMachine";
import {
  BackendOutputTail,
  resolveStartupRecoveryOffer,
  startupRecoveryAction,
  startupRecoveryHtml,
} from "./startupRecovery";

const initial = () => ({
  ...createInitialDesktopUpdateState("0.1.3", {
    hostArch: "arm64",
    appArch: "arm64",
    runningUnderArm64Translation: false,
  }),
  enabled: true,
});

describe("startup recovery", () => {
  it("prefers updates, waits for checks, and falls back to a previous working release", () => {
    expect(
      resolveStartupRecoveryOffer(
        { ...initial(), status: "available", availableVersion: "0.1.4" },
        "0.1.2",
        null,
      ),
    ).toEqual({ kind: "update", version: "0.1.4" });
    expect(
      resolveStartupRecoveryOffer({ ...initial(), status: "checking" }, "0.1.2", null),
    ).toEqual({ kind: "checking" });
    expect(
      resolveStartupRecoveryOffer(
        { ...initial(), status: "error", downloadedVersion: "0.1.4" },
        null,
        null,
      ),
    ).toEqual({ kind: "update", version: "0.1.4" });
    expect(
      resolveStartupRecoveryOffer(
        { ...initial(), status: "downloaded", downloadedVersion: "0.1.4" },
        "0.1.2",
        "0.1.4",
      ),
    ).toEqual({ kind: "download", version: "0.1.2" });
    expect(
      resolveStartupRecoveryOffer(
        { ...initial(), status: "disabled", enabled: false },
        "0.1.3",
        null,
      ),
    ).toEqual({ kind: "download", version: null });
  });

  it("bounds output and preserves split UTF-8 and well-formed surrogate pairs", () => {
    const tail = new BackendOutputTail();
    const encoder = new TextEncoder();
    tail.append("stdout", encoder.encode("😀" + "x".repeat(3_999)));
    tail.append("stderr", new Uint8Array([0xc3]));
    tail.append("stderr", new Uint8Array([0xa9]));
    expect(tail.value).toHaveLength(4_000);
    expect(tail.value.endsWith("é")).toBe(true);
    expect(() => encodeURIComponent(tail.value)).not.toThrow();
  });

  it("escapes server output and allows only the recovery actions", () => {
    const html = startupRecoveryHtml({
      version: "1",
      profile: "Default",
      failure: { reason: "<script>bad</script>", output: "<img onerror='bad'>" },
      offer: { kind: "download", version: null },
      logDir: "/tmp",
    });
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain("<img");
    expect(html).toContain("default-src 'none'");
    expect(startupRecoveryAction("https://startup-recovery.invalid/update")).toBe("update");
    expect(startupRecoveryAction("https://startup-recovery.invalid/retry")).toBe("retry");
    expect(html).toContain(">Retry</a>");
    expect(startupRecoveryAction("https://evil.invalid/update")).toBeNull();
    expect(startupRecoveryAction("https://startup-recovery.invalid/anything")).toBeNull();
  });

  it("keeps the recovery document stable while download progress advances", () => {
    const input = {
      version: "1",
      profile: "Default",
      failure: { reason: "Failed", output: "Output" },
      logDir: "/tmp",
    };
    expect(startupRecoveryHtml({ ...input, offer: { kind: "downloading", percent: 2 } })).toBe(
      startupRecoveryHtml({ ...input, offer: { kind: "downloading", percent: 80 } }),
    );
  });
});
