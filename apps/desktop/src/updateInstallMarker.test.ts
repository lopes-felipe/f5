import { afterEach, expect, it } from "vitest";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { consumeUpdateInstallMarker, writeUpdateInstallMarker } from "./updateInstallMarker";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
function markerPath() {
  const root = fs.mkdtempSync(join(tmpdir(), "f5-update-marker-"));
  roots.push(root);
  return join(root, "update-pending.json");
}

it("returns the recent install once when the new version is running", () => {
  const path = markerPath();
  writeUpdateInstallMarker(path, {
    fromVersion: "0.1.1",
    toVersion: "0.1.2",
    releaseNotes: "Faster preview",
  });
  expect(fs.readdirSync(join(path, ".."))).toEqual(["update-pending.json"]);
  expect(consumeUpdateInstallMarker(path, "0.1.2")).toEqual({
    fromVersion: "0.1.1",
    toVersion: "0.1.2",
    releaseNotes: "Faster preview",
  });
  expect(fs.existsSync(path)).toBe(false);
  expect(consumeUpdateInstallMarker(path, "0.1.2")).toBeNull();
});

it("drops the marker when the install did not take effect", () => {
  const path = markerPath();
  writeUpdateInstallMarker(path, { fromVersion: "0.1.1", toVersion: "0.1.2", releaseNotes: null });
  expect(consumeUpdateInstallMarker(path, "0.1.1")).toBeNull();
  expect(fs.existsSync(path)).toBe(false);
});

it("treats missing or corrupt markers as no recent install", () => {
  const path = markerPath();
  expect(consumeUpdateInstallMarker(path, "0.1.2")).toBeNull();
  fs.writeFileSync(path, "{not json");
  expect(consumeUpdateInstallMarker(path, "0.1.2")).toBeNull();
  expect(fs.existsSync(path)).toBe(false);
  fs.writeFileSync(path, JSON.stringify({ toVersion: "0.1.2" }));
  expect(consumeUpdateInstallMarker(path, "0.1.2")).toBeNull();
});
