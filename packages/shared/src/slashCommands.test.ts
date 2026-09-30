import { describe, expect, it } from "vitest";

import {
  isReservedHostLocalSlashCommandName,
  normalizeHostCompatibleRuntimeSlashCommandName,
} from "./slashCommands";

describe("normalizeHostCompatibleRuntimeSlashCommandName", () => {
  it("keeps canonical runtime slash command names", () => {
    expect(normalizeHostCompatibleRuntimeSlashCommandName("review")).toBe("review");
    expect(normalizeHostCompatibleRuntimeSlashCommandName("/review-diff")).toBe("review-diff");
  });

  it("rejects names that cannot round-trip through the host slash UI", () => {
    expect(normalizeHostCompatibleRuntimeSlashCommandName("review diff")).toBeUndefined();
    expect(normalizeHostCompatibleRuntimeSlashCommandName("$review")).toBeUndefined();
    expect(normalizeHostCompatibleRuntimeSlashCommandName("Plan")).toBeUndefined();
  });
});

describe("isReservedHostLocalSlashCommandName", () => {
  it("matches reserved names case-insensitively", () => {
    expect(isReservedHostLocalSlashCommandName("plan")).toBe(true);
    expect(isReservedHostLocalSlashCommandName("Plan")).toBe(true);
    expect(isReservedHostLocalSlashCommandName("review")).toBe(false);
  });
});

it("accepts qualified skills without accepting empty namespace components", () => {
  expect(normalizeHostCompatibleRuntimeSlashCommandName("acme:review")).toBe("acme:review");
  expect(normalizeHostCompatibleRuntimeSlashCommandName("acme:plan")).toBe("acme:plan");
  for (const name of [":review", "acme:", "acme::review"])
    expect(normalizeHostCompatibleRuntimeSlashCommandName(name)).toBeUndefined();
});
