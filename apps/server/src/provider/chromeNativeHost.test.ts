import { describe, expect, it, vi } from "vitest";
import {
  ChromeNativeHostTransactions,
  chromeLaunchDecision,
  parseChromeRegistryQuery,
  parseNativeHostManifest,
  type ChromeNativeHostDescriptor,
  type ChromeNativeHostTransaction,
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
  it("keeps restoration evidence for a partially failed launch and leaves shadowed registrations alone", async () => {
    let current = [
      parseNativeHostManifest("chrome", "user", manifest("old")),
      { ...parseNativeHostManifest("chrome", "system", manifest("shadowed")), shadowed: true },
      parseNativeHostManifest("edge", "edge", manifest("old-edge")),
    ];
    let saved: ChromeNativeHostTransaction | undefined;
    const restore = vi.fn(async () => {});
    const transactions = new ChromeNativeHostTransactions({
      inspect: async () => current,
      saveTransaction: async (value) => {
        saved = value;
      },
      restoreRegistration: restore,
    });
    const approved = await transactions.approve({
      provider: "claude",
      profileId: "p",
      targetPath: "new",
      observed: current,
    });
    current[0] = parseNativeHostManifest("chrome", "user", manifest("new"));
    // Edge still points to the old host: launch failed part-way through setup.
    await expect(transactions.recordLaunch(approved)).rejects.toThrow("approved target");
    expect(saved?.state).toBe("launched");
    expect(saved?.registrations[0]?.postLaunchHash).toBe(current[0]!.sha256);
    expect(saved?.registrations[1]?.postLaunchHash).toBeUndefined();
    expect(saved?.registrations[2]?.postLaunchHash).toBeUndefined();
    await transactions.restore(saved!, async () => {});
    expect(restore).toHaveBeenCalledOnce();
    expect(restore).toHaveBeenCalledWith("user", manifest("old"));
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
