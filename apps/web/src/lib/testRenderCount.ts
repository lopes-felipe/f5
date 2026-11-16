import { useRef } from "react";

/**
 * Test-only render-attempt counter for browser regression tests that assert a
 * surface does not re-render. It counts render calls, not committed renders,
 * and renders nothing outside test builds.
 */
export function useTestRenderCountProps(): { "data-render-count": number } | undefined {
  const renderCountRef = useRef(0);
  renderCountRef.current += 1;
  return import.meta.env.MODE === "test"
    ? { "data-render-count": renderCountRef.current }
    : undefined;
}
