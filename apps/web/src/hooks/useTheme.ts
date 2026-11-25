import { useCallback, useEffect, useSyncExternalStore } from "react";
import { safeLocalStorageSetItem } from "../lib/safeStorage";
import {
  applyThemeMode,
  getSystemPrefersDark,
  readStoredThemeMode,
  resolveThemeMode,
  THEME_MODE_MEDIA_QUERY,
  THEME_MODE_STORAGE_KEY,
  type ThemeMode,
} from "../themeMode";

type ThemeSnapshot = {
  theme: ThemeMode;
  systemDark: boolean;
};

let listeners: Array<() => void> = [];
let lastSnapshot: ThemeSnapshot | null = null;
let lastDesktopTheme: ThemeMode | null = null;
let fallbackTheme: ThemeMode | null = null;
function emitChange() {
  for (const listener of listeners) listener();
}

function currentThemeMode(): ThemeMode {
  return fallbackTheme ?? readStoredThemeMode();
}

function applyTheme(theme: ThemeMode, suppressTransitions = false) {
  applyThemeMode(theme, suppressTransitions);
  syncDesktopTheme(theme);
}

function syncDesktopTheme(theme: ThemeMode) {
  if (typeof window === "undefined") return;
  const bridge = window.desktopBridge;
  if (!bridge || lastDesktopTheme === theme) {
    return;
  }

  lastDesktopTheme = theme;
  void bridge.setTheme(theme).catch(() => {
    if (lastDesktopTheme === theme) {
      lastDesktopTheme = null;
    }
  });
}

// Apply immediately on module load to prevent flash
applyTheme(currentThemeMode());

function getSnapshot(): ThemeSnapshot {
  const theme = currentThemeMode();
  const systemDark = theme === "system" ? getSystemPrefersDark() : false;

  if (lastSnapshot && lastSnapshot.theme === theme && lastSnapshot.systemDark === systemDark) {
    return lastSnapshot;
  }

  lastSnapshot = { theme, systemDark };
  return lastSnapshot;
}

function subscribe(listener: () => void): () => void {
  listeners.push(listener);

  // Listen for system preference changes
  const mq = window.matchMedia(THEME_MODE_MEDIA_QUERY);
  const handleChange = () => {
    if (currentThemeMode() === "system") applyTheme("system", true);
    emitChange();
  };
  mq.addEventListener("change", handleChange);

  // Listen for storage changes from other tabs
  const handleStorage = (e: StorageEvent) => {
    if (e.key === THEME_MODE_STORAGE_KEY) {
      fallbackTheme = null;
      applyTheme(readStoredThemeMode(), true);
      emitChange();
    }
  };
  window.addEventListener("storage", handleStorage);

  return () => {
    listeners = listeners.filter((l) => l !== listener);
    mq.removeEventListener("change", handleChange);
    window.removeEventListener("storage", handleStorage);
  };
}

export function useTheme() {
  const snapshot = useSyncExternalStore(subscribe, getSnapshot);
  const theme = snapshot.theme;

  const resolvedTheme = resolveThemeMode(theme);

  const setTheme = useCallback((next: ThemeMode) => {
    const persisted = safeLocalStorageSetItem(THEME_MODE_STORAGE_KEY, next);
    fallbackTheme = persisted ? null : next;
    applyTheme(next, true);
    emitChange();
  }, []);

  // Keep DOM in sync on mount/change
  useEffect(() => {
    applyTheme(theme);
  }, [theme]);

  return { theme, setTheme, resolvedTheme } as const;
}

export function resetThemeStateForTests(): void {
  fallbackTheme = null;
  lastSnapshot = null;
  lastDesktopTheme = null;
}
