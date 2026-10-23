import { useEffect, useState } from "react";
/** Shift-only actions must disappear on blur, including when keyup reaches another app. */
export function usePrQuickActionModifier() {
  const [active, setActive] = useState(false);
  useEffect(() => {
    const key = (event: KeyboardEvent) =>
      setActive(event.shiftKey && !event.ctrlKey && !event.metaKey && !event.altKey);
    const clear = () => setActive(false);
    window.addEventListener("keydown", key, true);
    window.addEventListener("keyup", key, true);
    window.addEventListener("blur", clear);
    document.addEventListener("visibilitychange", clear);
    return () => {
      window.removeEventListener("keydown", key, true);
      window.removeEventListener("keyup", key, true);
      window.removeEventListener("blur", clear);
      document.removeEventListener("visibilitychange", clear);
    };
  }, []);
  return active;
}
