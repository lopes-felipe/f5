import { describe, expect, it, vi } from "vitest";
import type { DesktopTheme } from "@t3tools/contracts";
import { createDesktopTheme } from "./desktopTheme";
import type { LinuxColorScheme } from "./linuxColorScheme";

function setup(source: DesktopTheme = "system") {
  const target = { themeSource: source };
  let report = (_scheme: LinuxColorScheme) => {};
  const stop = vi.fn();
  const theme = createDesktopTheme(target, (onChange) => {
    report = onChange;
    return { stop };
  });
  return { target, theme, report, stop };
}

describe("desktop theme", () => {
  it("reports synchronous watcher setup failures and keeps Electron fallback", () => {
    const target = { themeSource: "system" as DesktopTheme };
    const error = new Error("no session bus");
    const onError = vi.fn();
    const theme = createDesktopTheme(
      target,
      () => {
        throw error;
      },
      onError,
    );
    expect(onError).toHaveBeenCalledExactlyOnceWith(error);
    theme.setSource("system");
    expect(target.themeSource).toBe("system");
  });

  it("reports async watcher failures once and ignores errors after shutdown", () => {
    let fail = (_cause: unknown) => {};
    const onError = vi.fn();
    const theme = createDesktopTheme(
      { themeSource: "system" },
      (_onChange, onFailure) => {
        fail = onFailure;
        return { stop() {} };
      },
      onError,
    );
    const error = new Error("portal unavailable");
    fail(error);
    fail(new Error("session bus disconnected"));
    expect(onError).toHaveBeenCalledExactlyOnceWith(error);
    theme.stop();
    fail(error);
    expect(onError).toHaveBeenCalledOnce();
  });

  it("does not log a failure that arrives after shutdown", () => {
    let fail = (_cause: unknown) => {};
    const onError = vi.fn();
    const theme = createDesktopTheme(
      { themeSource: "system" },
      (_onChange, onFailure) => {
        fail = onFailure;
        return { stop() {} };
      },
      onError,
    );
    theme.stop();
    fail(new Error("disconnected"));
    expect(onError).not.toHaveBeenCalled();
  });
  it("resolves System from live desktop changes and falls back for unknown values", () => {
    const { target, theme, report } = setup();
    theme.setSource("system");
    report("dark");
    expect(target.themeSource).toBe("dark");
    report("light");
    expect(target.themeSource).toBe("light");
    report(null);
    expect(target.themeSource).toBe("system");
  });

  it.each(["light", "dark"] as const)(
    "preserves explicit %s and remembers system changes",
    (source) => {
      const { target, theme, report } = setup(source);
      report("dark");
      expect(target.themeSource).toBe(source);
      theme.setSource(source);
      report("light");
      expect(target.themeSource).toBe(source);
      theme.setSource("system");
      expect(target.themeSource).toBe("light");
    },
  );

  it("stops watching once and ignores late callbacks", () => {
    const { theme, target, report, stop } = setup();
    theme.stop();
    theme.stop();
    report("dark");
    expect(stop).toHaveBeenCalledOnce();
    expect(target.themeSource).toBe("system");
  });

  it.each([
    undefined,
    () => {
      throw new Error("no session bus");
    },
  ])("uses Electron when no watcher is available", (watch) => {
    const target = { themeSource: "system" as DesktopTheme };
    const theme = createDesktopTheme(target, watch);
    theme.setSource("dark");
    expect(target.themeSource).toBe("dark");
    theme.setSource("system");
    expect(target.themeSource).toBe("system");
    theme.stop();
  });
});
