import { ProviderInstanceId } from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import {
  buildProviderSessionCapabilities,
  checkSessionAction,
  mergeSessionCapabilities,
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
  it("allows compaction on older certified Codex sessions without advertising review", () => {
    const capabilities = buildProviderSessionCapabilities({
      ...base,
      driver: "codex",
      executableVersion: "0.159.2",
    });
    expect(sessionActionSupport(capabilities, "nativeCompaction")?.supported).toBe(true);
    expect(sessionActionSupport(capabilities, "nativeReview")?.supported).toBe(false);
  });
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

describe("mergeSessionCapabilities", () => {
  const snapshot = (generation: number, checkedAt: string, discovery: "pending" | "discovered") =>
    buildProviderSessionCapabilities({
      ...base,
      generation,
      checkedAt,
      discovery: { outcome: discovery },
    });
  const discovered = snapshot(3, "2026-10-08T00:00:02.000Z", "discovered");

  it("keeps the current snapshot when the update omits it and clears on null", () => {
    expect(mergeSessionCapabilities(discovered, undefined)).toBe(discovered);
    expect(mergeSessionCapabilities(discovered, null)).toBeNull();
  });

  it("never lets an earlier snapshot of the same or an older generation win", () => {
    const lateStart = snapshot(3, "2026-10-08T00:00:01.000Z", "pending");
    expect(mergeSessionCapabilities(discovered, lateStart)).toBe(discovered);
    expect(
      mergeSessionCapabilities(discovered, snapshot(2, "2026-10-08T00:00:09.000Z", "pending")),
    ).toBe(discovered);
    const restarted = snapshot(4, "2026-10-08T00:00:00.000Z", "pending");
    expect(mergeSessionCapabilities(discovered, restarted)).toBe(restarted);
  });
});
