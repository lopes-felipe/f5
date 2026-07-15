import { describe, expect, it } from "vitest";

import { parseCodexCliVersion } from "./codexCliVersion";
import { isExpectedCodexProtocolVersion } from "./codexProtocolAudit";

describe("Codex protocol audit versions", () => {
  it("parses release and prerelease Codex CLI output", () => {
    expect(parseCodexCliVersion("codex-cli 0.144.3")).toBe("0.144.3");
    expect(parseCodexCliVersion("codex-cli 0.145.0-alpha.2")).toBe("0.145.0-alpha.2");
    expect(parseCodexCliVersion("not a version")).toBeNull();
  });

  it("requires the exact audited Codex version", () => {
    expect(isExpectedCodexProtocolVersion("codex-cli 0.144.3", "0.144.3")).toBe(true);
    expect(isExpectedCodexProtocolVersion("codex-cli 0.144.1", "0.144.3")).toBe(false);
    expect(isExpectedCodexProtocolVersion("codex-cli 0.145.0", "0.144.3")).toBe(false);
  });
});
