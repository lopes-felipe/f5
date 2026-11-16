import { createContext, useContext } from "react";

// A containing editor can reclaim keyboard focus when its option popup closes.
// Explicit popup finalFocus props still take precedence.
export const PopupFocusContext = createContext<(() => false) | undefined>(undefined);
export function usePopupFocus() {
  return useContext(PopupFocusContext);
}

/**
 * Attributes a containing surface stamps on the popups it owns. Popups render
 * in a portal, so this is how keyboard handling recognizes them as part of it.
 */
export const PopupOwnerAttributesContext = createContext<
  Readonly<Record<`data-${string}`, string>> | undefined
>(undefined);
export function usePopupOwnerAttributes() {
  return useContext(PopupOwnerAttributesContext);
}
