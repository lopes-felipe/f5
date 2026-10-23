import { createContext, useContext } from "react";

/** A thread workspace supplies this only while terminal actions are available. */
const TerminalCommandContext = createContext<((command: string) => Promise<void>) | null>(null);
export const TerminalCommandProvider = TerminalCommandContext.Provider;
export function useTerminalCommand() {
  return useContext(TerminalCommandContext);
}
