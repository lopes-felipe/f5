import type { AnimationEvent } from "react";

/**
 * Pins a newly started status pulse to the document clock, so icons that mount at different
 * times pulse in step. Runs once per animation start; no timer or frame loop.
 */
export function synchronizeStatusPulse(event: AnimationEvent<Element>) {
  if (event.animationName !== "status-pulse") return;

  for (const animation of event.currentTarget.getAnimations()) {
    if ("animationName" in animation && animation.animationName === "status-pulse") {
      animation.startTime = 0;
    }
  }
}
