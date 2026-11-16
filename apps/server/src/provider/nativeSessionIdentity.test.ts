import { describe, expect, it } from "vitest";

import { isSameNativeSession, nativeSessionIdentity } from "./nativeSessionIdentity.ts";

const CLAUDE_SESSION = "0b6a3c1e-5d2f-4a7b-9c8d-1e2f3a4b5c6d";

describe("nativeSessionIdentity", () => {
  it("reads each provider's own cursor field", () => {
    expect(nativeSessionIdentity("claudeAgent", { resume: CLAUDE_SESSION, threadId: "f5" })).toBe(
      CLAUDE_SESSION,
    );
    expect(nativeSessionIdentity("codex", { threadId: "codex-thread" })).toBe("codex-thread");
    expect(nativeSessionIdentity("opencode", { schemaVersion: 1, sessionId: "ses_1" })).toBe(
      "ses_1",
    );
    expect(nativeSessionIdentity("muse", { mspSessionId: "msp-1" })).toBe("msp-1");
    expect(nativeSessionIdentity("pi", { sessionFile: "/tmp/pi.jsonl" })).toBe("/tmp/pi.jsonl");
    for (const provider of ["cursor", "grok", "antigravity", "acp"] as const)
      expect(nativeSessionIdentity(provider, { sessionId: "acp-1" })).toBe("acp-1");
  });

  it("never treats Claude's F5 thread id as the native session", () => {
    expect(nativeSessionIdentity("claudeAgent", { threadId: "thread-1" })).toBeUndefined();
    expect(nativeSessionIdentity("claudeAgent", null)).toBeUndefined();
  });
});

describe("isSameNativeSession", () => {
  it("requires two defined, equal identities", () => {
    expect(isSameNativeSession("codex", { threadId: "a" }, { threadId: "a" })).toBe(true);
    expect(isSameNativeSession("codex", { threadId: "a" }, { threadId: "b" })).toBe(false);
    expect(isSameNativeSession("codex", {}, {})).toBe(false);
  });

  it("treats a Claude session resumed at a different boundary as different", () => {
    const at = (boundary: string) => ({ resume: CLAUDE_SESSION, resumeSessionAt: boundary });
    expect(isSameNativeSession("claudeAgent", at("b2"), at("b2"))).toBe(true);
    expect(isSameNativeSession("claudeAgent", at("b2"), at("b1"))).toBe(false);
    expect(isSameNativeSession("claudeAgent", at("b2"), { resume: CLAUDE_SESSION })).toBe(true);
  });

  it("accepts a verified OpenCode fork", () => {
    expect(
      isSameNativeSession(
        "opencode",
        { schemaVersion: 1, sessionId: "ses_1" },
        { schemaVersion: 1, sessionId: "ses_2", forkedFromSessionId: "ses_1" },
      ),
    ).toBe(true);
  });
});
