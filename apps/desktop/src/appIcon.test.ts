import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  APP_ICON_CLAIM_DOCK_PROMPT_CHANNEL,
  APP_ICON_DISMISS_DOCK_PROMPT_CHANNEL,
  APP_ICON_GET_CHANNEL,
  APP_ICON_RESTART_DOCK_CHANNEL,
  APP_ICON_SET_CHANNEL,
  DOCK_TILE_CHANGED_SUFFIX,
  DOCK_TILE_CHOICE_KEY,
  DOCK_TILE_CHOICE_USER_INFO_KEY,
  INITIAL_APP_ICON_STATE,
  bundleIconChangedAt,
  createAppIconController,
  createDockChoicePublisher,
  isDockStale,
  parseElapsedSeconds,
  readAppIconState,
  readDockStartedAt,
  registerAppIconIpc,
  writeAppIconState,
  type AppIconPorts,
  type AppIconState,
} from "./appIcon";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

// When v0.1.12-beta.47, the first release with the current artwork, was published.
const ARTWORK_SINCE = Date.parse("2026-11-26T10:16:59Z");
const NOW = Date.parse("2026-12-10T12:00:00Z");

function harness(
  options: {
    platform?: NodeJS.Platform;
    isPackaged?: boolean;
    state?: Partial<AppIconState>;
    missing?: boolean;
    publishFails?: boolean;
  } = {},
) {
  let stored: AppIconState = { ...INITIAL_APP_ICON_STATE, ...options.state };
  const calls = {
    dock: [] as string[],
    restored: 0,
    published: [] as string[],
    windows: [] as string[],
    broadcast: [] as string[],
    restarts: 0,
    later: [] as Array<{ run: () => void; delayMs: number }>,
    logs: [] as string[],
  };
  const ports: AppIconPorts = {
    platform: options.platform ?? "darwin",
    isPackaged: options.isPackaged ?? true,
    readState: () => stored,
    writeState: (state) => {
      stored = state;
    },
    iconPath: (id, file) => (options.missing ? null : `/icons/${id}/${file}`),
    setDockIcon: (path) => void calls.dock.push(path),
    restoreDockIcon: () => void (calls.restored += 1),
    publishDockChoice: (id) => {
      if (options.publishFails) throw new Error("no preferences");
      calls.published.push(id);
    },
    setWindowIcons: (path) => void calls.windows.push(path),
    broadcast: (id) => void calls.broadcast.push(id),
    restartDock: async () => void (calls.restarts += 1),
    later: (run, delayMs) => void calls.later.push({ run, delayMs }),
    log: (message) => void calls.logs.push(message),
  };
  return { controller: createAppIconController(ports), calls, stored: () => stored };
}

const staleInput = (dockStartedAt: number | null, hash = "new") => ({
  bundleIconHash: hash,
  installedAt: null,
  updatedFrom: null,
  existingInstallation: true,
  now: NOW,
  readDockStartedAt: async () => dockStartedAt,
});

describe("app icon preference file", () => {
  it("round trips, and reads anything unusable as the default", () => {
    const root = fs.mkdtempSync(join(tmpdir(), "f5-app-icon-"));
    roots.push(root);
    const path = join(root, "app-icon.json");
    expect(readAppIconState(path)).toEqual(INITIAL_APP_ICON_STATE);
    const state: AppIconState = {
      id: "classic",
      bundle: { hash: "abc", changedAt: 12 },
      promptedFor: 12,
    };
    writeAppIconState(path, state);
    expect(readAppIconState(path)).toEqual(state);
    expect(fs.readdirSync(root)).toEqual(["app-icon.json"]);

    fs.writeFileSync(path, "not json");
    expect(readAppIconState(path)).toEqual(INITIAL_APP_ICON_STATE);
    fs.writeFileSync(
      path,
      JSON.stringify({ id: "neon", bundle: { hash: "abc" }, promptedFor: "x" }),
    );
    expect(readAppIconState(path)).toEqual({
      id: "lines",
      bundle: { hash: "abc", changedAt: null },
      promptedFor: null,
    });
  });
});

