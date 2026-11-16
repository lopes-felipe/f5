import type { AnimationEvent } from "react";
import { describe, expect, it } from "vitest";

import { synchronizeStatusPulse } from "./statusPulse";

describe("synchronizeStatusPulse", () => {
  it("pins only the status pulse to the document clock", () => {
    const pulse = { animationName: "status-pulse", startTime: 975 } as unknown as Animation;
    const otherCss = { animationName: "other-animation", startTime: 125 } as unknown as Animation;
    const otherAnimation = { startTime: 250 } as Animation;

    synchronizeStatusPulse({
      animationName: "status-pulse",
      currentTarget: { getAnimations: () => [pulse, otherCss, otherAnimation] },
    } as unknown as AnimationEvent<Element>);

    expect([pulse.startTime, otherCss.startTime, otherAnimation.startTime]).toEqual([0, 125, 250]);
  });

  it("ignores other animations starting", () => {
    const pulse = { animationName: "status-pulse", startTime: 975 } as unknown as Animation;

    synchronizeStatusPulse({
      animationName: "other-animation",
      currentTarget: { getAnimations: () => [pulse] },
    } as unknown as AnimationEvent<Element>);

    expect(pulse.startTime).toBe(975);
  });
});
