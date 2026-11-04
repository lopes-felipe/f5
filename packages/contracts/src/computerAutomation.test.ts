import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import {
  ComputerAutomationError,
  ComputerAutomationRequest,
  ComputerAutomationBackendStatus,
  ComputerInspectResult,
  ComputerScreenshot,
  RememberedComputerConsent,
  DesktopComputerHostMessage,
} from "./computerAutomation";

describe("computer observation and error metadata", () => {
  it("decodes session-close messages and rejects noncanonical typing policy", () => {
    const closed = { type: "computerSessionClosed", threadId: "t", sessionGeneration: "s" };
    expect(Schema.decodeUnknownSync(DesktopComputerHostMessage)(closed)).toEqual(closed);
    const policy = {
      version: 1,
      kind: "app-access",
      projectId: "p",
      appId: "app",
      tier: "full",
      allowTyping: false,
      policyVersion: 1,
    };
    expect(Schema.decodeUnknownSync(RememberedComputerConsent)(policy)).toEqual(policy);
    expect(() =>
      Schema.decodeUnknownSync(RememberedComputerConsent)({
        ...policy,
        allowTyping: true,
      }),
    ).toThrow();
  });
  it("accepts optional request policy and supported-helper status without changing legacy data", () => {
    const request = {
      op: "screenshot",
      requestId: "r",
      payloadHash: "0".repeat(64),
      authorization: {
        profileId: "p",
        threadId: "t",
        sessionGeneration: "s",
        turnId: "turn",
        executionGeneration: 1,
        grantVersion: 0,
        grants: [],
      },
      deadlineAtMs: 1,
      agent: { provider: "claude", threadTitle: "Thread" },
      displayId: "d",
    };
    expect(Schema.decodeUnknownSync(ComputerAutomationRequest)(request)).toEqual(request);
    for (const passwordMasking of ["fast", "conservative"]) {
      expect(
        Schema.decodeUnknownSync(ComputerAutomationRequest)({ ...request, passwordMasking }),
      ).toEqual({ ...request, passwordMasking });
    }
    expect(() =>
      Schema.decodeUnknownSync(ComputerAutomationRequest)({
        ...request,
        passwordMasking: "off",
      }),
    ).toThrow();
    for (const status of [
      { available: true },
      { available: true, passwordMaskingSupported: true },
      { available: true, hostPlatform: "win32", stopShortcut: "Ctrl+Alt+Shift+F12" },
      {
        available: false,
        reason: "monitor-unhealthy",
        hostPlatform: "win32",
        stopShortcut: "Ctrl+Alt+Shift+F12",
      },
    ]) {
      expect(Schema.decodeUnknownSync(ComputerAutomationBackendStatus)(status)).toEqual(status);
    }
  });
  it("decodes partial inspect snapshots", () => {
    const value = { snapshotId: "s", appId: "a", accessible: true, truncated: true, nodes: [] };
    expect(Schema.decodeUnknownSync(ComputerInspectResult)(value)).toEqual(value);
  });
  it("decodes screenshot mask scope and reasons", () => {
    const value = {
      displayId: "d",
      geometryGeneration: "g",
      modelSize: { width: 100, height: 100 },
      mimeType: "image/jpeg",
      data: "",
      hiddenContent: true,
      passwordMasking: "fast",
      masked: "web-area",
      maskReasons: ["partial-audit", "window-match", "audit-incomplete", "windows-changed"],
      secureAudit: {
        searchEnabled: true,
        elapsedMs: 1000,
        windows: [
          {
            windowIndex: 0,
            complete: false,
            elapsedMs: 1000,
            visitedNodes: 98,
            nodeReadElapsedMs: 990,
            maxChildren: 50050,
            textFieldQueries: 1,
            frameQueries: 0,
            searchResults: 0,
            searchElapsedMs: 5,
            searchFallbacks: 1,
            invalidSearchResults: 0,
            stopReasons: ["deadline"],
            axFailures: [{ operation: "text-fields", error: -25205, count: 1 }],
          },
        ],
      },
    };
    expect(Schema.decodeUnknownSync(ComputerScreenshot)(value)).toEqual(value);
    const { secureAudit: _, passwordMasking: _mode, ...legacy } = value;
    expect(Schema.decodeUnknownSync(ComputerScreenshot)(legacy)).toEqual(legacy);
    expect(
      Schema.decodeUnknownSync(ComputerScreenshot)({
        ...value,
        passwordMasking: "conservative",
      }).passwordMasking,
    ).toBe("conservative");
    expect(() =>
      Schema.decodeUnknownSync(ComputerScreenshot)({
        ...value,
        passwordMasking: "off",
      }),
    ).toThrow();
    expect(() =>
      Schema.decodeUnknownSync(ComputerScreenshot)({
        ...value,
        secureAudit: { ...value.secureAudit, elapsedMs: -1 },
      }),
    ).toThrow();
  });
  it("accepts stale refs from legacy helpers and detailed macOS reasons", () => {
    for (const reason of [
      undefined,
      "snapshot-expired",
      "window-changed",
      "element-gone",
      "role-changed",
    ]) {
      const value = { _tag: "StaleElement", ...(reason ? { reason } : {}) };
      expect(Schema.decodeUnknownSync(ComputerAutomationError)(value)).toEqual(value);
    }
    expect(() =>
      Schema.decodeUnknownSync(ComputerAutomationError)({
        _tag: "StaleElement",
        reason: "unexpected",
      }),
    ).toThrow();
  });
});
