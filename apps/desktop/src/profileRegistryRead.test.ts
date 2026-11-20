import * as FS from "node:fs";
import * as OS from "node:os";
import * as Path from "node:path";
import { fallbackDefaultProfile } from "@t3tools/shared/profileIdentity";
import { profileRegistryPath } from "@t3tools/shared/profilePaths";
import { afterEach, describe, expect, it } from "vitest";
import { desktopDefaultProfile, readDesktopProfiles } from "./profileRegistryRead";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) FS.rmSync(root, { recursive: true, force: true });
});

function registry(version: number, extra: ReadonlyArray<Record<string, unknown>> = []) {
  const root = FS.mkdtempSync(Path.join(OS.tmpdir(), "f5-desktop-registry-"));
  roots.push(root);
  const stateDir = Path.join(root, "userdata");
  const path = profileRegistryPath(stateDir);
  FS.mkdirSync(Path.dirname(path), { recursive: true });
  const defaultProfile = fallbackDefaultProfile(stateDir);
  FS.writeFileSync(
    path,
    JSON.stringify({ version, retiredPorts: [], profiles: [defaultProfile, ...extra] }),
  );
  return { stateDir, defaultProfile };
}

const guest = {
  id: "d".repeat(32),
  slug: "guest",
  name: "Guest",
  port: 4790,
  isDefault: false,
  status: "ready",
  createdAt: "2026-11-20T00:00:00.000Z",
  executionEnvironment: "linux-vm",
};

describe("desktop profile registry reader", () => {
  it("reads version 1 and version 2 registries, keeping each record's environment", () => {
    const v1 = registry(1);
    expect(readDesktopProfiles(v1.stateDir)).toEqual([v1.defaultProfile]);
    const v2 = registry(2, [guest]);
    expect(readDesktopProfiles(v2.stateDir)[1]).toMatchObject({
      id: guest.id,
      executionEnvironment: "linux-vm",
    });
    // A version 2 file without VM profiles is still readable.
    expect(readDesktopProfiles(registry(2).stateDir)).toHaveLength(1);
  });

  it("rejects a VM record in a version 1 registry, a VM Default and newer versions", () => {
    expect(() => readDesktopProfiles(registry(1, [guest]).stateDir)).toThrow(
      "A version 1 registry cannot contain Linux VM profiles.",
    );
    const vmDefault = registry(2);
    const path = profileRegistryPath(vmDefault.stateDir);
    const file = JSON.parse(FS.readFileSync(path, "utf8"));
    file.profiles[0].executionEnvironment = "linux-vm";
    FS.writeFileSync(path, JSON.stringify(file));
    expect(() => readDesktopProfiles(vmDefault.stateDir)).toThrow("Default must run on the host.");
    const newer = registry(3);
    expect(() => readDesktopProfiles(newer.stateDir)).toThrow(
      "Unsupported profiles registry version.",
    );
    // Default selection falls back to literal Default rather than trusting a bad file.
    expect(desktopDefaultProfile(newer.stateDir)).toEqual(newer.defaultProfile);
  });
});
