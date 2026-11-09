import { describe, expect, it } from "vitest";
import { CodexControlHandoff, waitForControl } from "./CodexControlHandoff";

describe("Codex control transitions", () => {
  it("coalesces adjacent requests and preserves opposing request order after a failure", async () => {
    const coordinator = new CodexControlHandoff();
    const order: string[] = [];
    let finish!: () => void;
    const native = coordinator.run("native", async () => {
      order.push("native");
      await new Promise<void>((resolve) => {
        finish = resolve;
      });
      throw new Error("stop timed out");
    });
    const failed = expect(native).rejects.toThrow("stop timed out");
    expect(
      coordinator.run("native", async () => {
        throw new Error("duplicate");
      }),
    ).toBe(native);
    const browser = coordinator.run("browser", async () => {
      order.push("browser");
    });
    const later = coordinator.run("native", async () => {
      order.push("native again");
    });
    await Promise.resolve();
    await Promise.resolve();
    finish();
    await failed;
    await browser;
    await later;
    expect(order).toEqual(["native", "browser", "native again"]);
    expect(coordinator.transition).toBeUndefined();
  });

  it("never treats a stale lifecycle or expired deadline as successful readiness", async () => {
    await expect(
      waitForControl(
        () => true,
        performance.now() + 100,
        async () => {
          throw new Error("paused");
        },
      ),
    ).rejects.toThrow("paused");
    await expect(
      waitForControl(
        () => true,
        performance.now() - 1,
        async () => {},
      ),
    ).rejects.toThrow("timed out");
  });
});
