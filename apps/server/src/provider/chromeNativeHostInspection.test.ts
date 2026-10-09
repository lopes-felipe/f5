import { describe, expect, it } from "vitest";
import {
  inspectChromeNativeHosts,
  type ChromeNativeHostLocation,
} from "./chromeNativeHostInspection";
const manifest = (name = "host") =>
  JSON.stringify({
    name,
    type: "stdio",
    path: "/profile/target",
    allowed_origins: ["chrome-extension://recorded"],
  });
describe("native-host inspection across roots and registry views", () => {
  it("reports shadowed registrations independently for each host name", async () => {
    const locations: ChromeNativeHostLocation[] = [
      { browser: "chrome", hostName: "host", kind: "file", path: "/user/host.json" },
      { browser: "chrome", hostName: "other", kind: "file", path: "/user/other.json" },
      { browser: "chrome", hostName: "host", kind: "file", path: "/system/host.json" },
    ];
    const entries = await inspectChromeNativeHosts(locations, {
      readManifest: async (path) => manifest(path.includes("other") ? "other" : "host"),
      queryRegistry: async () => null,
    });
    expect(entries.map((entry) => entry.shadowed)).toEqual([false, false, true]);
  });
  it("inspects all four registry roots/views and preserves registry drift in hashes", async () => {
    const locations: ChromeNativeHostLocation[] = ["HKCU", "HKLM"].flatMap((root) =>
      ["64", "32"].map((view) => ({
        browser: "chrome",
        hostName: "host",
        kind: "registry" as const,
        key: `${root}\\Software\\Recorded\\host`,
        view: view as "32" | "64",
      })),
    );
    const readManifest = async () => manifest();
    const queryRegistry = async (_key: string, view: string) =>
      `    (Default)    REG_SZ    C:\\${view}\\host.json`;
    const entries = await inspectChromeNativeHosts(locations, { readManifest, queryRegistry });
    expect(entries).toHaveLength(4);
    expect(entries.map((entry) => entry.shadowed)).toEqual([false, true, true, true]);
    expect(entries[0]!.sha256).not.toBe(entries[1]!.sha256);
    expect(entries[0]!.bytes).toContain("manifestBytes");
  });
  it("fails closed for unreadable roots, dangling registry paths and mismatched host names", async () => {
    const file: ChromeNativeHostLocation = {
      browser: "chrome",
      hostName: "host",
      kind: "file",
      path: "/host.json",
    };
    const io = {
      readManifest: async (): Promise<string | null> => {
        throw new Error("Denied");
      },
      queryRegistry: async () => "    (Default)    REG_SZ    C:\\gone.json",
    };
    expect((await inspectChromeNativeHosts([file], io))[0]?.state).toBe("unreadable");
    expect(
      (
        await inspectChromeNativeHosts(
          [{ ...file, kind: "registry", key: "HKCU\\host", view: "64" }],
          { ...io, readManifest: async () => null },
        )
      )[0]?.state,
    ).toBe("malformed");
    expect(
      (
        await inspectChromeNativeHosts([file], {
          ...io,
          readManifest: async () => manifest("wrong"),
        })
      )[0]?.state,
    ).toBe("malformed");
  });
});
