import { expect, it, vi } from "vitest";
import { join } from "node:path";
import {
  probeWindowsFixture,
  windowsFixtureMetadata,
  WINDOWS_FIXTURE_BINARY,
} from "./windowsFixtures";

const metadata = {
  protocolVersion: 1,
  fixtureVersion: "1.0.0",
  platform: "win32",
  kind: "synthetic-native-window",
  windowCreated: false,
  nativeInputAvailable: false,
};
it("runs only the bounded, hidden, metadata-only fixture branch", async () => {
  const execute = vi
    .fn<NonNullable<Parameters<typeof probeWindowsFixture>[1]>>()
    .mockResolvedValue({ stdout: JSON.stringify(metadata) });
  expect(await probeWindowsFixture("/prepared", execute)).toBe(true);
  expect(execute).toHaveBeenCalledWith(
    join("/prepared", WINDOWS_FIXTURE_BINARY),
    ["--check"],
    expect.objectContaining({
      timeout: 5000,
      maxBuffer: 4096,
      windowsHide: true,
    }),
  );
});
it.each([
  null,
  { ...metadata, protocolVersion: 2 },
  { ...metadata, fixtureVersion: "0.0.0" },
  { ...metadata, platform: "unsupported" },
  { ...metadata, windowCreated: true },
  { ...metadata, nativeInputAvailable: true },
  { ...metadata, windowCreated: "false" },
])("refuses unsupported or side-effecting fixture metadata", (value) => {
  expect(windowsFixtureMetadata(value)).toBe(false);
});
it("does not expose malformed protocol or process errors", async () => {
  const execute = vi
    .fn<NonNullable<Parameters<typeof probeWindowsFixture>[1]>>()
    .mockResolvedValue({ stdout: "PRIVATE_SENTINEL" });
  expect(await probeWindowsFixture("/prepared", execute)).toBe(false);
  execute.mockRejectedValue(new Error("PRIVATE_SENTINEL"));
  expect(await probeWindowsFixture("/prepared", execute)).toBe(false);
});
