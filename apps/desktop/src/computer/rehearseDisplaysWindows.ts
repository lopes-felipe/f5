import type {
  ComputerAutomationBackendStatus,
  ComputerDisplay,
  ComputerScreenshot,
} from "@t3tools/contracts";
import {
  acceptanceAssert as assert,
  acceptanceWait as wait,
  runWindowsAcceptance,
  type WindowReceipt,
} from "./rehearsalWindowsAcceptance";

export function displayReceiptsMatch(displays: readonly ComputerDisplay[], receipt: WindowReceipt) {
  return (
    displays.length === receipt.displays.length &&
    displays.every((display) =>
      receipt.displays.some(
        (native) =>
          native.displayId === display.displayId &&
          native.rotation === display.rotation &&
          (["x", "y", "width", "height"] as const).every(
            (key) => native.bounds[key] === display.nativeBounds[key],
          ),
      ),
    )
  );
}
if (import.meta.main)
  await runWindowsAcceptance("windows-native-display-transitions", async (s) => {
    const app = await s.fixture("display");
    await s.start();
    s.grant([app.appId]);
    const status = async () => {
      const result = await s.request<ComputerAutomationBackendStatus>({ op: "status" });
      assert(result.available && result.displays?.length, "interactive-display-required");
      return result.displays;
    };
    const initial = await status();
    assert(initial.length >= 2, "multiple-displays-required");
    assert(
      initial.some((d) => d.nativeBounds.x < 0 || d.nativeBounds.y < 0),
      "negative-display-origin-required",
    );
    assert(displayReceiptsMatch(initial, await app.observer.command()), "display-receipt-mismatch");
    s.checks["negative-origins"] = true;
    const dpis = new Set<number>();
    for (const display of initial) {
      assert(
        display.nativeBounds.width >= 650 && display.nativeBounds.height >= 450,
        "display-fixture-does-not-fit",
      );
      const receipt = await app.observer.command(
        "place " +
          Math.round(display.nativeBounds.x + 20) +
          " " +
          Math.round(display.nativeBounds.y + 20),
      );
      dpis.add(receipt.dpi);
      await wait(300);
      const image = await s.request<ComputerScreenshot>({
        op: "screenshot",
        displayId: display.displayId,
        appId: app.appId,
        passwordMasking: "conservative",
      });
      assert((await s.verify(image)).blueVisible, "display-marker-missing");
      assert(
        image.geometryGeneration === display.geometryGeneration &&
          image.modelSize.width === display.modelSize.width &&
          image.modelSize.height === display.modelSize.height,
        "display-capture-geometry-mismatch",
      );
      s.host.overlayWindowIds = [receipt.windowId];
      assert(
        (
          await s.verify(
            await s.request<ComputerScreenshot>({ op: "screenshot", displayId: display.displayId }),
          )
        ).allNeutral,
        "display-overlay-leak",
      );
      s.host.overlayWindowIds = [];
    }
    s.checks["each-display"] = true;
    s.checks["overlay-exclusion"] = true;
    assert(dpis.size >= 2, "mixed-display-dpi-required");
    s.checks["mixed-scale"] = true;
    await app.observer.command("fullscreen");
    await wait(300);
    const fullscreen = await app.observer.command();
    assert(
      fullscreen.displays.some((d) =>
        (["x", "y", "width", "height"] as const).every(
          (key) => fullscreen.bounds[key] === d.bounds[key],
        ),
      ),
      "fullscreen-geometry-mismatch",
    );
    assert(
      (await s.verify(await s.request<ComputerScreenshot>({ op: "screenshot", appId: app.appId })))
        .blueVisible,
      "fullscreen-marker-missing",
    );
    s.checks.fullscreen = true;
    await app.observer.command("restore");
    // Display settings changes are performed by the operator. The driver observes
    // actual native topology, never accepts a typed attestation as evidence.
    process.stdout.write(
      "Watch the fixture. In Windows Display settings rotate one display, then leave the arrangement stable. The driver waits up to 3 minutes.\n",
    );
    async function changed(
      kind: "rotation" | "reconfiguration",
      baseline: readonly ComputerDisplay[],
    ) {
      const until = Date.now() + 180000;
      while (Date.now() < until) {
        const current = await status();
        const changed =
          kind === "rotation"
            ? current.some((d) =>
                baseline.some(
                  (before) => before.displayId === d.displayId && before.rotation !== d.rotation,
                ),
              )
            : current.length !== baseline.length ||
              current.some(
                (d) =>
                  !baseline.some(
                    (before) =>
                      before.displayId === d.displayId &&
                      (["x", "y", "width", "height"] as const).every(
                        (key) => before.nativeBounds[key] === d.nativeBounds[key],
                      ),
                  ),
              );
        if (changed) {
          await wait(1000);
          const stable = await status();
          if (JSON.stringify(stable) !== JSON.stringify(current)) continue;
          assert(
            displayReceiptsMatch(stable, await app.observer.command()),
            "changed-display-receipt-mismatch",
          );
          const display = stable.find((d) => d.primary) ?? stable[0]!;
          await app.observer.command(
            "place " +
              Math.round(display.nativeBounds.x + 20) +
              " " +
              Math.round(display.nativeBounds.y + 20),
          );
          await wait(300);
          assert(
            (
              await s.verify(
                await s.request<ComputerScreenshot>({
                  op: "screenshot",
                  displayId: display.displayId,
                  appId: app.appId,
                }),
              )
            ).blueVisible,
            "changed-display-capture-failed",
          );
          return stable;
        }
        await wait(500);
      }
      throw new Error(kind + "-not-observed");
    }
    const rotated = await changed("rotation", initial);
    s.checks.rotation = true;
    process.stdout.write(
      "Watch the fixture. Change a display resolution or arrangement in Windows Display settings. The driver waits up to 3 minutes.\n",
    );
    await changed("reconfiguration", rotated);
    s.checks.reconfiguration = true;
    process.stdout.write(
      "Test closed. Display checks finished. Restore your preferred display settings.\n",
    );
  });
