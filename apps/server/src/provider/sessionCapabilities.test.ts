import { ProviderInstanceId } from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import {
  buildProviderSessionCapabilities,
  checkSessionAction,
  readPersistedSessionGeneration,
  sessionActionSupport,
  sessionGenerationPayload,
} from "./sessionCapabilities.ts";

const base = {
  generation: 3,
  driver: "claudeAgent",
  providerInstanceId: ProviderInstanceId.makeUnsafe("claude-work"),
  executableVersion: " 2.1.0 ",
  adapterCapabilities: { sessionModelSwitch: "in-session" as const },
  hasSteer: true,
  hasMcpReload: false,
  active: true,
  checkedAt: "2026-10-08T00:00:00.000Z",
};

describe("buildProviderSessionCapabilities", () => {
  it("records generation, instance, version and discovery", () => {
    const capabilities = buildProviderSessionCapabilities({
      ...base,
      discovery: { outcome: "discovered", nativeCommands: true },
    });
    expect(capabilities).toMatchObject({
      generation: 3,
      providerInstanceId: "claude-work",
      executableVersion: "2.1.0",
      discovery: "discovered",
    });
    expect(sessionActionSupport(capabilities, "steer")).toEqual({
      action: "steer",
      supported: true,
    });
    expect(sessionActionSupport(capabilities, "nativeCommands")?.supported).toBe(true);
    expect(sessionActionSupport(capabilities, "nativeSessionCleanup")?.supported).toBe(true);
    expect(sessionActionSupport(capabilities, "mcpReload")?.unavailableReason?.code).toBe(
      "unsupported",
    );
  });

  it("explains why actions are unavailable", () => {
    const pending = buildProviderSessionCapabilities({
      ...base,
      discovery: { outcome: "pending" },
    });
    expect(sessionActionSupport(pending, "nativeCommands")?.unavailableReason?.code).toBe(
      "discovery-pending",
    );
    const stopped = buildProviderSessionCapabilities({ ...base, active: false });
    expect(sessionActionSupport(stopped, "steer")?.unavailableReason?.code).toBe("no-session");
    // Rollback recovers a stopped session first.
    expect(sessionActionSupport(stopped, "rollback")?.supported).toBe(true);
    const cursor = buildProviderSessionCapabilities({ ...base, driver: "cursor" });
    expect(sessionActionSupport(cursor, "rollback")?.unavailableReason?.code).toBe("unsupported");
    expect(cursor.discovery).toBe("static");
  });
});

describe("checkSessionAction", () => {
  const capabilities = buildProviderSessionCapabilities({ ...base, discovery: undefined });

  it("refuses a stale browser that saw an older generation", () => {
    expect(checkSessionAction({ capabilities, action: "steer", expectedGeneration: 2 })?.code).toBe(
      "stale-generation",
    );
    expect(
      checkSessionAction({ capabilities, action: "steer", expectedGeneration: 3 }),
    ).toBeUndefined();
  });

  it("returns the action's structured reason when unsupported", () => {
    expect(checkSessionAction({ capabilities, action: "mcpReload" })?.code).toBe("unsupported");
  });
});

describe("persisted session generation", () => {
  it("round-trips and defaults to 0 for pre-Release 2 bindings", () => {
    expect(readPersistedSessionGeneration(sessionGenerationPayload(7))).toBe(7);
    expect(readPersistedSessionGeneration({})).toBe(0);
    expect(readPersistedSessionGeneration({ sessionGeneration: -1 })).toBe(0);
    expect(readPersistedSessionGeneration(null)).toBe(0);
  });
});