describe("choosing an icon", () => {
  it("rejects ids it does not know", () => {
    const { controller, calls, stored } = harness();
    expect(() => controller.set("neon")).toThrow("Unknown app icon");
    expect(() => controller.set(undefined)).toThrow("Unknown app icon");
    expect(stored().id).toBe("lines");
    expect(calls.broadcast).toEqual([]);
  });

  it("leaves the bundle icon alone when a packaged macOS app launches with the default", () => {
    const { controller, calls } = harness();
    controller.applyAtLaunch();
    expect(calls.dock).toEqual([]);
    expect(controller.windowIconPath()).toBeNull();
  });

  it("sets the Dock icon at launch for another choice, and on every change", () => {
    const { controller, calls, stored } = harness({ state: { id: "classic" } });
    controller.applyAtLaunch();
    controller.set("mono");
    expect(calls.dock).toEqual(["/icons/classic/macos.png", "/icons/mono/macos.png"]);
    expect(calls.broadcast).toEqual(["mono"]);
    expect(stored().id).toBe("mono");
    expect(calls.windows).toEqual([]);
  });

  it("puts the bundle's own icon back when a packaged app switches to the default", () => {
    const { controller, calls } = harness({ state: { id: "classic" } });
    controller.set("lines");
    expect(calls.dock).toEqual([]);
    expect(calls.restored).toBe(1);
    expect(calls.broadcast).toEqual(["lines"]);
  });

  it("keeps covering a stale Dock when switching to the default", async () => {
    const { controller, calls } = harness({
      state: { id: "classic", bundle: { hash: "old", changedAt: 1 } },
    });
    await controller.detectStaleDock(staleInput(NOW - 1));
    controller.set("lines");
    expect(calls.dock.at(-1)).toBe("/icons/lines/macos.png");
    expect(calls.restored).toBe(0);
  });

  it("always sets the badged Dock icon in an unpackaged macOS build", () => {
    const { controller, calls } = harness({ isPackaged: false, state: { id: "mono" } });
    controller.applyAtLaunch();
    controller.set("lines");
    expect(calls.dock).toEqual(["/icons/mono/macos.png", "/icons/lines/macos.png"]);
    expect(calls.restored).toBe(0);
  });

  it.each([
    ["win32", "windows.ico"],
    ["linux", "linux.png"],
  ] as const)("uses window icons on %s", (platform, file) => {
    const { controller, calls } = harness({ platform, state: { id: "mono" } });
    controller.applyAtLaunch();
    expect(controller.windowIconPath()).toBe(`/icons/mono/${file}`);
    controller.set("blue");
    expect(calls.windows).toEqual([`/icons/blue/${file}`]);
    expect(calls.dock).toEqual([]);
    expect(calls.broadcast).toEqual(["blue"]);
  });

  it("still tells the windows when an icon file is missing", () => {
    const { controller, calls } = harness({ missing: true });
    controller.set("classic");
    expect(calls.dock).toEqual([]);
    expect(calls.broadcast).toEqual(["classic"]);
  });

  it("refuses a choice it cannot save, changes nothing, and saves it when chosen again", () => {
    let failing = true;
    const { controller, calls, stored } = harness();
    const flaky = createAppIconController({
      platform: "darwin",
      isPackaged: true,
      readState: () => INITIAL_APP_ICON_STATE,
      writeState: () => {
        if (failing) throw new Error("disk full");
      },
      iconPath: (id, file) => `/icons/${id}/${file}`,
      setDockIcon: (path) => void calls.dock.push(path),
      restoreDockIcon: () => {},
      publishDockChoice: (id) => void calls.published.push(id),
      setWindowIcons: () => {},
      broadcast: (id) => void calls.broadcast.push(id),
      restartDock: async () => {},
      later: () => {},
      log: (message) => void calls.logs.push(message),
    });
    expect(() => flaky.set("glow")).toThrow("The app icon choice could not be saved");
    expect(flaky.id()).toBe("lines");
    expect(calls.dock).toEqual([]);
    expect(calls.published).toEqual([]);
    expect(calls.broadcast).toEqual([]);
    expect(calls.logs).toEqual(["Could not save the app icon choice: Error: disk full"]);

    failing = false;
    flaky.set("glow");
    expect(flaky.id()).toBe("glow");
    expect(calls.broadcast).toEqual(["glow"]);
    expect(controller.id()).toBe("lines");
    expect(stored().id).toBe("lines");
  });
});

