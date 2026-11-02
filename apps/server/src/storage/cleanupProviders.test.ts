import { describe, expect, it } from "vitest";
import { cleanupProviders, isUngatedProviderTarget } from "./cleanupProviders.ts";
import { runStorageTask } from "./storageWorker.ts";
import * as FS from "node:fs/promises";
import * as OS from "node:os";
import * as Path from "node:path";

describe("cleanup provider locations and boundaries", () => {
  it.each([
    "f5Backups",
    "f5ApplicationLogs",
    "bunDownloadCache",
    "npmDownloadCache",
    "uvDiscardedCaches",
    "chromeCaches",
    "bambuStudioLogs",
  ] as const)(
    "returns no candidates for a missing %s root through worker IPC",
    async (providerId) => {
      const root = await FS.mkdtemp(Path.join(OS.tmpdir(), "f5-provider-absent-"));
      try {
        expect(
          await runStorageTask({
            kind: "providerCandidates",
            providerId,
            root: Path.join(root, "not-installed"),
          }),
        ).toEqual([]);
      } finally {
        await FS.rm(root, { recursive: true, force: true });
      }
    },
  );
  it.each(["darwin", "linux", "win32"] as const)(
    "keeps machine discovery opt-in on %s",
    (platform) => {
      expect(
        cleanupProviders({ stateDirs: ["/profile"], enabled: false, platform, env: {} }).map(
          (p) => p.id,
        ),
      ).toEqual(["f5Backups", "f5ApplicationLogs", "f5UpdaterCache"]);
    },
  );
  it.each([
    "f5UpdaterCache",
    "claudePluginTrash",
    "devboxWarmupCache",
    "playwrightBrowsers",
    "electronDownloadCache",
    "nodeGypCache",
  ] as const)("returns no candidates for a missing %s root through worker IPC", async (id) => {
    const root = await FS.mkdtemp(Path.join(OS.tmpdir(), "f5-provider-absent-"));
    try {
      expect(
        await runStorageTask({
          kind: "providerCandidates",
          providerId: id,
          root: Path.join(root, "not-installed"),
        }),
      ).toEqual([]);
    } finally {
      await FS.rm(root, { recursive: true, force: true });
    }
  });
  it.each([
    [
      "darwin",
      "/home/person",
      {
        f5UpdaterCache: "/home/person/Library/Caches/f5-desktop-updater",
        playwrightBrowsers: "/home/person/Library/Caches/ms-playwright",
        electronDownloadCache: "/home/person/Library/Caches/electron",
        nodeGypCache: "/home/person/Library/Caches/node-gyp",
        devboxWarmupCache: "/home/person/.devbox/warmupcache",
      },
    ],
    [
      "linux",
      "/home/person",
      {
        f5UpdaterCache: "/home/person/.cache/f5-desktop-updater",
        playwrightBrowsers: "/home/person/.cache/ms-playwright",
        electronDownloadCache: "/home/person/.cache/electron",
        nodeGypCache: "/home/person/.cache/node-gyp",
        devboxWarmupCache: "/home/person/.devbox/warmupcache",
      },
    ],
    [
      "win32",
      "C:\\Users\\person",
      {
        f5UpdaterCache: "C:\\Users\\person\\AppData\\Local\\f5-desktop-updater",
        playwrightBrowsers: "C:\\Users\\person\\AppData\\Local\\ms-playwright",
        electronDownloadCache: "C:\\Users\\person\\AppData\\Local\\electron",
        nodeGypCache: "C:\\Users\\person\\AppData\\Local\\node-gyp",
        devboxWarmupCache: "C:\\Users\\person\\.devbox\\warmupcache",
      },
    ],
  ] as const)("resolves the added cache locations on %s", (platform, home, expected) => {
    const providers = cleanupProviders({ stateDirs: [], enabled: true, platform, home, env: {} });
    for (const [id, root] of Object.entries(expected))
      expect(providers.find((p) => p.id === id)?.roots).toEqual([root]);
    for (const id of Object.keys(expected))
      expect(providers.find((p) => p.id === id)?.section).toBe("machine");
  });
  it("respects Playwright and Electron cache overrides", () => {
    const providers = cleanupProviders({
      stateDirs: [],
      enabled: true,
      platform: "linux",
      home: "/home/person",
      env: { PLAYWRIGHT_BROWSERS_PATH: "/opt/pw", ELECTRON_CACHE: "/opt/electron" },
    });
    expect(providers.find((p) => p.id === "playwrightBrowsers")?.roots).toEqual(["/opt/pw"]);
    expect(providers.find((p) => p.id === "electronDownloadCache")?.roots).toEqual([
      "/opt/electron",
    ]);
    // "0" means browsers live inside node_modules; there is no shared cache to clean.
    expect(
      cleanupProviders({
        stateDirs: [],
        enabled: true,
        platform: "linux",
        home: "/home/person",
        env: { PLAYWRIGHT_BROWSERS_PATH: "0" },
      }).find((p) => p.id === "playwrightBrowsers")?.roots,
    ).toEqual(["/home/person/.cache/ms-playwright"]);
  });
  it("always offers the F5 Claude home's plugin trash and gates the user's", () => {
    const trash = (enabled: boolean, env: NodeJS.ProcessEnv = {}) =>
      cleanupProviders({
        stateDirs: [],
        enabled,
        providerHomesDir: "/profile/provider-homes",
        platform: "linux",
        home: "/home/person",
        env,
      }).find((p) => p.id === "claudePluginTrash");
    expect(trash(false)?.roots).toEqual(["/profile/provider-homes/claude/.claude/plugins/.trash"]);
    expect(trash(true)?.roots).toEqual([
      "/profile/provider-homes/claude/.claude/plugins/.trash",
      "/home/person/.claude/plugins/.trash",
    ]);
    expect(trash(true, { CLAUDE_CONFIG_DIR: "/custom/claude" })?.roots).toContain(
      "/custom/claude/plugins/.trash",
    );
    expect(trash(false)?.section).toBe("providers");
  });
  it("only lets F5's own targets run without machine cleanup", () => {
    const providerHomesDir = "/profile/provider-homes";
    expect(
      isUngatedProviderTarget({
        categoryId: "claudePluginTrash",
        path: "/profile/provider-homes/claude/.claude/plugins/.trash/x",
        providerHomesDir,
      }),
    ).toBe(true);
    expect(
      isUngatedProviderTarget({
        categoryId: "claudePluginTrash",
        path: "/home/person/.claude/plugins/.trash/x",
        providerHomesDir,
      }),
    ).toBe(false);
    expect(isUngatedProviderTarget({ categoryId: "f5UpdaterCache", path: "/x" })).toBe(true);
    expect(isUngatedProviderTarget({ categoryId: "devboxWarmupCache", path: "/x" })).toBe(false);
  });
  it("offers only plugin trash and update downloads older than a day", async () => {
    const root = await FS.mkdtemp(Path.join(OS.tmpdir(), "f5-provider-age-"));
    try {
      const age = async (path: string, ms: number) => {
        const when = new Date(Date.now() - ms);
        await FS.utimes(path, when, when);
      };
      const trash = Path.join(root, "trash");
      await FS.mkdir(Path.join(trash, "old-plugin"), { recursive: true });
      await FS.mkdir(Path.join(trash, "new-plugin"), { recursive: true });
      await FS.mkdir(Path.join(trash, ".hidden"), { recursive: true });
      await age(Path.join(trash, "old-plugin"), 2 * 86400_000);
      await age(Path.join(trash, ".hidden"), 2 * 86400_000);
      expect(
        await runStorageTask({
          kind: "providerCandidates",
          providerId: "claudePluginTrash",
          root: trash,
        }),
      ).toEqual([Path.join(trash, "old-plugin")]);

      const updater = Path.join(root, "updater");
      await FS.mkdir(Path.join(updater, "pending"), { recursive: true });
      await FS.writeFile(Path.join(updater, "update.zip"), "old");
      await FS.writeFile(Path.join(updater, "fresh.zip"), "new");
      await age(Path.join(updater, "update.zip"), 2 * 86400_000);
      await age(Path.join(updater, "pending"), 2 * 86400_000);
      expect(
        await runStorageTask({
          kind: "providerCandidates",
          providerId: "f5UpdaterCache",
          root: updater,
        }),
      ).toEqual([Path.join(updater, "update.zip")]);
      await age(Path.join(updater, "pending"), 8 * 86400_000);
      expect(
        (
          await runStorageTask<string[]>({
            kind: "providerCandidates",
            providerId: "f5UpdaterCache",
            root: updater,
          })
        ).toSorted(),
      ).toEqual([Path.join(updater, "pending"), Path.join(updater, "update.zip")]);
    } finally {
      await FS.rm(root, { recursive: true, force: true });
    }
  });
  it.each([
    ["darwin", "/home/person", "/home/person/Library/Caches/Google/Chrome"],
    ["linux", "/home/person", "/home/person/.cache/google-chrome"],
    ["win32", "C:\\Users\\person", "C:\\Users\\person\\AppData\\Local\\Google\\Chrome\\User Data"],
  ] as const)(
    "limits Chrome cleanup to recognized profile cache children on %s",
    (platform, home, expected) => {
      const chrome = cleanupProviders({
        stateDirs: [],
        enabled: true,
        platform,
        home,
        env: {},
      }).find((p) => p.id === "chromeCaches")!;
      expect(chrome.roots).toEqual([expected]);
      expect(chrome.children?.test("Default")).toBe(true);
      expect(chrome.children?.test("Profile 2")).toBe(true);
      expect(chrome.children?.test("Cookies")).toBe(false);
      expect(chrome.application).toBe("chrome");
    },
  );
  it("does not classify live databases, WALs, partial exports or arbitrary SQLite files as backups", () => {
    const backup = cleanupProviders({ stateDirs: ["/profile"], enabled: false, env: {} })[0]!;
    for (const name of [
      "state.sqlite",
      "state.sqlite-wal",
      "secrets.sqlite",
      "daily-123.f5backup.partial",
      "other.sqlite",
    ])
      expect(backup.files?.(name, 0)).toBe(false);
    expect(
      backup.files?.("state-before-stuck-turn-repair-2026-10-16T09-06-49.436Z.sqlite", 0),
    ).toBe(true);
  });
  it("keeps current application logs and provider repair logs out of age-only cleanup", () => {
    const logs = cleanupProviders({
      stateDirs: ["/profile"],
      enabled: false,
      env: {},
      now: 10 * 86400_000,
    })[1]!;
    expect(logs.files?.("server.log.1", 0)).toBe(true);
    for (const name of ["server.log", "thread-123.log", "events.log.1", "session.jsonl"])
      expect(logs.files?.(name, 0)).toBe(false);
    expect(logs.files?.("server.log.1", 9 * 86400_000)).toBe(false);
  });
  it("uses uv's XDG default on macOS and respects an explicit cache override", () => {
    const uv = (env: NodeJS.ProcessEnv) =>
      cleanupProviders({
        stateDirs: [],
        enabled: true,
        platform: "darwin",
        home: "/home/person",
        env,
      }).find((p) => p.id === "uvDiscardedCaches")!;
    expect(uv({}).roots).toEqual(["/home/person/.cache"]);
    expect(uv({ XDG_CACHE_HOME: "/custom/cache" }).roots).toEqual(["/custom/cache"]);
    expect(uv({ UV_CACHE_DIR: "/custom/uv-cache" }).roots).toEqual(["/custom"]);
  });
});
