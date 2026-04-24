import { createContext, useContext } from "react";

import type { SettingsRouteValue } from "./useSettingsRouteState";

const SettingsRouteContext = createContext<SettingsRouteValue | null>(null);

export function useSettingsRouteContext(): SettingsRouteValue {
  const value = useContext(SettingsRouteContext);
  if (!value) {
    throw new Error("useSettingsRouteContext must be used within SettingsRouteContext.Provider.");
  }
  return value;
}

export { SettingsRouteContext };
