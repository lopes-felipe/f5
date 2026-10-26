/** Capture terminal links at mouseup, before xterm activates them. */
export function createFileActionGesture(
  target: Pick<Window, "addEventListener">,
  now: () => number = () => performance.now(),
): () => boolean {
  let gestureAt = -Infinity;
  for (const name of ["mouseup", "click", "keydown"] as const) {
    target.addEventListener(
      name,
      (event) => {
        if (!event.isTrusted) return;
        if (name === "mouseup" && (event as MouseEvent).button !== 0) return;
        // Mouse clicks already supplied a mouseup. Do not replenish a consumed
        // grant when their follow-up click arrives. Keyboard/accessible clicks
        // have detail 0 and may arrive without a preceding mouseup.
        if (name === "click" && (event as MouseEvent).detail !== 0) return;
        gestureAt = now();
      },
      true,
    );
  }
  return () => {
    const trusted = now() - gestureAt < 1000;
    gestureAt = -Infinity;
    return trusted;
  };
}
