export type ThemeMode = "light" | "dark" | "system";

export const THEME_MODE_STORAGE_KEY = "t3code:theme";
const MEDIA_QUERY = "(prefers-color-scheme: dark)";

export function getSystemPrefersDark(): boolean {
  return window.matchMedia(MEDIA_QUERY).matches;
}

export function readStoredThemeMode(): ThemeMode {
  const raw = localStorage.getItem(THEME_MODE_STORAGE_KEY);
  return raw === "light" || raw === "dark" || raw === "system" ? raw : "system";
}

export function resolveThemeMode(theme: ThemeMode): "light" | "dark" {
  return theme === "system" ? (getSystemPrefersDark() ? "dark" : "light") : theme;
}

export function applyThemeMode(theme: ThemeMode, suppressTransitions = false): void {
  const root = document.documentElement;
  if (suppressTransitions) root.classList.add("no-transitions");
  root.classList.toggle("dark", resolveThemeMode(theme) === "dark");
  if (suppressTransitions) {
    // Force a reflow so the no-transitions class takes effect before removal.
    // oxlint-disable-next-line no-unused-expressions
    root.offsetHeight;
    requestAnimationFrame(() => root.classList.remove("no-transitions"));
  }
}

export const THEME_MODE_MEDIA_QUERY = MEDIA_QUERY;
