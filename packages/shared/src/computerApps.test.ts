import { describe, expect, it } from "vitest";
import {
  appTier,
  appWarning,
  classifySystemSurface,
  grantAllows,
  selectComputerApp,
} from "./computerApps";
import {
  computerModelSize,
  computerModelToNative,
  computerGeometryGeneration,
} from "./computerGeometry";

describe("computer app catalog", () => {
  it("prefers exact app IDs and names without silently granting fuzzy matches", () => {
    const apps = [
      { appId: "code", name: "Code", tier: "click" as const, running: true, frontmost: false },
      { appId: "xcode", name: "Xcode", tier: "click" as const, running: false, frontmost: false },
      {
        appId: "calc!app",
        name: "Calculator",
        tier: "full" as const,
        running: false,
        frontmost: false,
      },
    ];
    expect(selectComputerApp(apps, "Code").map((app) => app.appId)).toEqual(["code"]);
    expect(selectComputerApp(apps, "CALC!APP").map((app) => app.appId)).toEqual(["calc!app"]);
    expect(selectComputerApp(apps, "co")).toHaveLength(2);
  });
  it.each([
    "com.apple.SecurityAgent",
    "com.apple.systempreferences",
    "com.apple.Passwords",
    "com.apple.ActivityMonitor",
  ])("blocks %s", (id) => expect(appTier(id, "darwin")).toBe("blocked"));
  it.each([
    "C:\\Windows\\System32\\consent.exe",
    "C:\\Windows\\regedit.exe",
    "windows.immersivecontrolpanel_cw5n1h2txyewy!microsoft.windows.immersivecontrolpanel",
    "C:\\Windows\\System32\\ApplicationFrameHost.exe",
  ])("blocks Windows identity %s", (id) => expect(appTier(id, "win32")).toBe("blocked"));
  it("blocks F5 channels and dev Electron across independent instances", () => {
    expect(appTier("com.github.Electron", "darwin", { f5Pids: [4], pid: 4 })).toBe("blocked");
    expect(appTier("com.github.Electron", "darwin", { f5Pids: [4], pid: 5 })).toBe("blocked");
    expect(appTier("com.t3tools.t3code", "darwin")).toBe("blocked");
    expect(appTier("com.t3tools.t3code.beta", "darwin")).toBe("blocked");
    expect(appTier("C:\\Apps\\F5 (Alpha).exe", "win32")).toBe("blocked");
    expect(appTier("Microsoft.Windows.ShellExperienceHost_cw5n1h2txyewy!App", "win32")).toBe(
      "blocked",
    );
    expect(appTier("Microsoft.Windows.StartMenuExperienceHost_cw5n1h2txyewy!App", "win32")).toBe(
      "blocked",
    );
  });
  it("restricts password managers and command capable apps", () => {
    expect(appTier("com.1password.1password", "darwin")).toBe("view");
    expect(appTier("com.jetbrains.intellij", "darwin")).toBe("click");
    expect(appTier("C:\\Windows\\explorer.exe", "win32")).toBe("click");
  });
  it("never promotes tiers through typing rights", () => {
    expect(grantAllows("blocked", true, "view")).toBe(false);
    expect(grantAllows("view", true, "type")).toBe(false);
    expect(grantAllows("click", false, "type")).toBe(false);
    expect(grantAllows("click", true, "type")).toBe(true);
  });
  it("classifies browsers and non-grantable system surfaces", () => {
    expect(appWarning("com.google.Chrome", "darwin")).toBe("browser");
    expect(appWarning("c:\\chrome.exe", "win32")).toBe("browser");
    expect(classifySystemSurface("win32", "Shell_TrayWnd")).toBe("system-ui");
    expect(classifySystemSurface("darwin", "com.apple.dock")).toBe("system-ui");
  });
});
describe("computer model space", () => {
  it("keeps rounded Windows edge coordinates on their display", () => {
    const display = {
      displayId: "edge",
      primary: false,
      geometryGeneration: "1",
      rotation: 0,
      nativeBounds: { x: -100, y: 0, width: 100, height: 100 },
      pixelSize: { width: 100, height: 100 },
      modelSize: { width: 100, height: 100 },
    };
    expect(computerModelToNative(display, 99, 99, "win32")).toEqual({ x: -1, y: 99 });
  });
  it.each([
    [5120, 2880],
    [3840, 2160],
    [1000, 4000],
    [1920, 1080],
    [200, 100],
  ])("bounds %i × %i", (width, height) => {
    const size = computerModelSize({ width, height });
    expect(Math.max(size.width, size.height)).toBeLessThanOrEqual(1456);
    expect(size.width * size.height).toBeLessThanOrEqual(1_150_000);
    expect(size.width).toBeLessThanOrEqual(width);
  });
  it("maps pixel centres to negative origins and rounds Windows pixels", () => {
    const geometry = {
      displayId: "a",
      nativeBounds: { x: -100, y: 20, width: 100, height: 100 },
      pixelSize: { width: 200, height: 200 },
      rotation: 90,
    };
    const display = {
      ...geometry,
      primary: false,
      modelSize: { width: 200, height: 200 },
      geometryGeneration: computerGeometryGeneration(geometry),
    };
    expect(computerModelToNative(display, 0, 0, "darwin")).toEqual({ x: -99.75, y: 20.25 });
    expect(computerModelToNative(display, 0, 0, "win32")).toEqual({ x: -100, y: 20 });
    expect(() => computerModelToNative(display, 200, 0, "darwin")).toThrow();
    expect(computerGeometryGeneration({ ...geometry, rotation: 0 })).not.toBe(
      display.geometryGeneration,
    );
  });
});
