import { useCallback, useLayoutEffect, useRef } from "react";

/**
 * A callback whose identity never changes but always runs the latest `callback`. Pass it to a
 * memoized child in place of a handler that the parent rebuilds on every render.
 */
export function useStableCallback<Args extends unknown[], Result>(
  callback: (...args: Args) => Result,
): (...args: Args) => Result {
  const latest = useRef(callback);
  useLayoutEffect(() => {
    latest.current = callback;
  });
  return useCallback((...args: Args) => latest.current(...args), []);
}
