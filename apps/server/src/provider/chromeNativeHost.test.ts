import { describe, expect, it, vi } from "vitest";
import {
  ChromeNativeHostTransactions,
  chromeLaunchDecision,
  parseChromeRegistryQuery,
  parseNativeHostManifest,
  type ChromeNativeHostDescriptor,
} from "./chromeNativeHost";
const manifest = (path: string) =>
  JSON.stringify({
    name: "recorded-host",
    type: "stdio",
    allowed_origins: ["chrome-extension://test"],
    path,
  });
const descriptor: ChromeNativeHostDescriptor = {
  provider: "claude",
  certified: true,
  hostNames: ["recorded-host"],
  browsers: ["chrome"],
  expectedTarget: (home) => `${home}/recorded-target`,
};
describe("Chrome native-host transactions", () => {
  it("launches only certified known targets and asks about foreign setup", () => {
    const registrations = [parseNativeHostManifest("chrome", "user", manifest("foreign"))];
    expect(
      chromeLaunchDecision({
        enabled: true,
        descriptor,
        providerHome: "profile",
        registrations,
        managedTargets: new Set(),
      }),
    ).toMatchObject({ kind: "needs-consent", previousTargets: ["foreign"] });
    expect(
      chromeLaunchDecision({
        enabled: true,
        descriptor: { ...descriptor, certified: false },
        providerHome: "profile",
        registrations,
        managedTargets: new Set(),
      }),
    ).toEqual({ kind: "off" });
    expect(
      chromeLaunchDecision({
        enabled: true,
        descriptor,
        providerHome: "profile",
        registrations: [{ browser: "chrome", location: "user", state: "unreadable" }],
        managedTargets: new Set(),
      }),
    ).toMatchObject({ kind: "unknown" });
  });
  it("restores original bytes only when the post-launch hash still matches", async () => {
    const original = manifest("foreign");
    let current = [
      parseNativeHostManifest("chrome", "user", original),
      parseNativeHostManifest("edge", "edge", null),
    ];
    const saved: unknown[] = [];
    const restore = vi.fn(async () => {});
    const transactions = new ChromeNativeHostTransactions({
      inspect: async () => current,
      saveTransaction: async (value) => {
        saved.push(value);
      },
      restoreRegistration: restore,
    });
    const approved = await transactions.approve({
      provider: "claude",
      profileId: "p",
      targetPath: "profile/recorded-target",
      observed: current,
    });
    current = current.map((entry) =>
      parseNativeHostManifest(entry.browser, entry.location, manifest(approved.targetPath)),
    );
    const launched = await transactions.recordLaunch(approved);
    current[1] = parseNativeHostManifest("edge", "edge", manifest("changed-externally"));
    const stop = vi.fn(async () => {});
    const result = await transactions.restore(launched, stop);
    expect(stop).toHaveBeenCalledOnce();
    expect(restore).toHaveBeenCalledWith("user", original);
    expect(result.skipped).toEqual(["edge"]);
    expect(saved).toHaveLength(3);
  });
  it("parses default registry values including paths with spaces", () => {
    expect(
      parseChromeRegistryQuery(
        "HKEY_CURRENT_USER\\Key\r\n    (Default)    REG_SZ    C:\\Path With Spaces\\manifest.json\r\n",
      ),
    ).toBe("C:\\Path With Spaces\\manifest.json");
    expect(parseNativeHostManifest("chrome", "host", "not-json").state).toBe("malformed");
  });
});
