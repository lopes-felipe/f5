/**
 * Returns true when the currently focused element is part of the thread
 * terminal drawer's xterm instance.
 *
 * This is the single source of truth for the `!terminalFocus` keybinding
 * condition (e.g. cmd/ctrl+k, which must pass through to shell readline when
 * the terminal is focused). The selectors below cover every terminal focus
 * context in the app today — the app has exactly one terminal implementation,
 * mounted under `.thread-terminal-drawer` with xterm.js. If new terminal-like
 * surfaces are ever added, update this function so all terminal focus contexts
 * keep the `!terminalFocus` gate honest.
 */
export function isTerminalFocused(): boolean {
  const activeElement = document.activeElement;
  if (!(activeElement instanceof HTMLElement)) return false;
  if (activeElement.classList.contains("xterm-helper-textarea")) return true;
  return activeElement.closest(".thread-terminal-drawer .xterm") !== null;
}