describe("telling the Dock tile plug-in", () => {
  it("records the choice at every packaged macOS launch and on every change", () => {
    const { controller, calls } = harness({ state: { id: "classic" } });
    controller.applyAtLaunch();
    controller.set("mono");
    // Back to the default too: the plug-in must stop drawing the earlier choice.
    controller.set("lines");
    expect(calls.published).toEqual(["classic", "mono", "lines"]);
  });

  it("records the default at launch, so a stale record cannot outlive the choice", () => {
    const { controller, calls } = harness();
    controller.applyAtLaunch();
    expect(calls.published).toEqual(["lines"]);
    expect(calls.dock).toEqual([]);
  });

  it.each([
    ["an unpackaged macOS build", { isPackaged: false }],
    ["Windows", { platform: "win32" }],
    ["Linux", { platform: "linux" }],
  ] as const)("does nothing in %s, which has no plug-in", (_name, options) => {
    const { controller, calls } = harness(options);
    controller.applyAtLaunch();
    controller.set("glow");
    expect(calls.published).toEqual([]);
  });

  it("still changes the icon when the record cannot be written", () => {
    const { controller, calls, stored } = harness({ publishFails: true });
    controller.applyAtLaunch();
    controller.set("cool");
    expect(stored().id).toBe("cool");
    expect(calls.dock).toEqual(["/icons/cool/macos.png"]);
    expect(calls.broadcast).toEqual(["cool"]);
    expect(calls.logs).toEqual([
      "Could not record the app icon for the Dock: Error: no preferences",
      "Could not record the app icon for the Dock: Error: no preferences",
    ]);
  });

  it("records it once more at quit, on a packaged Mac only", () => {
    const mac = harness({ state: { id: "sunrise" } });
    mac.controller.publishDockChoiceAtQuit();
    expect(mac.calls.published).toEqual(["sunrise"]);
    const linux = harness({ platform: "linux" });
    linux.controller.publishDockChoiceAtQuit();
    expect(linux.calls.published).toEqual([]);
  });

  it("writes the preference, then posts the notification carrying the id", () => {
    const order: unknown[][] = [];
    const publish = createDockChoicePublisher(
      {
        setUserDefault: (...args) => void order.push(["setUserDefault", ...args]),
        postNotification: (...args) => void order.push(["postNotification", ...args]),
      },
      "io.example.app",
    );
    publish("cobalt");
    expect(order).toEqual([
      ["setUserDefault", "F5AppIcon", "string", "cobalt"],
      ["postNotification", "io.example.app.app-icon-changed", { id: "cobalt" }, true],
    ]);
  });

  it("uses the key, notification suffix and userInfo key the plug-in reads", () => {
    const plugIn = fs.readFileSync(join(__dirname, "../native/dock-tile/F5DockTile.m"), "utf8");
    expect(plugIn).toContain(`F5ChoiceKey = @"${DOCK_TILE_CHOICE_KEY}"`);
    expect(plugIn).toContain(`F5ChangedSuffix = @"${DOCK_TILE_CHANGED_SUFFIX}"`);
    expect(plugIn).toContain(`F5ChoiceUserInfoKey = @"${DOCK_TILE_CHOICE_USER_INFO_KEY}"`);
  });
});

describe("when the built-in icon changed", () => {
  const base = {
    hash: "new",
    now: NOW,
    installedAt: null,
    updatedFrom: null,
    existingInstallation: true,
  };
  const INSTALLED = NOW - 3_600_000;

  it("is the install when the stored hash differs, and unchanged when it matches", () => {
    expect(bundleIconChangedAt({ ...base, stored: { hash: "old", changedAt: 5 } })).toBe(NOW);
    expect(
      bundleIconChangedAt({
        ...base,
        installedAt: INSTALLED,
        stored: { hash: "old", changedAt: 5 },
      }),
    ).toBe(INSTALLED);
    expect(bundleIconChangedAt({ ...base, stored: { hash: "new", changedAt: 5 } })).toBe(5);
    expect(bundleIconChangedAt({ ...base, stored: { hash: "new", changedAt: null } })).toBeNull();
  });

  it("is the install when nothing is stored and the update came from before the new artwork", () => {
    for (const updatedFrom of ["0.1.11", "0.1.12-beta.41", "0.1.12-beta.42", "0.1.12-beta.5"]) {
      expect(bundleIconChangedAt({ ...base, stored: null, updatedFrom })).toBe(NOW);
      expect(
        bundleIconChangedAt({ ...base, installedAt: INSTALLED, stored: null, updatedFrom }),
      ).toBe(INSTALLED);
    }
  });

  it("never puts the install in the future", () => {
    expect(
      bundleIconChangedAt({ ...base, installedAt: NOW + 1, stored: { hash: "old", changedAt: 5 } }),
    ).toBe(NOW);
  });

  it("is the artwork's release when nothing is stored on an existing installation", () => {
    for (const updatedFrom of [null, "0.1.12-beta.47", "0.1.12", "0.2.0", "not a version"])
      expect(bundleIconChangedAt({ ...base, stored: null, updatedFrom })).toBe(ARTWORK_SINCE);
  });

  it("is never on a fresh installation", () => {
    expect(bundleIconChangedAt({ ...base, stored: null, existingInstallation: false })).toBeNull();
  });
});

