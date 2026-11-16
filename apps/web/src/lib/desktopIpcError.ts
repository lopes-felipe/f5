/**
 * Electron prefixes an error thrown by a main-process handler with the IPC
 * channel (`Error invoking remote method 'desktop:x': Error: …`). Returns the
 * handler's own message for display.
 */
export function desktopIpcErrorMessage(error: unknown, fallback: string): string {
  if (!(error instanceof Error)) return fallback;
  return error.message.replace(/^Error invoking remote method '[^']*': (?:Error: )?/u, "");
}
