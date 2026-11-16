import { afterEach, expect, it } from "vitest";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  initializeUpdatePreferences,
  defaultUpdateChannel,
  readUpdatePreferences,
  writeUpdatePreferences,
  electronUpdaterChannelSettings,
} from "./updateChannel";
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
it("defaults only beta versions to beta", () => {
  expect(defaultUpdateChannel("0.1.0-beta.1")).toBe("beta");
  expect(defaultUpdateChannel("0.1.0-preview.1")).toBe("stable");
  expect(electronUpdaterChannelSettings("stable")).toEqual({
    channel: "latest",
    allowPrerelease: false,
  });
});
it("reads invalid prefs as null and writes atomically", () => {
  const root = fs.mkdtempSync(join(tmpdir(), "f5-prefs-"));
  roots.push(root);
  const path = join(root, "prefs");
  expect(readUpdatePreferences(path)).toBeNull();
  fs.writeFileSync(path, '{"channel":"wrong"}');
  expect(readUpdatePreferences(path)).toBeNull();
  writeUpdatePreferences(path, "beta");
  expect(readUpdatePreferences(path)).toBe("beta");
  fs.rmSync(path);
  fs.mkdirSync(path);
  expect(() => writeUpdatePreferences(path, "stable")).toThrow();
  expect(fs.readdirSync(root)).toEqual(["prefs"]);
});

it("persists beta on first launch and retains it after installing stable", () => {
  const root = fs.mkdtempSync(join(tmpdir(), "f5-channel-"));
  roots.push(root);
  const path = join(root, "prefs");
  expect(initializeUpdatePreferences(path, "0.1.0-beta.1")).toBe("beta");
  expect(readUpdatePreferences(path)).toBe("beta");
  expect(initializeUpdatePreferences(path, "0.1.0")).toBe("beta");
});
it("continues with a default channel if initial persistence fails", () => {
  const root = fs.mkdtempSync(join(tmpdir(), "f5-unwritable-prefs-"));
  roots.push(root);
  const path = join(root, "missing-parent", "prefs");
  expect(initializeUpdatePreferences(path, "0.1.0-beta.1")).toBe("beta");
  expect(fs.existsSync(path)).toBe(false);
});