describe("reading the Dock's age", () => {
  it("parses ps elapsed times", () => {
    expect(parseElapsedSeconds("  05:09\n")).toBe(309);
    expect(parseElapsedSeconds("01:02:03")).toBe(3723);
    expect(parseElapsedSeconds("3-01:02:03")).toBe(3 * 86400 + 3723);
    expect(parseElapsedSeconds("")).toBeNull();
    expect(parseElapsedSeconds("soon")).toBeNull();
  });

  it("asks pgrep for this user's Dock, then ps for its elapsed time", async () => {
    const run = vi.fn(async (file: string) => (file.endsWith("pgrep") ? "412\n" : " 10:00\n"));
    expect(await readDockStartedAt(run, NOW, 501)).toBe(NOW - 600_000);
    expect(run.mock.calls).toEqual([
      ["/usr/bin/pgrep", ["-x", "-U", "501", "Dock"]],
      ["/bin/ps", ["-o", "etime=", "-p", "412"]],
    ]);
  });

  it("is unknown when either command fails or prints something else", async () => {
    expect(
      await readDockStartedAt(async () => Promise.reject(new Error("no")), NOW, 501),
    ).toBeNull();
    expect(await readDockStartedAt(async () => "", NOW, 501)).toBeNull();
    expect(
      await readDockStartedAt(async (file) => (file.endsWith("pgrep") ? "412" : "?"), NOW, 501),
    ).toBeNull();
  });

  it("calls the Dock stale only when it started before a known change", () => {
    expect(isDockStale(100, 99)).toBe(true);
    expect(isDockStale(100, 100)).toBe(false);
    expect(isDockStale(100, 101)).toBe(false);
    expect(isDockStale(null, 99)).toBe(false);
    expect(isDockStale(100, null)).toBe(false);
  });
});

