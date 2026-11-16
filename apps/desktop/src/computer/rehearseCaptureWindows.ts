import type {
  ComputerDisplay,
  ComputerInspectResult,
  ComputerScreenshot,
} from "@t3tools/contracts";
import { ComputerControlError } from "@t3tools/shared/computerControl";
import { createWindowsProcessFreeze } from "./rehearsalWindowsFreeze";
import {
  acceptanceAssert as assert,
  acceptanceWait as wait,
  expectWindowsRefusal,
  runWindowsAcceptance,
  type NativeRect,
} from "./rehearsalWindowsAcceptance";

/** Map independently observed physical geometry into the delivered image. */
export function captureRect(
  rect: NativeRect,
  display: ComputerDisplay,
  image: ComputerScreenshot,
): NativeRect {
  const source =
    "rect" in image ? (image.rect as NativeRect) : { x: 0, y: 0, ...display.modelSize };
  const scaleX = display.modelSize.width / display.nativeBounds.width;
  const scaleY = display.modelSize.height / display.nativeBounds.height;
  const left =
    (((rect.x - display.nativeBounds.x) * scaleX - source.x) * image.modelSize.width) /
    source.width;
  const top =
    (((rect.y - display.nativeBounds.y) * scaleY - source.y) * image.modelSize.height) /
    source.height;
  const right = left + (rect.width * scaleX * image.modelSize.width) / source.width;
  const bottom = top + (rect.height * scaleY * image.modelSize.height) / source.height;
  return {
    x: Math.ceil(left),
    y: Math.ceil(top),
    width: Math.floor(right) - Math.ceil(left),
    height: Math.floor(bottom) - Math.ceil(top),
  };
}

