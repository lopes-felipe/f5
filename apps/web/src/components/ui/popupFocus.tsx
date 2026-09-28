import { createContext, useContext } from "react";

// A containing editor can reclaim keyboard focus when its option popup closes.
// Explicit popup finalFocus props still take precedence.
export const PopupFocusContext = createContext<(() => false) | undefined>(undefined);
export function usePopupFocus() {
  return useContext(PopupFocusContext);
}