describe("a Dock that still shows the old icon", () => {
  const WINDOW = 7;
  const OTHER_WINDOW = 8;

  it("is covered from the running app, and the offer counts once it is answered", async () => {
    const { controller, calls, stored } = harness({
      state: { bundle: { hash: "old", changedAt: null } },
    });
    await controller.detectStaleDock(staleInput(NOW - 60_000));
    expect(stored().bundle).toEqual({ hash: "new", changedAt: NOW });
    expect(calls.dock).toEqual(["/icons/lines/macos.png"]);
    expect(await controller.claimDockRefreshPrompt(WINDOW)).toBe(true);
    // One window at a time; the same window again after a reload.
    expect(await controller.claimDockRefreshPrompt(OTHER_WINDOW)).toBe(false);
    expect(await controller.claimDockRefreshPrompt(WINDOW)).toBe(true);
    expect(stored().promptedFor).toBeNull();

    controller.dismissDockRefreshPrompt(OTHER_WINDOW);
    expect(stored().promptedFor).toBeNull();
    controller.dismissDockRefreshPrompt(WINDOW);
    expect(stored().promptedFor).toBe(NOW);
    expect(await controller.claimDockRefreshPrompt(WINDOW)).toBe(false);

    // The next launch still finds the Dock stale, but the person has answered.
    const next = harness({ state: stored() });
    await next.controller.detectStaleDock(staleInput(NOW - 60_000));
    expect(next.calls.dock).toEqual(["/icons/lines/macos.png"]);
    expect(await next.controller.claimDockRefreshPrompt(WINDOW)).toBe(false);
  });

  it("passes the offer on when the window showing it goes away unanswered", async () => {
    const { controller, stored } = harness({ state: { bundle: { hash: "old", changedAt: 1 } } });
    await controller.detectStaleDock(staleInput(NOW - 1));
    expect(await controller.claimDockRefreshPrompt(WINDOW)).toBe(true);
    controller.releaseCaller(OTHER_WINDOW);
    expect(await controller.claimDockRefreshPrompt(OTHER_WINDOW)).toBe(false);
    controller.releaseCaller(WINDOW);
    expect(await controller.claimDockRefreshPrompt(OTHER_WINDOW)).toBe(true);
    expect(stored().promptedFor).toBeNull();

    // Nothing answered before quitting: the next launch offers it again.
    const next = harness({ state: stored() });
    await next.controller.detectStaleDock(staleInput(NOW - 1));
    expect(await next.controller.claimDockRefreshPrompt(WINDOW)).toBe(true);
  });

  it("waits for the check before answering a claim", async () => {
    const { controller } = harness({ state: { bundle: { hash: "old", changedAt: null } } });
    let finish: (startedAt: number) => void = () => {};
    const started = new Promise<number>((resolve) => (finish = resolve));
    void controller.detectStaleDock({ ...staleInput(null), readDockStartedAt: () => started });
    const claim = controller.claimDockRefreshPrompt(WINDOW);
    finish(NOW - 1);
    expect(await claim).toBe(true);
  });

  it("does nothing once the Dock has restarted, or when its age is unknown", async () => {
    for (const dockStartedAt of [NOW + 1, null]) {
      const { controller, calls } = harness({ state: { bundle: { hash: "old", changedAt: 1 } } });
      await controller.detectStaleDock(staleInput(dockStartedAt));
      expect(calls.dock).toEqual([]);
      expect(await controller.claimDockRefreshPrompt(WINDOW)).toBe(false);
    }
  });

  it("is not fooled by a Dock that restarted between the install and this launch", async () => {
    const installedAt = NOW - 3_600_000;
    const { controller, calls } = harness({ state: { bundle: { hash: "old", changedAt: null } } });
    await controller.detectStaleDock({ ...staleInput(installedAt + 60_000), installedAt });
    expect(calls.dock).toEqual([]);
    expect(await controller.claimDockRefreshPrompt(WINDOW)).toBe(false);
  });

  it("records a fresh installation's icon without calling anything stale", async () => {
    const { controller, calls, stored } = harness();
    await controller.detectStaleDock({ ...staleInput(1), existingInstallation: false });
    expect(stored().bundle).toEqual({ hash: "new", changedAt: null });
    expect(calls.dock).toEqual([]);
    expect(await controller.claimDockRefreshPrompt(WINDOW)).toBe(false);
  });

  it("is only checked by a packaged macOS app that can read its icon", async () => {
    for (const options of [{ platform: "win32" as const }, { isPackaged: false }]) {
      const { controller, stored } = harness(options);
      await controller.detectStaleDock(staleInput(1));
      expect(stored().bundle).toBeNull();
      expect(await controller.claimDockRefreshPrompt(WINDOW)).toBe(false);
    }
    const { controller, stored } = harness();
    await controller.detectStaleDock({ ...staleInput(1), bundleIconHash: null });
    expect(stored().bundle).toBeNull();
  });

  it("restarts the Dock for the window showing the offer, then sets a chosen icon again", async () => {
    const chosen = harness({ state: { id: "classic", bundle: { hash: "old", changedAt: 1 } } });
    await chosen.controller.detectStaleDock(staleInput(NOW - 1));
    expect(await chosen.controller.claimDockRefreshPrompt(WINDOW)).toBe(true);
    await chosen.controller.restartDock(WINDOW);
    expect(chosen.calls.restarts).toBe(1);
    // The stored hash differed, so the icon changed at this launch.
    expect(chosen.stored().promptedFor).toBe(NOW);
    expect(chosen.calls.later.map((entry) => entry.delayMs)).toEqual([1500, 5000]);
    chosen.calls.later[0]!.run();
    expect(chosen.calls.dock.at(-1)).toBe("/icons/classic/macos.png");
    expect(await chosen.controller.claimDockRefreshPrompt(WINDOW)).toBe(false);
    // The offer is answered: a second restart is refused.
    await expect(chosen.controller.restartDock(WINDOW)).rejects.toThrow("No Dock restart");
    expect(chosen.calls.restarts).toBe(1);

    // With the default chosen, the restarted Dock shows the bundle's own icon.
    const standard = harness({ state: { bundle: { hash: "old", changedAt: 1 } } });
    await standard.controller.detectStaleDock(staleInput(NOW - 1));
    await standard.controller.claimDockRefreshPrompt(WINDOW);
    await standard.controller.restartDock(WINDOW);
    const dockCalls = standard.calls.dock.length;
    for (const entry of standard.calls.later) entry.run();
    expect(standard.calls.dock).toHaveLength(dockCalls);
  });

  it("refuses to restart the Dock unless the calling window is showing the offer", async () => {
    const fresh = harness();
    await expect(fresh.controller.restartDock(WINDOW)).rejects.toThrow("No Dock restart");

    const stale = harness({ state: { bundle: { hash: "old", changedAt: 1 } } });
    await stale.controller.detectStaleDock(staleInput(NOW - 1));
    await expect(stale.controller.restartDock(WINDOW)).rejects.toThrow("No Dock restart");
    await stale.controller.claimDockRefreshPrompt(WINDOW);
    await expect(stale.controller.restartDock(OTHER_WINDOW)).rejects.toThrow("No Dock restart");
    expect(stale.calls.restarts).toBe(0);

    await expect(harness({ platform: "linux" }).controller.restartDock(WINDOW)).rejects.toThrow(
      "Only macOS",
    );
  });
});

