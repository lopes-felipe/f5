import { afterEach, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";
import type { DesktopKeepAwakeState } from "@t3tools/contracts";
import { useDesktopKeepAwake } from "./useDesktopKeepAwake";

afterEach(() => vi.unstubAllGlobals());
const state = (revision: number): DesktopKeepAwakeState => ({
  revision,
  mode: "off",
  closedLid: false,
  active: false,
  busyThreadCount: 0,
  cooldownUntil: null,
  lid: {
    supported: true,
    permission: "unknown",
    ruleInstalledByF5: false,
    engaged: false,
    sleepDisabled: 0,
    pending: false,
    blockedReason: null,
  },
});
it("subscribes before reading, orders real React updates, refreshes on focus, and cleans up", async () => {
  const order: string[] = [];
  let listener!: (next: DesktopKeepAwakeState) => void;
  let resolve!: (next: DesktopKeepAwakeState) => void;
  const unsubscribe = vi.fn();
  const bridge = {
    onState: (receive: typeof listener) => {
      order.push("subscribe");
      listener = receive;
      return unsubscribe;
    },
    getState: () => {
      order.push("read");
      return new Promise<DesktopKeepAwakeState>((done) => {
        resolve = done;
      });
    },
  };
  vi.stubGlobal("desktopBridge", { keepAwake: bridge });
  function Probe() {
    const { state: current, accept } = useDesktopKeepAwake();
    return (
      <>
        <output role="status">{current?.revision ?? "loading"}</output>
        <button onClick={() => accept(state(1))}>Stale mutation</button>
      </>
    );
  }
  const screen = await render(<Probe />);
  try {
    expect(order).toEqual(["subscribe", "read"]);
    listener(state(2));
    resolve(state(1));
    await expect.element(screen.getByRole("status")).toHaveTextContent("2");
    await screen.getByRole("button").click();
    await expect.element(screen.getByRole("status")).toHaveTextContent("2");
    const beforeFocus = order.length;
    window.dispatchEvent(new Event("focus"));
    resolve(state(3));
    expect(order).toHaveLength(beforeFocus + 1);
    await expect.element(screen.getByRole("status")).toHaveTextContent("3");
  } finally {
    await screen.unmount();
  }
  expect(unsubscribe).toHaveBeenCalledOnce();
  const reads = order.length;
  listener(state(4));
  window.dispatchEvent(new Event("focus"));
  expect(order).toHaveLength(reads);
});
