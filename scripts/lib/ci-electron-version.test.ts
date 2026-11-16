import { expect, it } from "vitest";
import { electronVersion } from "./ci-electron-version.ts";

it("accepts exact Electron pins in runtime or development dependencies", () => {
  for (const field of ["dependencies", "devDependencies"])
    expect(electronVersion({ [field]: { electron: "44.9.3" } })).toBe("44.9.3");
});
it.each([
  null,
  {},
  { dependencies: {} },
  { dependencies: { electron: "^44.9.3" } },
  { devDependencies: { electron: "latest" } },
  { dependencies: { electron: 44 } },
])("rejects missing or unpinned Electron versions: %j", (manifest) => {
  expect(() => electronVersion(manifest)).toThrow("exact x.y.z");
});
