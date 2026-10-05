import { access, readdir, readFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import type { DesktopBrowserImportSource } from "@t3tools/contracts";
export interface SourceProfile {
  id: string;
  name: string;
  database: string;
  root: string;
  engine: "chromium" | "firefox" | "safari";
  service?: string;
  account?: string;
  application?: string;
}
export interface Source {
  id: string;
  name: string;
  profiles: SourceProfile[];
}
export async function discoverSources(
  platform: NodeJS.Platform = process.platform,
  home = os.homedir(),
): Promise<Source[]> {
  const definitions = [
    {
      id: "chrome",
      name: "Chrome",
      engine: "chromium" as const,
      mac: "Google/Chrome",
      linux: "google-chrome",
      win: "Google/Chrome/User Data",
      service: "Chrome Safe Storage",
      account: "Chrome",
      application: "chrome",
    },
    {
      id: "edge",
      name: "Microsoft Edge",
      engine: "chromium" as const,
      mac: "Microsoft Edge",
      linux: "microsoft-edge",
      win: "Microsoft/Edge/User Data",
      service: "Microsoft Edge Safe Storage",
      account: "Microsoft Edge",
      application: "microsoft-edge",
    },
    {
      id: "brave",
      name: "Brave",
      engine: "chromium" as const,
      mac: "BraveSoftware/Brave-Browser",
      linux: "BraveSoftware/Brave-Browser",
      win: "BraveSoftware/Brave-Browser/User Data",
      service: "Brave Safe Storage",
      account: "Brave",
      application: "brave",
    },
  ];
  definitions.push(
    {
      id: "vivaldi",
      name: "Vivaldi",
      engine: "chromium",
      mac: "Vivaldi",
      linux: "vivaldi",
      win: "Vivaldi/User Data",
      service: "Vivaldi Safe Storage",
      account: "Vivaldi",
      application: "vivaldi",
    },
    {
      id: "opera",
      name: "Opera",
      engine: "chromium",
      mac: "com.operasoftware.Opera",
      linux: "opera",
      win: "Opera Software/Opera Stable",
      service: "Opera Safe Storage",
      account: "Opera",
      application: "opera",
    },
    {
      id: "arc",
      name: "Arc",
      engine: "chromium",
      mac: "Arc/User Data",
      linux: "",
      win: "Packages/TheBrowserCompany.Arc_ttt1ap7aakyb4/LocalCache/Local/Arc/User Data",
      service: "Arc Safe Storage",
      account: "Arc",
      application: "arc",
    },
    {
      id: "chromium",
      name: "Chromium",
      engine: "chromium",
      mac: "Chromium",
      linux: "chromium",
      win: "Chromium/User Data",
      service: "Chromium Safe Storage",
      account: "Chromium",
      application: "chromium",
    },
  );
  const result: Source[] = [];
  for (const d of definitions) {
    if (platform === "linux" && !d.linux) continue;
    const root =
      platform === "darwin"
        ? path.join(home, "Library/Application Support", d.mac)
        : platform === "linux"
          ? path.join(home, ".config", d.linux)
          : path.join(
              (d.id === "opera" ? process.env.APPDATA : process.env.LOCALAPPDATA) ??
                path.join(home, d.id === "opera" ? "AppData/Roaming" : "AppData/Local"),
              d.win,
            );
    const profiles: SourceProfile[] = [];
    for (const entry of await readdir(root, { withFileTypes: true }).catch(() => [])) {
      if (!entry.isDirectory() || !/^(Default|Profile \d+)$/.test(entry.name)) continue;
      for (const name of ["Network/Cookies", "Cookies"]) {
        const database = path.join(root, entry.name, name);
        if (
          await access(database).then(
            () => true,
            () => false,
          )
        ) {
          profiles.push({
            id: entry.name,
            name: entry.name,
            database,
            root,
            engine: d.engine,
            service: d.service,
            account: d.account,
            application: d.application,
          });
          break;
        }
      }
    }
    if (d.id === "opera") {
      for (const leaf of ["Cookies", "Network/Cookies"]) {
        const database = path.join(root, leaf);
        if (
          await access(database).then(
            () => true,
            () => false,
          )
        ) {
          profiles.push({
            id: "root",
            name: "Default",
            database,
            root,
            engine: d.engine,
            service: d.service,
            account: d.account,
            application: d.application,
          });
          break;
        }
      }
    }
    result.push({ id: d.id, name: d.name, profiles });
  }
  const firefoxRoot =
    platform === "darwin"
      ? path.join(home, "Library/Application Support/Firefox")
      : platform === "linux"
        ? path.join(home, ".mozilla/firefox")
        : path.join(process.env.APPDATA ?? path.join(home, "AppData/Roaming"), "Mozilla/Firefox");
  const profiles: SourceProfile[] = [];
  const ini = await readFile(path.join(firefoxRoot, "profiles.ini"), "utf8").catch(() => "");
  for (const section of ini.split(/\r?\n\[/)) {
    const fields = Object.fromEntries(
      section
        .split(/\r?\n/)
        .filter((line) => line.includes("="))
        .map((line) => {
          const index = line.indexOf("=");
          return [line.slice(0, index), line.slice(index + 1)];
        }),
    );
    if (!fields.Path) continue;
    const directory =
      fields.IsRelative === "0" ? fields.Path : path.resolve(firefoxRoot, fields.Path);
    const database = path.join(directory, "cookies.sqlite");
    if (
      await access(database).then(
        () => true,
        () => false,
      )
    )
      profiles.push({
        id: String(profiles.length),
        name: fields.Name ?? "Firefox",
        database,
        root: firefoxRoot,
        engine: "firefox",
      });
  }
  result.push({ id: "firefox", name: "Firefox", profiles });
  if (platform === "darwin") {
    const database = path.join(
      home,
      "Library/Containers/com.apple.Safari/Data/Library/Cookies/Cookies.binarycookies",
    );
    const fallback = path.join(home, "Library/Cookies/Cookies.binarycookies");
    const jar = await access(database).then(
      () => database,
      () => fallback,
    );
    const safariProfiles: SourceProfile[] = [
      { id: "default", name: "Default", database: jar, root: home, engine: "safari" },
    ];
    const stores = path.join(
      home,
      "Library/Containers/com.apple.Safari/Data/Library/WebKit/WebsiteDataStore",
    );
    for (const entry of await readdir(stores, { withFileTypes: true }).catch(() => [])) {
      if (!entry.isDirectory() || !/^[0-9a-f-]{36}$/i.test(entry.name)) continue;
      const database = path.join(stores, entry.name, "Cookies/Cookies.binarycookies");
      if (
        await access(database).then(
          () => true,
          () => false,
        )
      )
        safariProfiles.push({
          id: entry.name,
          name: entry.name,
          database,
          root: home,
          engine: "safari",
        });
    }
    result.push({
      id: "safari",
      name: "Safari",
      profiles: safariProfiles,
    });
  }
  return result;
}
export function publicSources(sources: Source[]): DesktopBrowserImportSource[] {
  return sources.map((source) => ({
    id: source.id,
    name: source.name,
    profiles: source.profiles.map((p) => ({ id: p.id, name: p.name })),
    available: source.profiles.length > 0,
    remediation:
      source.id === "safari"
        ? "Grant Full Disk Access to F5 in System Settings, then retry."
        : source.id === "firefox"
          ? "Close the source browser before importing."
          : "Close the source browser; allow access to its OS credential store. Windows app-bound encryption is unsupported.",
  }));
}
