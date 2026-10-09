import { describe, expect, it } from "vitest";
import { ThreadId } from "@t3tools/contracts";
import { Effect } from "effect";
import { AgentControlPause } from "./agentControlPause";
import { makePreviewAutomationBroker } from "./PreviewAutomationBroker";
describe("shared agent pause", () => {
  it("shares the desktop latch with preview and publishes each transition once", async () => {
    const pause = new AgentControlPause();
    const preview = makePreviewAutomationBroker({ pause });
    const thread = ThreadId.makeUnsafe("t");
    const changes: boolean[] = [];
    const off = pause.subscribe((_thread, paused) => changes.push(paused));
    try {
      pause.set(thread, true);
      expect(await Effect.runPromise(preview.isPaused(thread))).toBe(true);
      expect(pause.list()).toEqual([thread]);
      await Effect.runPromise(preview.setPaused(thread, true));
      await Effect.runPromise(preview.setPaused(thread, false));
      expect(pause.has(thread)).toBe(false);
      expect(pause.list()).toEqual([]);
      expect(changes).toEqual([true, false]);
    } finally {
      off();
      await Effect.runPromise(preview.shutdown);
    }
  });
});
