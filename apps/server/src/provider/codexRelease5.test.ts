import { describe, expect, it } from "vitest";
import { CodexControlClient } from "../codex/CodexControlClient";
import { supportsCodexRelease5 } from "@t3tools/shared/providerRuntimeCapabilities";
import { detectCodexUsageLimit, formatCodexUsageError } from "./codexErrors";
import {
  parseCodexAccountWorkspaces,
  parseCodexHooks,
  parseCodexInventoryAccount,
} from "./codexInventory";

describe("Codex Release 5", () => {
  it("requests workspace membership metadata when listing account sessions", async () => {
    const calls: unknown[] = [];
    const client = {
      sendRequest: async (...args: unknown[]) => {
        calls.push(args);
        return {};
      },
    } as unknown as CodexControlClient;
    await CodexControlClient.prototype.listAccountSessions.call(client);
    expect(calls).toEqual([["accountSession/list", { refreshWorkspaceMetadata: true }]]);
  });
  it("decodes Vertex AI, workspace names and future account types", () => {
    expect(
      parseCodexInventoryAccount({
        account: { type: "gcp", workspaceName: "Workspace", email: "user@example.test" },
      }),
    ).toEqual({ type: "gcp", workspaceName: "Workspace", email: "user@example.test" });
    expect(parseCodexInventoryAccount({ account: { type: "future" } })).toEqual({
      type: "unknown",
    });
    expect(parseCodexInventoryAccount({ account: null })).toBeUndefined();
  });
  it.each([undefined, null, "0.162.0", "0.165.0"])(
    "gates older or unknown versions: %s",
    (version) => {
      expect(supportsCodexRelease5(version)).toBe(false);
    },
  );
  it.each(["0.166.0", "codex-cli 0.166.0", "0.167.0"])("accepts %s", (version) => {
    expect(supportsCodexRelease5(version)).toBe(true);
  });
  it("recognizes the protocol's string usage-limit code without message matching", () => {
    expect(
      detectCodexUsageLimit({
        message: "Unavailable",
        errorInfo: "usageLimitExceeded",
        at: "2026-11-03T00:00:00Z",
      }),
    ).toMatchObject({ evidence: "typed" });
  });
  it.each([
    ["modelNotFound", "Choose another model"],
    ["policyCapacityUnavailable", "Retry shortly"],
    ["flexUnavailable", "Retry shortly"],
    ["tooManyDenials", "denial limit"],
  ])("explains %s", (code, expected) => {
    expect(formatCodexUsageError("Unavailable", undefined, "2026-11-03T00:00:00Z", code)).toContain(
      expected,
    );
  });
  it("lists workspaces without exposing account identities", () => {
    expect(
      parseCodexAccountWorkspaces({
        sessions: [
          {
            isActive: true,
            selectedWorkspaceAccountId: "selected",
            email: "private@example.test",
            workspaces: [
              { accountId: "selected", name: "Engineering", kind: "workspace" },
              { accountId: "personal", name: "Personal", kind: "personal" },
            ],
          },
        ],
      }),
    ).toEqual([
      { name: "Engineering", kind: "workspace", active: true },
      { name: "Personal", kind: "personal", active: false },
    ]);
    expect(parseCodexAccountWorkspaces({ sessions: [null, {}, { workspaces: [null] }] })).toEqual(
      [],
    );
  });
  it("keeps unfamiliar hook events and marks environment hooks as managed", () => {
    expect(
      parseCodexHooks([
        { hooks: [{ eventName: "futureEvent", environmentId: "environment", source: "project" }] },
      ]),
    ).toEqual([{ event: "futureEvent", environmentId: "environment", source: "managed" }]);
  });
});
