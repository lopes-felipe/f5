import "../../index.css";
import { afterEach, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";
import { ComposerSendControl } from "./ComposerSendControl";
import {
  noteWsConnectionOpened,
  noteWsConnectionClosed,
  resetWsConnectionStateForTests,
} from "../../wsConnectionState";

afterEach(resetWsConnectionStateForTests);

it("keeps Stop available during resynchronization while Send remains disabled", async () => {
  noteWsConnectionOpened();
  const stop = vi.fn();
  const screen = await render(
    <ComposerSendControl
      unavailable
      running
      hasSendableContent
      dispatchBlocked={false}
      connecting={false}
      busy={false}
      paused={false}
      runnableQueueCount={0}
      itemCount={0}
      maxItems={20}
      serverThread
      onIntent={vi.fn()}
      onInterrupt={stop}
    />,
  );
  try {
    await expect.element(screen.getByRole("button", { name: "Queue", exact: true })).toBeDisabled();
    await screen.getByRole("button", { name: "Stop generation", exact: true }).click();
    expect(stop).toHaveBeenCalledTimes(1);
    noteWsConnectionClosed();
    await expect
      .element(screen.getByRole("button", { name: "Stop generation", exact: true }))
      .toBeDisabled();
  } finally {
    await screen.unmount();
  }
});
