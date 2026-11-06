import type { DesktopTheme } from "@t3tools/contracts";
import type { LinuxColorScheme } from "./linuxColorScheme";

type ThemeTarget = { themeSource: DesktopTheme };
type WatchColorScheme = (onChange: (scheme: LinuxColorScheme) => void) => {
  stop: () => void;
};

/** Keep the user's selection separate from the resolved Linux system appearance. */
export function createDesktopTheme(target: ThemeTarget, watch?: WatchColorScheme) {
  let source = target.themeSource;
  let systemScheme: LinuxColorScheme = null;
  let stopped = false;
  const apply = () => {
    target.themeSource = source === "system" ? (systemScheme ?? source) : source;
  };
  let watcher: ReturnType<WatchColorScheme> | undefined;
  try {
    watcher = watch?.((scheme) => {
      if (stopped) return;
      systemScheme = scheme;
      apply();
    });
  } catch {
    // A missing session bus must leave Electron's system resolution available.
  }
  return {
    setSource(theme: DesktopTheme) {
      source = theme;
      apply();
    },
    stop() {
      if (stopped) return;
      stopped = true;
      watcher?.stop();
    },
  };
}
