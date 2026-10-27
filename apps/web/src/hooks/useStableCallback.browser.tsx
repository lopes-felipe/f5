import { describe, expect, it } from "vitest";
import { render } from "vitest-browser-react";
import { useStableCallback } from "./useStableCallback";

describe("useStableCallback", () => {
  it("keeps its identity and invokes the latest committed render", async () => {
    const callbacks: Array<() => string> = [];
    function Probe({ label }: { label: string }) {
      callbacks.push(useStableCallback(() => label));
      return <span>{label}</span>;
    }
    const screen = await render(<Probe label="first" />);
    await screen.rerender(<Probe label="second" />);
    expect(new Set(callbacks).size).toBe(1);
    expect(callbacks[0]!()).toBe("second");
  });
});
