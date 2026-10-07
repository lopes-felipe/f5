import { describe, expect, it } from "vitest";

import { parseCodexCliVersion } from "./codexCliVersion";
import {
  checkCodexClientRequests,
  diffCodexProtocolSurface,
  isExpectedCodexProtocolVersion,
} from "./codexProtocolAudit";
import {
  CODEX_CLIENT_REQUEST_METHODS,
  CODEX_NOTIFICATION_METHODS,
  CODEX_SERVER_REQUEST_METHODS,
  CODEX_THREAD_ITEM_TYPES,
} from "./codexProtocolManifest";

describe("Codex client request audit", () => {
  const allPreferred = CODEX_CLIENT_REQUEST_METHODS.map((group) => group[0]);

  it("accepts a CLI that only offers the fallback, and reports it", () => {
    const legacy = allPreferred.filter((method) => method !== "thread/revert");
    expect(checkCodexClientRequests([...legacy, "thread/rollback"])).toEqual({
      unsupported: [],
      usingFallback: ["thread/revert -> thread/rollback"],
    });
  });

  it("flags a request group the CLI no longer supports at all", () => {
    const report = diffCodexProtocolSurface({
      notifications: CODEX_NOTIFICATION_METHODS,
      requests: CODEX_SERVER_REQUEST_METHODS,
      items: CODEX_THREAD_ITEM_TYPES,
      clientRequests: allPreferred.filter((method) => method !== "thread/revert"),
    });
    expect(report.clientRequests.unsupported).toEqual([
      "thread/revert | thread/rollback | thread/fork",
    ]);
    expect(report.hasDrift).toBe(true);
  });

  it("skips the client check when the surface omits it", () => {
    const report = diffCodexProtocolSurface({
      notifications: CODEX_NOTIFICATION_METHODS,
      requests: CODEX_SERVER_REQUEST_METHODS,
      items: CODEX_THREAD_ITEM_TYPES,
    });
    expect(report.hasDrift).toBe(false);
  });
});

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
