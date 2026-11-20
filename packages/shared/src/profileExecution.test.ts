import { describe, expect, it } from "vitest";
import {
  hostExecutionRefusal,
  profileExecutionEnvironment,
  profileRegistryVersionFor,
  profileRegistryVersionViolation,
} from "./profileExecution";

const host = { isDefault: false };
const vm = { isDefault: false, executionEnvironment: "linux-vm" as const };

describe("profile execution environments", () => {
  it("treats a missing environment as host", () => {
    expect(profileExecutionEnvironment({})).toBe("host");
    expect(profileExecutionEnvironment(vm)).toBe("linux-vm");
    expect(hostExecutionRefusal({ slug: "work" })).toBeUndefined();
    expect(hostExecutionRefusal({ slug: "guest", ...vm })).toMatch(/'guest' runs in a Linux VM/);
  });

  it("writes version 2 only while a VM profile exists", () => {
    expect(profileRegistryVersionFor([host])).toBe(1);
    expect(profileRegistryVersionFor([host, vm])).toBe(2);
  });

  it("enforces the version invariants", () => {
    expect(profileRegistryVersionViolation({ version: 1, profiles: [host] })).toBeUndefined();
    expect(profileRegistryVersionViolation({ version: 2, profiles: [host] })).toBeUndefined();
    expect(profileRegistryVersionViolation({ version: 2, profiles: [host, vm] })).toBeUndefined();
    expect(profileRegistryVersionViolation({ version: 1, profiles: [vm] })).toMatch(/version 1/);
    expect(
      profileRegistryVersionViolation({ version: 2, profiles: [{ ...vm, isDefault: true }] }),
    ).toMatch(/Default/);
    expect(profileRegistryVersionViolation({ version: 3, profiles: [] })).toMatch(/Unsupported/);
  });
});
