import { describe, expect, it } from "vitest";
import { cleanupProviders } from "./cleanupProviders.ts";

describe("cleanup provider locations and boundaries", () => {
  it.each(["darwin", "linux", "win32"] as const)(
    "keeps machine discovery opt-in on %s",
    (platform) => {
      expect(
        cleanupProviders({ stateDirs: ["/profile"], enabled: false, platform, env: {} }).map(
          (p) => p.id,
        ),
      ).toEqual(["f5Backups", "f5ApplicationLogs"]);
    },
  );
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