describe("app icon IPC", () => {
  type FakeEvent = { sender: { id: number }; returnValue?: unknown };

  function registered(assertCaller: () => void) {
    const handlers = new Map<string, (event: FakeEvent, ...args: unknown[]) => unknown>();
    const listeners = new Map<string, (event: FakeEvent) => void>();
    const controller = {
      id: vi.fn(() => "cobalt" as const),
      set: vi.fn(),
      claimDockRefreshPrompt: vi.fn(async () => true),
      dismissDockRefreshPrompt: vi.fn(),
      restartDock: vi.fn(async () => {}),
    };
    registerAppIconIpc<FakeEvent>(
      {
        removeHandler: (channel) => void handlers.delete(channel),
        handle: (channel, listener) => void handlers.set(channel, listener),
        removeAllListeners: (channel) => void listeners.delete(channel),
        on: (channel, listener) => void listeners.set(channel, listener),
      },
      controller,
      assertCaller,
    );
    return { handlers, listeners, controller };
  }
  const from = (id: number): FakeEvent => ({ sender: { id } });

  it("passes calls from an app window through, with the window's id", async () => {
    const { handlers, listeners, controller } = registered(() => {});
    await handlers.get(APP_ICON_SET_CHANNEL)!(from(3), "classic");
    expect(controller.set).toHaveBeenCalledWith("classic");
    expect(await handlers.get(APP_ICON_CLAIM_DOCK_PROMPT_CHANNEL)!(from(3))).toBe(true);
    expect(controller.claimDockRefreshPrompt).toHaveBeenCalledWith(3);
    await handlers.get(APP_ICON_DISMISS_DOCK_PROMPT_CHANNEL)!(from(3));
    expect(controller.dismissDockRefreshPrompt).toHaveBeenCalledWith(3);
    await handlers.get(APP_ICON_RESTART_DOCK_CHANNEL)!(from(3));
    expect(controller.restartDock).toHaveBeenCalledWith(3);

    const event = from(3);
    listeners.get(APP_ICON_GET_CHANNEL)!(event);
    expect(event.returnValue).toBe("cobalt");
  });

  it("rejects every call from any other sender, and still answers the synchronous one", async () => {
    const { handlers, listeners, controller } = registered(() => {
      throw new Error("Unauthorized");
    });
    expect([...handlers.keys()]).toHaveLength(4);
    for (const handler of handlers.values())
      await expect(handler(from(9), "classic")).rejects.toThrow("Unauthorized");
    expect(controller.set).not.toHaveBeenCalled();
    expect(controller.restartDock).not.toHaveBeenCalled();
    expect(controller.claimDockRefreshPrompt).not.toHaveBeenCalled();
    expect(controller.dismissDockRefreshPrompt).not.toHaveBeenCalled();

    // A synchronous call left without a reply would hang the page.
    const event = from(9);
    listeners.get(APP_ICON_GET_CHANNEL)!(event);
    expect(event.returnValue).toBeNull();
    expect(controller.id).not.toHaveBeenCalled();
  });
});
