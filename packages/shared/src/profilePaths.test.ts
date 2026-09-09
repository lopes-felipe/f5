import { describe, it, expect } from "vitest";
import * as Path from "node:path";
import { profileStateDir, profilesRootDir } from "./profilePaths";
describe("profilePaths", () => {
  it("keeps profile state beside production, dev, and explicit state roots", () => {
    for (const state of ["/tmp/.f5/userdata", "/tmp/.f5/dev", "/tmp/custom"]) {
      const profile = { id: "a".repeat(32), isDefault: false };
      expect(profileStateDir(state, profile)).toBe(Path.join(profilesRootDir(state), profile.id));
      expect(profileStateDir(state, { ...profile, isDefault: true })).toBe(Path.resolve(state));
    }
  });
  it("rejects traversal and noncanonical identities", () => {
    for (const id of ["..", "../work", "a/b", "a\\b", "/tmp/x", "A".repeat(32), ""])
      expect(() => profileStateDir("/tmp/state", { id, isDefault: false })).toThrow();
  });
});