if (import.meta.main)
  await runWindowsAcceptance("windows-native-capture-privacy", async (s) => {
    const approved = await s.fixture("approved");
    const other = await s.fixture("unapproved", true);
    await s.start();
    const status = s.helper.status();
    assert(status.available && status.displays?.length, "interactive-display-required");
    const display = status.displays.find((d) => d.primary) ?? status.displays[0]!;
    assert(
      display.nativeBounds.width >= 1000 && display.nativeBounds.height >= 500,
      "capture-fixtures-do-not-fit",
    );
    const x = Math.round(display.nativeBounds.x + 10),
      y = Math.round(display.nativeBounds.y + 10);
    await approved.observer.command("place " + x + " " + y);
    await other.observer.command("place " + (x + 470) + " " + (y + 60));
    await wait(300);
    const geometry = await approved.observer.command();
    s.grant([approved.appId, other.appId]);
    const capture = (passwordMasking: "fast" | "conservative", appId?: string) =>
      s.request<ComputerScreenshot>({
        op: "screenshot",
        displayId: display.displayId,
        passwordMasking,
        ...(appId ? { appId } : {}),
      });
    const control = await capture("fast");
    const positive = await s.verify(control);
    assert(positive.blueVisible && positive.greenVisible, "capture-positive-controls-missing");
    s.checks.positiveMarkers = true;
    s.grant([approved.appId]);
    for (const passwordMasking of ["fast", "conservative"] as const) {
      const image = await capture(passwordMasking);
      const pixels = await s.verify(image, [captureRect(geometry.secure, display, image)]);
      assert(
        pixels.blueVisible && pixels.greenAbsent && pixels.secureMasked,
        "capture-pixel-privacy-failed",
      );
      assert(
        image.passwordMasking === passwordMasking && image.masked === "fields",
        "capture-masking-metadata-failed",
      );
      s.checks[passwordMasking + "PixelPrivacy"] = true;
    }
    const tree = await s.request<ComputerInspectResult>({
      op: "inspect",
      appId: approved.appId,
      maxNodes: 800,
    });
    assert(
      !JSON.stringify(tree).includes("F5_SYNTHETIC_PASSWORD_SENTINEL"),
      "secure-inspection-leak",
    );
    s.checks.secureInspection = true;
    const zoomRect = {
      x: Math.max(
        0,
        Math.floor(
          ((geometry.secure.x - display.nativeBounds.x) * display.modelSize.width) /
            display.nativeBounds.width,
        ) - 10,
      ),
      y: Math.max(
        0,
        Math.floor(
          ((geometry.secure.y - display.nativeBounds.y) * display.modelSize.height) /
            display.nativeBounds.height,
        ) - 10,
      ),
      width:
        Math.ceil((geometry.secure.width * display.modelSize.width) / display.nativeBounds.width) +
        20,
      height:
        Math.ceil(
          (geometry.secure.height * display.modelSize.height) / display.nativeBounds.height,
        ) + 20,
    };
    const zoom = await s.request<ComputerScreenshot>({
      op: "zoom",
      displayId: display.displayId,
      rect: zoomRect,
      passwordMasking: "conservative",
    });
    // The zoom response includes the source rect even though the screenshot base type doesn't.
    const zoomPixels = await s.verify(zoom, [captureRect(geometry.secure, display, zoom)]);
    assert(zoomPixels.secureMasked && zoom.mimeType === "image/png", "zoom-masking-failed");
    s.checks.zoomPixelPrivacy = true;
    s.grant([approved.appId, other.appId]);
    const scoped = await s.verify(await capture("fast", approved.appId));
    assert(scoped.blueVisible && scoped.greenAbsent, "scoped-capture-leak");
    s.checks.scopedCapture = true;
    const otherGeometry = await other.observer.command();
    s.host.f5Pids.push(otherGeometry.pid);
    const protectedHost = await s.verify(await capture("fast"));
    assert(protectedHost.blueVisible && protectedHost.greenAbsent, "protected-host-capture-leak");
    s.host.f5Pids.pop();
    s.checks.hostExcluded = true;
    s.host.overlayWindowIds.push(otherGeometry.windowId);
    const protectedOverlay = await s.verify(await capture("conservative"));
    assert(protectedOverlay.blueVisible && protectedOverlay.greenAbsent, "overlay-capture-leak");
    s.host.overlayWindowIds.length = 0;
    s.checks.overlayExcluded = true;
    s.grant([]);
    const revoked = await s.verify(await capture("conservative"));
    assert(revoked.allNeutral, "revoked-capture-leak");
    s.checks.revokedCaptureNeutral = true;
    await expectWindowsRefusal(
      () => s.request({ op: "inspect", appId: approved.appId, maxNodes: 800 }),
      "NotGranted",
    );
    s.checks.revokedInspectionRefused = true;
    for (const withDisplay of [false, true]) {
      await expectWindowsRefusal(
        () =>
          s.request({
            op: "screenshot",
            appId: approved.appId,
            ...(withDisplay ? { displayId: display.displayId } : {}),
          }),
        "NotGranted",
      );
      s.checks[withDisplay ? "revokedScreenshotWithDisplay" : "revokedScreenshotWithoutDisplay"] =
        true;
    }
    await expectWindowsRefusal(
      () =>
        s.request({
          op: "zoom",
          displayId: display.displayId,
          rect: zoomRect,
          appId: approved.appId,
        }),
      "NotGranted",
    );
    s.checks.revokedZoomRefused = true;
    s.checks.revokedObservations = true;
    s.grant([approved.appId]);
    const fresh = await s.request<ComputerInspectResult>({
      op: "inspect",
      appId: approved.appId,
      maxNodes: 800,
    });
    const button = fresh.nodes.find(
      (node) => node.name === "Rehearsal press" && node.actions.includes("press"),
    );
    assert(button, "capture-fixture-button-missing");
    s.arm(4, { kind: "foreground" });
    await s.request({
      op: "elementAction",
      appId: approved.appId,
      snapshotId: fresh.snapshotId,
      elementRef: button.elementRef,
      action: "press",
    });
    const freeze = await createWindowsProcessFreeze(geometry.pid);
    try {
      await freeze.freeze(3000);
      const stopped = await freeze.stopped();
      const observation = freeze.observation();
      if (observation) s.diagnostics.freeze = observation;
      assert(stopped, "capture-fixture-not-suspended");
      const pending = capture("fast", approved.appId).then(
        () => false,
        (error: unknown) =>
          error instanceof ComputerControlError && error.error._tag === "Interrupted",
      );
      await wait(50);
      await s.retire(4);
      assert(await pending, "retired-capture-delivered");
      s.checks.retiredCaptureRefused = true;
    } finally {
      await freeze.resume();
      await freeze.close();
    }
  });
